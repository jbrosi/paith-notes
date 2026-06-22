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

import io
import logging
import os
import tempfile
import wave
from threading import Lock
from typing import Dict, Optional

import numpy as np
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
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


# ── routes ──────────────────────────────────────────────────────────────


@app.get("/health")
def health():
    return {
        "ok": True,
        "whisper_model": WHISPER_MODEL_NAME,
        "kokoro_langs": sorted(set(KOKORO_LANG_MAP.values())),
    }


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
        log.info(
            "stt: %.1fs audio -> %d chars lang=%s",
            info.duration,
            len(text),
            info.language,
        )
        return {
            "text": text,
            "language": info.language,
            "duration": info.duration,
        }
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
