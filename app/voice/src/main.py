"""
Voice service for paith-notes.

Two endpoints:
  POST /stt  multipart audio (any format ffmpeg understands) -> {"text": "..."}
  POST /tts  {"text": "...", "lang": "en"}                   -> audio/wav

Engine routing:
  - Whisper (faster-whisper) for STT
  - Kokoro for TTS — English by default, also es/fr/hi/it/ja/pt-br/zh

OpenAI TTS lives MCP-side (VOICE_PROVIDER=openai there). When MCP is
routed to OpenAI this container can simply not be deployed.

Models are loaded lazily on first request so container startup stays fast.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import tempfile
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Lock
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    UploadFile,
)
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("voice")

WHISPER_MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None
# Comma-separated language codes to restrict autodetect to when the
# request doesn't pin a single language. Whisper's autodetect across all
# 99 trained languages is notoriously unreliable on short (~2-3s) VAD
# clips — English speech routinely gets mis-tagged as Arabic. Constraining
# to the languages you actually speak makes the detector reliable even on
# short clips. Empty disables the constraint (full autodetect).
WHISPER_LANGUAGE_CANDIDATES = [
    s.strip().lower()
    for s in os.environ.get("WHISPER_LANGUAGE_CANDIDATES", "en,de").split(",")
    if s.strip()
]
# Optional `initial_prompt` for faster-whisper. Whisper biases its output
# toward tokens it has "seen" in the prompt, so seeding with example
# non-verbal markers nudges the model into emitting `(laughs)`, `(sighs)`,
# `(pause)` etc. instead of silently dropping them. Effect is largest on
# small/medium/large-v3 models — base/tiny lack the capacity to follow
# the bias reliably. Override to "" to disable.
WHISPER_INITIAL_PROMPT = (
    os.environ.get(
        "WHISPER_INITIAL_PROMPT",
        "The speaker may laugh (laughs), sigh (sighs), pause (pause), "
        "clear their throat (clears throat), or speak emphatically.",
    )
    or None
)
KOKORO_MODEL_PATH = os.environ.get(
    "KOKORO_MODEL_PATH", "/app/models/kokoro/kokoro-v1.0.onnx"
)
KOKORO_VOICES_PATH = os.environ.get(
    "KOKORO_VOICES_PATH", "/app/models/kokoro/voices-v1.0.bin"
)
KOKORO_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
# Comma-separated list of engines to eagerly load at startup so the first
# request isn't slow. Empty = lazy-load everything (default).
# Valid values: "kokoro", "whisper". Order doesn't matter.
PRELOAD_MODELS = set(
    filter(None, (s.strip() for s in os.environ.get("PRELOAD_MODELS", "").split(",")))
)
# Optional escape hatch: prepend silence to every TTS response. The proper
# fix for Bluetooth resync gaps is a continuous Web Audio context on the
# frontend (which we use), so this defaults to 0 and only exists as a
# fallback if a client is stuck on plain <audio> elements.
TTS_LEAD_SILENCE_MS = int(os.environ.get("TTS_LEAD_SILENCE_MS", "0"))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "25"))
# Shared bearer secret. When set, /stt + /tts + /tts/stream require
# `Authorization: Bearer <token>` and reject everything else with 401.
# Empty disables auth — fine for the local docker-compose setup where the
# service isn't reachable outside the compose network, but you MUST set
# this before exposing the service on a public URL.
VOICE_TOKEN = (os.environ.get("VOICE_TOKEN") or "").strip()

# ── speaker identification ─────────────────────────────────────────────
# Path to the wespeaker ONNX embedding model — baked into the image at
# build time. /enroll + /identify are no-ops if the model is missing.
SPEAKER_EMBEDDING_MODEL = os.environ.get(
    "SPEAKER_EMBEDDING_MODEL", "/app/models/speaker/wespeaker_en_voxceleb_resnet34_LM.onnx",
)
# Where enrollments are persisted. Lives under /app/data so the existing
# voice_models volume covers it without another mount.
SPEAKER_DB_PATH = os.environ.get(
    "SPEAKER_DB_PATH", "/app/data/speaker_enrollments.json",
)
# Cosine-similarity threshold above which /identify reports a match.
# 0.70 is a family-scale (3-5 enrolled people) sweet spot; tighten to
# 0.75 if you get false matches between similar voices, loosen to 0.65
# if real speakers keep getting tagged null.
SPEAKER_MATCH_THRESHOLD = float(os.environ.get("SPEAKER_MATCH_THRESHOLD", "0.70"))
# Minimum enrollment audio length. wespeaker needs ≥1.5s of voiced
# audio for a usable embedding; we require ≥4s to leave headroom.
SPEAKER_MIN_ENROLL_SECONDS = float(os.environ.get("SPEAKER_MIN_ENROLL_SECONDS", "4.0"))

# Map a short request language code → Kokoro's expected `lang=` parameter.
KOKORO_LANG_MAP: Dict[str, str] = {
    "en": "en-us",
    "en-us": "en-us",
    "en-gb": "en-gb",
    "es": "es",
    "fr": "fr-fr",
    "fr-fr": "fr-fr",
    "hi": "hi",
    "it": "it",
    "ja": "ja",
    "pt": "pt-br",
    "pt-br": "pt-br",
    "zh": "zh",
}


app = FastAPI(title="paith-notes voice")


def require_token(authorization: Optional[str] = Header(default=None)) -> None:
    """Bearer-token check for synth/STT endpoints. /health and /voices stay
    unauthenticated so platform health probes work."""
    if not VOICE_TOKEN:
        return  # auth disabled
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    presented = authorization[len("Bearer "):].strip()
    # Constant-time compare so a leaked timing side-channel can't grind out
    # the token character-by-character. secrets.compare_digest is stdlib.
    import secrets as _secrets
    if not _secrets.compare_digest(presented, VOICE_TOKEN):
        raise HTTPException(401, "invalid bearer token")


@app.on_event("startup")
def _preload_models() -> None:
    """Eagerly load models named in PRELOAD_MODELS so the first request after
    boot isn't slow. Each loader is idempotent and lock-guarded; if a model
    fails to load we log and continue rather than crashing the service."""
    if not PRELOAD_MODELS:
        return
    log.info("preloading %s", sorted(PRELOAD_MODELS))
    loaders = {
        "whisper": get_whisper,
        "kokoro": get_kokoro,
    }
    for name in PRELOAD_MODELS:
        loader = loaders.get(name)
        if loader is None:
            log.warning("PRELOAD_MODELS: unknown engine %r, skipping", name)
            continue
        try:
            loader()
        except Exception as e:
            log.exception("preload of %s failed: %s", name, e)

# ── lazy model loaders ──────────────────────────────────────────────────
_whisper_lock = Lock()
_whisper_model = None  # type: ignore[var-annotated]
_kokoro_lock = Lock()
_kokoro = None  # type: ignore[var-annotated]


def get_whisper():
    """Load faster-whisper on first use. Lock guards against two concurrent
    first-requests both trying to download the model."""
    global _whisper_model
    if _whisper_model is None:
        with _whisper_lock:
            if _whisper_model is None:
                from faster_whisper import WhisperModel

                log.info(
                    "loading whisper model=%s device=%s compute=%s",
                    WHISPER_MODEL_NAME,
                    WHISPER_DEVICE,
                    WHISPER_COMPUTE,
                )
                _whisper_model = WhisperModel(
                    WHISPER_MODEL_NAME,
                    device=WHISPER_DEVICE,
                    compute_type=WHISPER_COMPUTE,
                )
                log.info("whisper loaded")
    return _whisper_model


def get_kokoro():
    global _kokoro
    if _kokoro is None:
        with _kokoro_lock:
            if _kokoro is None:
                from kokoro_onnx import Kokoro

                log.info(
                    "loading kokoro model=%s voices=%s",
                    KOKORO_MODEL_PATH,
                    KOKORO_VOICES_PATH,
                )
                if not os.path.exists(KOKORO_MODEL_PATH):
                    raise RuntimeError(
                        f"Kokoro model not found at {KOKORO_MODEL_PATH}"
                    )
                if not os.path.exists(KOKORO_VOICES_PATH):
                    raise RuntimeError(
                        f"Kokoro voices not found at {KOKORO_VOICES_PATH}"
                    )
                _kokoro = Kokoro(KOKORO_MODEL_PATH, KOKORO_VOICES_PATH)
                log.info("kokoro loaded")
    return _kokoro


# ── speaker identification ─────────────────────────────────────────────
# Lazy-loaded wespeaker embedding extractor. ~25MB model loaded into
# sherpa-onnx (which uses onnxruntime under the hood — same runtime as
# kokoro). 192-dim embedding output.
_speaker_lock = Lock()
_speaker_extractor = None  # type: ignore[var-annotated]


def get_speaker_extractor():
    """Load the speaker embedding extractor on first use. Returns None if
    the bundled model file is missing — callers check this and skip
    speaker ID rather than failing the whole request."""
    global _speaker_extractor
    if _speaker_extractor is not None:
        return _speaker_extractor
    with _speaker_lock:
        if _speaker_extractor is not None:
            return _speaker_extractor
        if not os.path.exists(SPEAKER_EMBEDDING_MODEL):
            log.warning(
                "speaker model not at %s — /enroll and /identify will be no-ops",
                SPEAKER_EMBEDDING_MODEL,
            )
            return None
        import sherpa_onnx

        log.info("loading speaker embedding model %s", SPEAKER_EMBEDDING_MODEL)
        config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=SPEAKER_EMBEDDING_MODEL,
            num_threads=1,
            debug=False,
            provider="cpu",
        )
        _speaker_extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
        log.info("speaker model ready: dim=%d", _speaker_extractor.dim)
    return _speaker_extractor


@dataclass
class _Enrollment:
    name: str
    embedding: np.ndarray  # unit-length float32, shape (dim,)
    enrolled_at: str
    samples: int


_speaker_db_lock = Lock()
_speaker_db: Dict[str, _Enrollment] = {}


def _load_speaker_db() -> None:
    """Populate _speaker_db from SPEAKER_DB_PATH. Called at startup and
    after every mutation. Logs + ignores a corrupted file rather than
    crashing — better to lose enrollments than to wedge the service."""
    global _speaker_db
    if not os.path.exists(SPEAKER_DB_PATH):
        _speaker_db = {}
        return
    try:
        with open(SPEAKER_DB_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        out: Dict[str, _Enrollment] = {}
        for row in raw:
            out[row["name"]] = _Enrollment(
                name=row["name"],
                embedding=np.asarray(row["embedding"], dtype=np.float32),
                enrolled_at=row.get("enrolled_at", ""),
                samples=int(row.get("samples", 1)),
            )
        _speaker_db = out
        log.info("loaded %d speaker enrollment(s) from %s", len(_speaker_db), SPEAKER_DB_PATH)
    except Exception as e:
        log.exception("failed to load %s: %s — starting empty", SPEAKER_DB_PATH, e)
        _speaker_db = {}


def _save_speaker_db() -> None:
    os.makedirs(os.path.dirname(SPEAKER_DB_PATH), exist_ok=True)
    rows = [
        {
            "name": e.name,
            "embedding": e.embedding.astype(float).tolist(),
            "enrolled_at": e.enrolled_at,
            "samples": e.samples,
        }
        for e in _speaker_db.values()
    ]
    tmp = SPEAKER_DB_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rows, f)
    os.replace(tmp, SPEAKER_DB_PATH)


_load_speaker_db()


def _decode_wav_to_pcm16k(tmp_path: str) -> Tuple[np.ndarray, int]:
    """Decode any audio file to 16kHz mono float32 in [-1, 1] using
    soundfile, with ffmpeg as a transcode-then-read fallback for
    formats soundfile doesn't natively handle (webm/opus etc)."""
    import soundfile as sf

    try:
        data, sr = sf.read(tmp_path, dtype="float32", always_2d=False)
    except Exception:
        # ffmpeg transcode → temp WAV, then read.
        import subprocess

        out_path = tmp_path + ".wav"
        subprocess.run(
            ["ffmpeg", "-y", "-i", tmp_path, "-ar", "16000", "-ac", "1",
             "-loglevel", "error", out_path],
            check=True,
        )
        data, sr = sf.read(out_path, dtype="float32", always_2d=False)
        try:
            os.unlink(out_path)
        except OSError:
            pass
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != 16000:
        # Cheap linear resample — speaker models are robust to it. For
        # higher quality we'd pull in scipy.signal.resample_poly, but
        # the size cost isn't worth it for the embedding's purposes.
        ratio = 16000 / sr
        n = int(len(data) * ratio)
        xs = np.linspace(0, len(data) - 1, n, dtype=np.float32)
        idx_lo = np.floor(xs).astype(np.int32)
        idx_hi = np.minimum(idx_lo + 1, len(data) - 1)
        frac = (xs - idx_lo).astype(np.float32)
        data = (data[idx_lo] * (1 - frac) + data[idx_hi] * frac).astype(np.float32)
        sr = 16000
    return data, sr


def _embed_audio(samples_16k: np.ndarray) -> Optional[np.ndarray]:
    """Compute the unit-length voiceprint for 16kHz mono float32 audio.
    Returns None if the model isn't available."""
    extractor = get_speaker_extractor()
    if extractor is None:
        return None
    stream = extractor.create_stream()
    stream.accept_waveform(sample_rate=16000, waveform=samples_16k)
    stream.input_finished()
    emb = np.asarray(extractor.compute(stream), dtype=np.float32)
    norm = float(np.linalg.norm(emb)) + 1e-9
    return emb / norm


def _identify_from_samples(samples_16k: np.ndarray) -> Optional[Dict[str, Any]]:
    """Run identification against the enrolled set. Returns None if
    speaker ID isn't available (model missing); returns a dict with
    `speaker` = None if no one is enrolled or no match clears the
    threshold."""
    if not _speaker_db:
        return {"speaker": None, "confidence": 0.0}
    emb = _embed_audio(samples_16k)
    if emb is None:
        return None
    scored: List[Tuple[str, float]] = []
    with _speaker_db_lock:
        for e in _speaker_db.values():
            score = float(np.dot(emb, e.embedding))
            scored.append((e.name, score))
    scored.sort(key=lambda kv: kv[1], reverse=True)
    best_name, best_score = scored[0]
    matched = best_score >= SPEAKER_MATCH_THRESHOLD
    return {
        "speaker": best_name if matched else None,
        "confidence": round(best_score, 4),
    }


# ── routes ──────────────────────────────────────────────────────────────


@app.get("/health")
def health():
    return {
        "ok": True,
        "whisper_model": WHISPER_MODEL_NAME,
        "kokoro_langs": sorted(set(KOKORO_LANG_MAP.values())),
        "speaker_enrolled": len(_speaker_db),
        "speaker_model": os.path.exists(SPEAKER_EMBEDDING_MODEL),
    }


# ── speaker enrollment endpoints ───────────────────────────────────────


@app.get("/enrollments")
def list_enrollments(_auth: None = Depends(require_token)):
    """Names + metadata of enrolled speakers. Embeddings deliberately
    NOT exposed — they're voice biometrics and the UI has no use case
    for them."""
    return {
        "enrollments": [
            {"name": e.name, "enrolled_at": e.enrolled_at, "samples": e.samples}
            for e in sorted(_speaker_db.values(), key=lambda x: x.name.lower())
        ],
    }


@app.post("/enroll")
async def enroll_speaker(
    audio: UploadFile = File(...),
    name: str = Form(...),
    replace: bool = Form(False),
    _auth: None = Depends(require_token),
):
    """Enroll (or refine) a speaker. The audio should be a single speaker
    talking naturally for ≥4s. Re-enrolling without `replace=true`
    accumulates a running-mean embedding which generally improves
    accuracy. `replace=true` discards the previous voiceprint."""
    clean_name = name.strip()
    if not clean_name:
        raise HTTPException(400, "name must be non-empty")
    if len(clean_name) > 80:
        raise HTTPException(400, "name too long (>80 chars)")

    data = await audio.read()
    if not data:
        raise HTTPException(400, "empty audio upload")
    size_mb = len(data) / (1024 * 1024)
    if size_mb > MAX_UPLOAD_MB:
        raise HTTPException(413, f"audio too large: {size_mb:.1f}MB > {MAX_UPLOAD_MB}MB")

    suffix = _ext_for_content_type(audio.content_type)
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        samples, _sr = _decode_wav_to_pcm16k(tmp_path)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    duration_s = len(samples) / 16000.0
    if duration_s < SPEAKER_MIN_ENROLL_SECONDS:
        raise HTTPException(
            400,
            f"audio too short: {duration_s:.1f}s (need ≥{SPEAKER_MIN_ENROLL_SECONDS:.1f}s)",
        )

    emb = _embed_audio(samples)
    if emb is None:
        raise HTTPException(503, "speaker model not loaded")

    with _speaker_db_lock:
        existing = _speaker_db.get(clean_name)
        if existing and not replace:
            n = existing.samples
            merged = (existing.embedding * n + emb) / (n + 1)
            merged /= float(np.linalg.norm(merged)) + 1e-9
            _speaker_db[clean_name] = _Enrollment(
                name=clean_name,
                embedding=merged.astype(np.float32),
                enrolled_at=existing.enrolled_at,
                samples=n + 1,
            )
            samples_count = n + 1
        else:
            _speaker_db[clean_name] = _Enrollment(
                name=clean_name,
                embedding=emb,
                enrolled_at=datetime.now(timezone.utc).isoformat(),
                samples=1,
            )
            samples_count = 1
        _save_speaker_db()

    log.info(
        "enroll: name=%s duration=%.1fs samples=%d total=%d",
        clean_name, duration_s, samples_count, len(_speaker_db),
    )
    return {"ok": True, "name": clean_name, "samples": samples_count, "duration_s": duration_s}


@app.delete("/enroll/{name}")
def delete_enrollment(name: str, _auth: None = Depends(require_token)):
    with _speaker_db_lock:
        if name not in _speaker_db:
            raise HTTPException(404, f"no enrollment for {name!r}")
        del _speaker_db[name]
        _save_speaker_db()
    log.info("delete: name=%s total=%d", name, len(_speaker_db))
    return {"ok": True, "name": name}


@app.post("/identify")
async def identify_speaker(
    audio: UploadFile = File(...),
    _auth: None = Depends(require_token),
):
    """Identify the speaker in `audio` against the enrolled set. Empty
    enrollment table is the privacy default — always returns
    {speaker: null}."""
    data = await audio.read()
    if not data:
        raise HTTPException(400, "empty audio upload")

    suffix = _ext_for_content_type(audio.content_type)
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        samples, _sr = _decode_wav_to_pcm16k(tmp_path)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    result = _identify_from_samples(samples)
    if result is None:
        return {"speaker": None, "confidence": 0.0, "note": "speaker model unavailable"}
    return result


@app.get("/voices")
def voices():
    """List every language the service can currently handle, plus the engine
    and the specific voice that will be used. Useful as a debugging aid and
    as a feed for any UI that wants to offer a language picker."""
    out = []
    for short, kokoro_lang in sorted(KOKORO_LANG_MAP.items()):
        out.append(
            {"lang": short, "engine": "kokoro", "voice": KOKORO_VOICE, "kokoro_lang": kokoro_lang}
        )
    return {"voices": out}


@app.post("/stt")
async def stt(
    audio: UploadFile = File(...),
    language: Optional[str] = None,
    _auth: None = Depends(require_token),
):
    """Transcribe an uploaded audio clip. Accepts any format ffmpeg can decode
    (browsers typically send webm/opus from MediaRecorder)."""
    data = await audio.read()
    size_mb = len(data) / (1024 * 1024)
    if size_mb > MAX_UPLOAD_MB:
        raise HTTPException(
            413, f"audio too large: {size_mb:.1f}MB > {MAX_UPLOAD_MB}MB"
        )
    if not data:
        raise HTTPException(400, "empty audio upload")

    # faster-whisper accepts a file path (decoded via PyAV/ffmpeg). Writing
    # to a tempfile is simpler than wiring an in-memory pipeline.
    suffix = _ext_for_content_type(audio.content_type)
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name

    try:
        model = get_whisper()

        def _run_whisper() -> Dict[str, Any]:
            # vad_filter is off because the frontend already runs Silero VAD
            # (via @ricky0123/vad-web) before upload. Running another VAD pass
            # here chips additional audio off both ends of an already tight
            # clip — short clips made Whisper's language autodetect misfire
            # (commonly to Arabic) on English speech.
            forced_lang = (language or WHISPER_LANGUAGE or "").strip().lower() or None
            if forced_lang is None and WHISPER_LANGUAGE_CANDIDATES:
                forced_lang = _pick_lang_from_candidates(model, tmp_path)
            segments, info = model.transcribe(
                tmp_path,
                language=forced_lang,
                vad_filter=False,
                beam_size=1,  # greedy — much faster, fine for short utterances
                initial_prompt=WHISPER_INITIAL_PROMPT,
            )
            text = "".join(seg.text for seg in segments).strip()
            return {"text": text, "language": info.language, "duration": info.duration}

        def _run_speaker() -> Optional[Dict[str, Any]]:
            # Skip work entirely when no one's enrolled — the privacy
            # default. Also skipped if the embedding model file is
            # missing (e.g. during a partial build).
            if not _speaker_db or get_speaker_extractor() is None:
                return None
            try:
                pcm, _ = _decode_wav_to_pcm16k(tmp_path)
                return _identify_from_samples(pcm)
            except Exception as e:
                log.warning("speaker identify failed: %s", e)
                return None

        # Run whisper + speaker concurrently in the threadpool. They
        # both block on CPU work; gather() returns once the slower one
        # finishes (~max instead of sum).
        whisper_result, speaker_result = await asyncio.gather(
            asyncio.to_thread(_run_whisper),
            asyncio.to_thread(_run_speaker),
        )

        out: Dict[str, Any] = dict(whisper_result)
        if speaker_result is not None:
            out["speaker"] = speaker_result.get("speaker")
            out["speaker_confidence"] = speaker_result.get("confidence")
        log.info(
            "stt: %.1fs audio -> %d chars lang=%s speaker=%s",
            out["duration"],
            len(out["text"]),
            out["language"],
            out.get("speaker"),
        )
        return out
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


class TtsRequest(BaseModel):
    text: str
    speed: float = 1.0  # 0.5–2.0 typical
    lang: str = "en"  # short code; must be in KOKORO_LANG_MAP
    voice: Optional[str] = None  # kokoro voice id (defaults to KOKORO_VOICE)


@app.post("/tts")
def tts(req: TtsRequest, _auth: None = Depends(require_token)):
    """Synthesize speech. Returns audio/wav (16-bit PCM mono)."""
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text must be non-empty")
    if len(text) > 4000:
        raise HTTPException(413, f"text too long: {len(text)} chars (max 4000)")

    lang = (req.lang or "en").lower()
    speed = max(0.5, min(req.speed, 2.0))
    if lang not in KOKORO_LANG_MAP:
        raise HTTPException(
            400,
            f"unsupported lang={lang!r}. Known: {sorted(KOKORO_LANG_MAP)}",
        )
    kokoro_lang = KOKORO_LANG_MAP[lang]
    samples, sample_rate, voice_used = _synth_kokoro(
        text, kokoro_lang, speed, req.voice
    )

    if TTS_LEAD_SILENCE_MS > 0:
        n_silence = int(sample_rate * TTS_LEAD_SILENCE_MS / 1000)
        samples = np.concatenate(
            [np.zeros(n_silence, dtype=samples.dtype), samples]
        )

    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(int(sample_rate))
        wav.writeframes(pcm)
    audio_bytes = buf.getvalue()
    log.info(
        "tts: %d chars lang=%s voice=%s -> %d bytes wav",
        len(text),
        lang,
        voice_used,
        len(audio_bytes),
    )
    return Response(
        content=audio_bytes,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/tts/stream")
async def tts_stream(req: TtsRequest, _auth: None = Depends(require_token)):
    """Streaming variant of /tts. Returns application/octet-stream where the
    body is a sequence of length-prefixed (uint32 BE) mini-WAV chunks.

    Kokoro emits chunks *as the model produces them*, so the client gets
    first audio in a few hundred ms instead of waiting for the whole
    sentence."""
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text must be non-empty")
    if len(text) > 4000:
        raise HTTPException(413, f"text too long: {len(text)} chars (max 4000)")
    lang = (req.lang or "en").lower()
    speed = max(0.5, min(req.speed, 2.0))
    if lang not in KOKORO_LANG_MAP:
        raise HTTPException(
            400,
            f"unsupported lang={lang!r}. Known: {sorted(KOKORO_LANG_MAP)}",
        )
    kokoro_lang = KOKORO_LANG_MAP[lang]

    import time as _time

    async def gen():
        t0 = _time.monotonic()
        chunk_idx = 0
        total_samples = 0
        kokoro = get_kokoro()
        voice = req.voice or KOKORO_VOICE
        log.info(
            "tts/stream start lang=%s voice=%s chars=%d",
            lang, voice, len(text),
        )
        last_sr = 24000
        async for samples, sample_rate in kokoro.create_stream(
            text, voice=voice, speed=speed, lang=kokoro_lang
        ):
            chunk_idx += 1
            total_samples += int(samples.size)
            last_sr = int(sample_rate)
            dur_ms = int(samples.size * 1000 / max(1, sample_rate))
            elapsed_ms = int((_time.monotonic() - t0) * 1000)
            log.info(
                "tts/stream chunk #%d dur=%dms elapsed=%dms total_audio_ms=%d",
                chunk_idx, dur_ms, elapsed_ms,
                int(total_samples * 1000 / max(1, sample_rate)),
            )
            yield _encode_chunk(samples, int(sample_rate))
        # Kokoro generates flush enough that consecutive sentences would
        # otherwise butt up against each other. ~220ms of trailing silence
        # gives a natural inter-sentence beat without sounding paused.
        yield _encode_chunk(np.zeros(int(last_sr * 0.22), dtype=np.float32), last_sr)
        log.info(
            "tts/stream done chunks=%d total_ms=%d",
            chunk_idx, int((_time.monotonic() - t0) * 1000),
        )

    return StreamingResponse(gen(), media_type="application/octet-stream")


def _encode_chunk(samples: np.ndarray, sample_rate: int) -> bytes:
    """Encode one slice of float32 samples as length-prefixed WAV bytes for
    the /tts/stream wire format. The 4-byte big-endian length lets the
    client (MCP) carve chunks out of the byte stream without parsing WAV."""
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    wav_bytes = buf.getvalue()
    return len(wav_bytes).to_bytes(4, "big") + wav_bytes


def _pick_lang_from_candidates(model, audio_path: str) -> Optional[str]:
    """Run Whisper's language detector and return the highest-scoring
    candidate from WHISPER_LANGUAGE_CANDIDATES. detect_language only runs
    the encoder + lang head (cheap vs full transcribe); we average the
    per-segment probability dicts so a single noisy first segment can't
    skew the call. Returns None on failure so the caller can fall back to
    full autodetect."""
    try:
        from faster_whisper.audio import decode_audio

        audio_array = decode_audio(audio_path, sampling_rate=16000)
        _, _, per_seg_probs = model.detect_language(audio_array)
        if not per_seg_probs:
            return None
        scores: Dict[str, float] = {c: 0.0 for c in WHISPER_LANGUAGE_CANDIDATES}
        for probs in per_seg_probs:
            for c in scores:
                scores[c] += probs.get(c, 0.0)
        best = max(scores, key=scores.get)
        log.info(
            "constrained autodetect: picked %s from %s (scores=%s)",
            best,
            WHISPER_LANGUAGE_CANDIDATES,
            {k: round(v, 3) for k, v in scores.items()},
        )
        return best
    except Exception as e:
        log.warning(
            "constrained autodetect failed (%s); falling back to full autodetect",
            e,
        )
        return None


def _synth_kokoro(text: str, kokoro_lang: str, speed: float, voice: Optional[str]):
    kokoro = get_kokoro()
    voice_used = voice or KOKORO_VOICE
    # Kokoro returns float32 samples in [-1, 1] + the model sample rate (24kHz).
    samples, sample_rate = kokoro.create(
        text, voice=voice_used, speed=speed, lang=kokoro_lang
    )
    return samples, sample_rate, voice_used


# ── helpers ─────────────────────────────────────────────────────────────


def _ext_for_content_type(ct: Optional[str]) -> str:
    """Pick a tempfile extension so PyAV's container probe has a hint. PyAV
    can still sniff most formats from content alone, but giving it the right
    extension avoids one class of decode failures."""
    if not ct:
        return ".bin"
    if "webm" in ct:
        return ".webm"
    if "ogg" in ct:
        return ".ogg"
    if "mp4" in ct or "m4a" in ct:
        return ".m4a"
    if "wav" in ct:
        return ".wav"
    if "mpeg" in ct or "mp3" in ct:
        return ".mp3"
    return ".bin"
