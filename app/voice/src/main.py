"""
Voice service for paith-notes.

Two endpoints:
  POST /stt  multipart audio (any format ffmpeg understands) -> {"text": "..."}
  POST /tts  {"text": "...", "lang": "en"}                   -> audio/wav

Engine routing by language:
  - Kokoro (high quality, English by default — also es/fr/hi/it/ja/pt-br/zh)
  - Piper  (German + everything Kokoro doesn't cover; auto-downloaded on
            first use from rhasspy/piper-voices on HuggingFace)

Models are loaded lazily on first request so container startup stays fast.
"""

from __future__ import annotations

import io
import json
import logging
import os
import tempfile
import urllib.request
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
KOKORO_MODEL_PATH = os.environ.get(
    "KOKORO_MODEL_PATH", "/app/models/kokoro/kokoro-v1.0.onnx"
)
KOKORO_VOICES_PATH = os.environ.get(
    "KOKORO_VOICES_PATH", "/app/models/kokoro/voices-v1.0.bin"
)
KOKORO_VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
PIPER_VOICES_DIR = os.environ.get("PIPER_VOICES_DIR", "/app/models/piper")
# Chatterbox Multilingual (Resemble AI, MIT) — high quality + voice cloning.
# Default exaggeration controls how expressive the delivery is (0.0 = flat,
# 1.5+ = very dramatic). 0.5 sits around natural human speech.
# Both knobs kept in Chatterbox's "comfortable" zone. cfg<0.2 plus
# exaggeration>0.6 is outside what the model was tuned for and produces
# warbly / over-emphasized output. cfg=0.3 + exaggeration=0.5 is Resemble's
# "slightly slower than default" preset.
CHATTERBOX_EXAGGERATION = float(os.environ.get("CHATTERBOX_EXAGGERATION", "0.5"))
CHATTERBOX_CFG = float(os.environ.get("CHATTERBOX_CFG_WEIGHT", "0.3"))
# Comma-separated short lang codes routed to Chatterbox instead of the
# default engine. German by default — Piper sounds rough, Kokoro can't.
CHATTERBOX_LANGS = set(
    filter(None, os.environ.get("CHATTERBOX_LANGS", "de").split(","))
)
# Path to a 6–10s reference WAV used as the default voice for Chatterbox.
# The default looks for a clip you've dropped into the bind-mounted voices
# directory; if it's missing, fall back to Chatterbox's built-in
# conditioning (sounds male). Synthetic references — e.g. Piper output —
# break Chatterbox's mel→token encoder, so use real human-voice clips.
CHATTERBOX_VOICE_PATH = (
    os.environ.get("CHATTERBOX_VOICE_PATH", "/app/voices/default.wav") or None
)
# F5-TTS (SWivid, MIT) — flow-matching, English-trained. Stable prosody,
# zero-shot voice cloning. Requires the EXACT transcript of the reference
# WAV alongside it: drop /app/voices/f5_default.wav + .txt to override.
# Defaults to the model's bundled reference so it works out of the box.
F5_MODEL = os.environ.get("F5_MODEL", "F5TTS_v1_Base")
F5_VOICE_PATH = os.environ.get("F5_VOICE_PATH", "/app/voices/f5_default.wav") or None
F5_VOICE_TEXT_PATH = (
    os.environ.get("F5_VOICE_TEXT_PATH", "/app/voices/f5_default.txt") or None
)

# Per-lang F5 model configurations. English uses the bundled F5_MODEL above.
# For German, point F5_DE_CKPT_PATH at a community checkpoint (e.g.
# `huggingface-cli download aihpi/F5-TTS-German --local-dir /app/models/f5_de`,
# then set F5_DE_CKPT_PATH + F5_DE_VOCAB_PATH to the downloaded files).
# When F5_DE_CKPT_PATH is empty, requests for German fall back to the English
# model — usable for a quick smoke test but the prosody/accent will be off.
F5_DE_MODEL_ARCH = os.environ.get("F5_DE_MODEL_ARCH", "F5TTS_Base")
F5_DE_CKPT_PATH = os.environ.get("F5_DE_CKPT_PATH", "") or ""
F5_DE_VOCAB_PATH = os.environ.get("F5_DE_VOCAB_PATH", "") or ""
F5_DE_VOICE_PATH = (
    os.environ.get("F5_DE_VOICE_PATH", "/app/voices/f5_de_default.wav") or None
)
F5_DE_VOICE_TEXT_PATH = (
    os.environ.get("F5_DE_VOICE_TEXT_PATH", "/app/voices/f5_de_default.txt") or None
)
# Flow-matching steps per synthesis. Default in F5 is 32; quality stays good
# down to ~16 on English and degrades audibly below 8. Half the steps ≈
# half the wall-clock.
F5_NFE_STEP = int(os.environ.get("F5_NFE_STEP", "16"))
# Classifier-free guidance strength. Default 2.0 runs the model twice per
# step (cond + uncond) and blends; 1.0 skips the uncond pass for ~2x speed
# at little quality cost on calm reference clips.
F5_CFG_STRENGTH = float(os.environ.get("F5_CFG_STRENGTH", "1.0"))
# Comma-separated short lang codes routed to F5 instead of the default engine.
# Empty by default (F5 is opt-in via the explicit `engine` override) — flip
# on once you've validated quality for your reference clip.
F5_LANGS = set(
    filter(None, os.environ.get("F5_LANGS", "").split(","))
)
# Comma-separated list of engines to eagerly load at startup so the first
# request isn't slow. Empty = lazy-load everything (default).
# Valid values: "kokoro", "chatterbox", "f5", "whisper". Order doesn't matter.
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
# this before exposing the service on a public URL (e.g. a RunPod pod).
VOICE_TOKEN = (os.environ.get("VOICE_TOKEN") or "").strip()

# Map a short request language code → Kokoro's expected `lang=` parameter.
# Anything not in this map falls through to the Piper path.
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

# Map a short request language code → Piper voice ID. Overridable via the
# PIPER_VOICES env var (JSON object) so adding a language doesn't require a
# code change. Voices not on disk get auto-downloaded on first use.
DEFAULT_PIPER_VOICES: Dict[str, str] = {
    "de": "de_DE-thorsten-medium",
    "fr": "fr_FR-siwis-medium",
    "es": "es_ES-davefx-medium",
    "it": "it_IT-paola-medium",
    "nl": "nl_NL-mls_5809-low",
    "pl": "pl_PL-darkman-medium",
    "pt": "pt_BR-faber-medium",
    "ru": "ru_RU-ruslan-medium",
    "sv": "sv_SE-nst-medium",
    "tr": "tr_TR-fahrettin-medium",
    "uk": "uk_UA-ukrainian_tts-medium",
}


def _load_piper_voice_map() -> Dict[str, str]:
    raw = os.environ.get("PIPER_VOICES")
    if not raw:
        return dict(DEFAULT_PIPER_VOICES)
    try:
        override = json.loads(raw)
    except json.JSONDecodeError as e:
        log.warning("PIPER_VOICES is not valid JSON, ignoring: %s", e)
        return dict(DEFAULT_PIPER_VOICES)
    if not isinstance(override, dict):
        log.warning("PIPER_VOICES must be a JSON object, ignoring")
        return dict(DEFAULT_PIPER_VOICES)
    merged = dict(DEFAULT_PIPER_VOICES)
    merged.update({str(k): str(v) for k, v in override.items()})
    return merged


PIPER_VOICES: Dict[str, str] = _load_piper_voice_map()

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
        "chatterbox": get_chatterbox,
        # English F5 only. German weights load on first DE request — they're
        # opt-in via F5_DE_CKPT_PATH and we don't want to slow boot for a
        # config that may not be set.
        "f5": lambda: get_f5("en"),
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
_piper_lock = Lock()
_piper_voices: Dict[str, object] = {}
_piper_download_lock = Lock()
_chatterbox_lock = Lock()
_chatterbox = None  # type: ignore[var-annotated]
# Separate lock around model.generate(). Chatterbox attaches per-call
# forward hooks onto the underlying Llama layers and overwrites
# patched_model.alignment_stream_analyzer per call — concurrent generate()s
# corrupt each other's analyzer state (and KV cache). Frontend fires
# sentence requests in parallel, so we serialize at the model level.
_chatterbox_gen_lock = Lock()
_f5_lock = Lock()
_f5_instances: Dict[str, object] = {}
# F5 also touches global model state during infer() — serialize like Chatterbox.
_f5_gen_lock = Lock()


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


def _piper_voice_url(voice_id: str) -> str:
    """Derive the rhasspy/piper-voices HF URL from a voice ID like
    `de_DE-thorsten-medium`. The pattern is:
      {lang_short}/{lang_full}/{speaker}/{quality}/{voice_id}.onnx
    Speaker may contain underscores; quality is always the trailing token."""
    try:
        lang_full, rest = voice_id.split("-", 1)
        speaker, quality = rest.rsplit("-", 1)
    except ValueError as e:
        raise ValueError(f"unrecognized piper voice id: {voice_id}") from e
    lang_short = lang_full.split("_")[0]
    base = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
    return f"{base}/{lang_short}/{lang_full}/{speaker}/{quality}/{voice_id}"


def _ensure_piper_voice_files(voice_id: str) -> tuple[str, str]:
    """Return (onnx_path, json_path) for a Piper voice, downloading both
    files into PIPER_VOICES_DIR if not already present."""
    onnx_path = os.path.join(PIPER_VOICES_DIR, f"{voice_id}.onnx")
    json_path = onnx_path + ".json"
    if os.path.exists(onnx_path) and os.path.exists(json_path):
        return onnx_path, json_path
    with _piper_download_lock:
        # re-check after acquiring the lock
        if os.path.exists(onnx_path) and os.path.exists(json_path):
            return onnx_path, json_path
        os.makedirs(PIPER_VOICES_DIR, exist_ok=True)
        url_base = _piper_voice_url(voice_id)
        log.info("downloading piper voice %s", voice_id)
        for suffix, dest in (("onnx", onnx_path), ("onnx.json", json_path)):
            tmp = dest + ".part"
            try:
                with urllib.request.urlopen(f"{url_base}.{suffix}", timeout=120) as r:
                    with open(tmp, "wb") as f:
                        f.write(r.read())
                os.replace(tmp, dest)
            except Exception:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        log.info("piper voice %s ready", voice_id)
    return onnx_path, json_path


def get_chatterbox():
    """Load Chatterbox Multilingual on first use. ~1.5GB downloads from
    HuggingFace into HF_HOME on first call; persists via the docker volume.

    Chatterbox's `from_local` calls `torch.load(...)` without map_location,
    so checkpoints saved with CUDA tags fail to deserialize on a CPU-only
    box even when we pass `device="cpu"`. Patch torch.load globally to
    default to CPU when CUDA is unavailable — safe because nothing else in
    this service needs CUDA-resident tensors."""
    global _chatterbox
    if _chatterbox is None:
        with _chatterbox_lock:
            if _chatterbox is None:
                import torch

                if not torch.cuda.is_available() and not getattr(
                    torch.load, "_voice_cpu_patched", False
                ):
                    _orig_torch_load = torch.load

                    def _torch_load_cpu(*args, **kwargs):
                        kwargs.setdefault("map_location", torch.device("cpu"))
                        return _orig_torch_load(*args, **kwargs)

                    _torch_load_cpu._voice_cpu_patched = True  # type: ignore[attr-defined]
                    torch.load = _torch_load_cpu  # type: ignore[assignment]

                from chatterbox.mtl_tts import ChatterboxMultilingualTTS

                # The alignment analyzer has two jobs: suppress EOS while text
                # isn't fully spoken yet, and *force* EOS when it detects
                # repetition / long tail / babble. Without it the model
                # meanders for hundreds of steps after the sentence ends —
                # "live brain surgery" audio. The analyzer occasionally
                # crashes on shape mismatches (transformers SDPA-fallback
                # quirks). Wrap step() in try/except so a glitch costs one
                # step of analysis rather than the whole guardrail.
                from chatterbox.models.t3.inference import (
                    alignment_stream_analyzer as _asa,
                )

                _orig_asa_step = _asa.AlignmentStreamAnalyzer.step

                def _safe_step(self, logits, next_token):  # type: ignore[no-untyped-def]
                    try:
                        return _orig_asa_step(self, logits, next_token=next_token)
                    except (RuntimeError, IndexError) as e:
                        # Known failure modes: torch.stack shape mismatch,
                        # torch.cat shape mismatch, empty-slice IndexError
                        # when a misshaped reference produces zero-length
                        # alignment chunks. Falling back to vanilla logits
                        # keeps generation alive — natural EOS still fires.
                        if isinstance(e, RuntimeError):
                            msg = str(e)
                            if not (
                                "stack expects each tensor to be equal size" in msg
                                or "Sizes of tensors must match" in msg
                            ):
                                raise
                        return logits

                _asa.AlignmentStreamAnalyzer.step = _safe_step  # type: ignore[assignment]

                # Belt-and-suspenders cap on generation length. The T3
                # inference loop's max_new_tokens is hardcoded to 1000
                # inside mtl_tts.generate; we monkey-patch the lower-level
                # T3.inference to clamp it relative to the input text. A
                # speech token is ~80ms of audio; typical ratio is 2–4
                # speech tokens per text token. 8× the text-token count is
                # generous headroom while keeping a runaway request short.
                from chatterbox.models.t3 import t3 as _t3_mod

                _orig_t3_inference = _t3_mod.T3.inference

                def _capped_inference(self, *, text_tokens, max_new_tokens=None, **kw):  # type: ignore[no-untyped-def]
                    derived_cap = max(100, int(text_tokens.size(-1)) * 8)
                    if max_new_tokens is None or max_new_tokens > derived_cap:
                        max_new_tokens = derived_cap
                    return _orig_t3_inference(
                        self,
                        text_tokens=text_tokens,
                        max_new_tokens=max_new_tokens,
                        **kw,
                    )

                _t3_mod.T3.inference = _capped_inference  # type: ignore[assignment]

                log.info("loading chatterbox multilingual (first call is slow)")
                _chatterbox = ChatterboxMultilingualTTS.from_pretrained(device="cpu")
                log.info("chatterbox loaded sample_rate=%s", _chatterbox.sr)
    return _chatterbox


def _f5_config_for(lang: str) -> Dict[str, str]:
    """Resolve F5 model+vocab/reference config for a request language. Each
    entry maps to a separate cached F5TTS instance (different checkpoints
    can't share weights at runtime). Falls back to English for langs we
    don't have a checkpoint for, with a warning the first time it happens."""
    short = lang.split("-")[0]
    if short == "de" and F5_DE_CKPT_PATH:
        return {
            "lang": "de",
            "arch": F5_DE_MODEL_ARCH,
            "ckpt": F5_DE_CKPT_PATH,
            "vocab": F5_DE_VOCAB_PATH,
            "voice": F5_DE_VOICE_PATH or "",
            "voice_text": F5_DE_VOICE_TEXT_PATH or "",
        }
    if short == "de" and not F5_DE_CKPT_PATH:
        log.warning(
            "f5 de requested but F5_DE_CKPT_PATH is not set; falling back "
            "to English model. Download a German checkpoint (e.g. "
            "aihpi/F5-TTS-German) and set F5_DE_CKPT_PATH + F5_DE_VOCAB_PATH."
        )
    return {
        "lang": "en",
        "arch": F5_MODEL,
        "ckpt": "",
        "vocab": "",
        "voice": F5_VOICE_PATH or "",
        "voice_text": F5_VOICE_TEXT_PATH or "",
    }


def get_f5(lang: str = "en"):
    """Load (and cache) the F5-TTS instance for the given language. Different
    langs typically need different checkpoints, so we keep one instance per
    lang in memory. Downloads ~1GB of weights (model + vocos vocoder) into
    HF_HOME on first call per lang; persists via the docker volume."""
    cfg = _f5_config_for(lang)
    cache_key = cfg["lang"]
    if cache_key not in _f5_instances:
        with _f5_lock:
            if cache_key not in _f5_instances:
                import torch

                from f5_tts.api import F5TTS

                device = "cuda" if torch.cuda.is_available() else "cpu"
                log.info(
                    "loading f5-tts lang=%s arch=%s ckpt=%s vocab=%s device=%s (first call is slow)",
                    cache_key, cfg["arch"], cfg["ckpt"] or "<bundled>",
                    cfg["vocab"] or "<bundled>", device,
                )
                _f5_instances[cache_key] = F5TTS(
                    model=cfg["arch"],
                    ckpt_file=cfg["ckpt"],
                    vocab_file=cfg["vocab"],
                    device=device,
                )
                log.info("f5-tts %s loaded", cache_key)
    return _f5_instances[cache_key]


def get_piper_voice(voice_id: str):
    """Load a Piper voice file lazily. Voices are cached in-memory by ID so
    repeat calls for the same language are free after the first load."""
    cached = _piper_voices.get(voice_id)
    if cached is not None:
        return cached
    with _piper_lock:
        cached = _piper_voices.get(voice_id)
        if cached is not None:
            return cached
        onnx_path, _ = _ensure_piper_voice_files(voice_id)
        from piper import PiperVoice

        log.info("loading piper voice %s", voice_id)
        voice = PiperVoice.load(onnx_path)
        _piper_voices[voice_id] = voice
        return voice


# ── routes ──────────────────────────────────────────────────────────────


@app.get("/health")
def health():
    return {
        "ok": True,
        "whisper_model": WHISPER_MODEL_NAME,
        "kokoro_langs": sorted(set(KOKORO_LANG_MAP.values())),
        "piper_langs": sorted(PIPER_VOICES.keys()),
        "chatterbox_langs": sorted(CHATTERBOX_LANGS),
        "f5_langs": sorted(F5_LANGS),
    }


@app.get("/voices")
def voices():
    """List every language the service can currently handle, plus the engine
    and the specific voice that will be used. Useful as a debugging aid and
    as a feed for any UI that wants to offer a language picker."""
    out = []
    for short in sorted(F5_LANGS):
        out.append({"lang": short, "engine": "f5", "voice": "default"})
    for short in sorted(CHATTERBOX_LANGS):
        if short in F5_LANGS:
            continue
        out.append({"lang": short, "engine": "chatterbox", "voice": "default"})
    for short, kokoro_lang in sorted(KOKORO_LANG_MAP.items()):
        if short in F5_LANGS or short in CHATTERBOX_LANGS:
            continue
        out.append(
            {"lang": short, "engine": "kokoro", "voice": KOKORO_VOICE, "kokoro_lang": kokoro_lang}
        )
    for short, voice_id in sorted(PIPER_VOICES.items()):
        if short in F5_LANGS or short in CHATTERBOX_LANGS or short in KOKORO_LANG_MAP:
            continue
        out.append({"lang": short, "engine": "piper", "voice": voice_id})
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
        segments, info = model.transcribe(
            tmp_path,
            language=language or WHISPER_LANGUAGE,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
            beam_size=1,  # greedy — much faster, fine for short utterances
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
    lang: str = "en"  # short code; routed by KOKORO/CHATTERBOX_LANGS/PIPER
    voice: Optional[str] = None  # engine-specific voice id / reference wav path
    engine: Optional[str] = None  # force "kokoro" | "piper" | "chatterbox"


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

    engine = (req.engine or _pick_engine(lang)).lower()
    if engine == "kokoro":
        kokoro_lang = KOKORO_LANG_MAP.get(lang, "en-us")
        samples, sample_rate, voice_used = _synth_kokoro(
            text, kokoro_lang, speed, req.voice
        )
    elif engine == "chatterbox":
        samples, sample_rate, voice_used = _synth_chatterbox(text, lang, req.voice)
    elif engine == "f5":
        samples, sample_rate, voice_used = _synth_f5(text, req.voice, speed, lang)
    elif engine == "piper":
        voice_id = req.voice or PIPER_VOICES.get(lang)
        if not voice_id:
            raise HTTPException(
                400,
                f"no piper voice configured for lang={lang!r}. Known langs: "
                f"{sorted(PIPER_VOICES)}",
            )
        samples, sample_rate, voice_used = _synth_piper(text, voice_id, speed)
    else:
        raise HTTPException(400, f"unknown engine: {engine!r}")

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
        "tts: %d chars lang=%s engine=%s voice=%s -> %d bytes wav",
        len(text),
        lang,
        engine,
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

    For Kokoro the chunks come out *as the model produces them*, so the
    client gets first audio in a few hundred ms instead of waiting for the
    whole sentence. Other engines emit a single chunk (their generators
    don't expose mid-synthesis output)."""
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text must be non-empty")
    if len(text) > 4000:
        raise HTTPException(413, f"text too long: {len(text)} chars (max 4000)")
    lang = (req.lang or "en").lower()
    speed = max(0.5, min(req.speed, 2.0))
    engine = (req.engine or _pick_engine(lang)).lower()

    import time as _time

    async def gen():
        t0 = _time.monotonic()
        chunk_idx = 0
        total_samples = 0
        last_log = t0
        if engine == "kokoro":
            kokoro = get_kokoro()
            voice = req.voice or KOKORO_VOICE
            kokoro_lang = KOKORO_LANG_MAP.get(lang, "en-us")
            log.info(
                "tts/stream start lang=%s engine=kokoro voice=%s chars=%d",
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
            # Chatterbox doesn't need this — its per-sentence latency already
            # provides a gap (drop or skip once the engine is GPU-accelerated).
            yield _encode_chunk(np.zeros(int(last_sr * 0.22), dtype=np.float32), last_sr)
        elif engine == "chatterbox":
            samples, sample_rate, _ = _synth_chatterbox(text, lang, req.voice)
            chunk_idx += 1
            log.info(
                "tts/stream chatterbox single-chunk dur=%dms",
                int(samples.size * 1000 / max(1, sample_rate)),
            )
            yield _encode_chunk(samples, int(sample_rate))
        elif engine == "f5":
            samples, sample_rate, _ = _synth_f5(text, req.voice, speed, lang)
            chunk_idx += 1
            log.info(
                "tts/stream f5 single-chunk dur=%dms",
                int(samples.size * 1000 / max(1, sample_rate)),
            )
            yield _encode_chunk(samples, int(sample_rate))
        elif engine == "piper":
            voice_id = req.voice or PIPER_VOICES.get(lang)
            if not voice_id:
                raise HTTPException(400, f"no piper voice for lang={lang!r}")
            samples, sample_rate, _ = _synth_piper(text, voice_id, speed)
            chunk_idx += 1
            log.info(
                "tts/stream piper single-chunk dur=%dms",
                int(samples.size * 1000 / max(1, sample_rate)),
            )
            yield _encode_chunk(samples, int(sample_rate))
        else:
            raise HTTPException(400, f"unknown engine: {engine!r}")
        log.info(
            "tts/stream done chunks=%d total_ms=%d",
            chunk_idx, int((_time.monotonic() - t0) * 1000),
        )
        _ = last_log  # silence unused

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


def _pick_engine(lang: str) -> str:
    """Default engine for a language code if the caller didn't force one.
    Order: explicit f5 override → chatterbox override → kokoro langs → piper."""
    if lang in F5_LANGS:
        return "f5"
    if lang in CHATTERBOX_LANGS:
        return "chatterbox"
    if lang in KOKORO_LANG_MAP:
        return "kokoro"
    return "piper"


def _fade_out(samples: np.ndarray, sr: int, fade_ms: int = 150) -> np.ndarray:
    """Apply a cosine fade to the last `fade_ms` of audio. A hard amplitude
    cutoff at the EOS reads as "speaker was about to continue"; a gentle
    taper reads as "sentence complete". Cosine shape is smoother than
    linear and avoids audible discontinuity."""
    n = min(samples.size, int(sr * fade_ms / 1000))
    if n <= 0:
        return samples
    fade = (0.5 * (1.0 + np.cos(np.linspace(0.0, np.pi, n)))).astype(samples.dtype)
    samples = samples.copy()
    samples[-n:] *= fade
    return samples


def _trim_chatterbox_tail(samples: np.ndarray, sr: int) -> np.ndarray:
    """Cut the trailing babble that Chatterbox produces between "real speech
    ends" and "analyzer forces EOS" — a 5–15 step window of `uahhh`-type
    artifacts the analyzer can't avoid.

    Heuristic: split the audio into 50ms RMS windows, look only at the
    trailing 40%, find the *last* run of ≥200ms below a silence floor, and
    chop everything after it. If the model never falls silent in that
    region we leave the audio alone — better to keep a slightly noisy
    ending than to clip a real word."""
    if samples.size == 0:
        return samples
    window_size = max(1, sr // 20)  # 50ms windows
    n_windows = samples.size // window_size
    if n_windows < 8:
        return samples
    chunks = samples[: n_windows * window_size].reshape(n_windows, window_size)
    rms = np.sqrt(np.mean(chunks * chunks, axis=1))
    silence_floor = max(0.005, float(rms.max()) * 0.05)
    silent = rms < silence_floor
    min_run = max(1, 200 // 50)  # 200ms / 50ms windows = 4
    search_start = int(n_windows * 0.6)
    run, last_silence_end = 0, -1
    for i in range(search_start, n_windows):
        if silent[i]:
            run += 1
            if run >= min_run:
                last_silence_end = i  # extends as long as the run continues
        else:
            run = 0
    if last_silence_end < 0:
        return samples
    return samples[: (last_silence_end + 1) * window_size]


def _synth_chatterbox(text: str, lang: str, voice: Optional[str]):
    """Chatterbox returns a torch tensor of float32 samples at model.sr.
    `voice` may be a path to a reference WAV for voice cloning; if None,
    Chatterbox uses its default speaker prompt."""
    model = get_chatterbox()
    # The multilingual model expects ISO short codes. Strip any region suffix
    # so "pt-br" maps to "pt", which is what the model was trained on.
    short_lang = lang.split("-")[0]
    # Per-request voice wins; otherwise fall back to CHATTERBOX_VOICE_PATH.
    # If the configured default is missing on disk, log once and use the
    # model's built-in conditioning rather than crashing the request.
    audio_prompt_path = voice or CHATTERBOX_VOICE_PATH
    if audio_prompt_path and not os.path.exists(audio_prompt_path):
        log.warning(
            "chatterbox voice ref not found at %s; using built-in default",
            audio_prompt_path,
        )
        audio_prompt_path = None
    with _chatterbox_gen_lock:
        wav = model.generate(
            text,
            language_id=short_lang,
            audio_prompt_path=audio_prompt_path,
            exaggeration=CHATTERBOX_EXAGGERATION,
            cfg_weight=CHATTERBOX_CFG,
        )
    # wav is a torch.Tensor shaped [1, T] or [T]. Move to CPU + numpy in [-1, 1].
    samples = wav.squeeze().detach().cpu().numpy().astype(np.float32)
    samples = _trim_chatterbox_tail(samples, int(model.sr))
    samples = _fade_out(samples, int(model.sr), fade_ms=150)
    return samples, model.sr, audio_prompt_path or "default"


def _f5_bundled_example() -> tuple[Optional[str], Optional[str]]:
    """Locate F5-TTS's bundled English reference clip + transcript inside the
    installed package. Used as a last-resort fallback when neither the
    per-request voice override nor F5_VOICE_PATH points at a real file.

    f5_tts is a PEP 420 namespace package (`__file__` is None), so we anchor
    on a real submodule and walk up to find the examples dir."""
    try:
        from f5_tts.infer import utils_infer as _ui  # type: ignore
    except ImportError:
        return None, None
    infer_dir = os.path.dirname(_ui.__file__)
    candidates = [
        os.path.join(infer_dir, "examples", "basic", "basic_ref_en.wav"),
        os.path.join(infer_dir, "..", "infer", "examples", "basic", "basic_ref_en.wav"),
    ]
    for wav in candidates:
        wav = os.path.abspath(wav)
        if os.path.exists(wav):
            txt = os.path.splitext(wav)[0] + ".txt"
            return wav, (txt if os.path.exists(txt) else None)
    return None, None


def _synth_f5(text: str, voice: Optional[str], speed: float, lang: str = "en"):
    """F5-TTS returns a numpy float32 waveform at the model's sample rate.

    F5 *requires* a reference WAV plus its exact transcript — there is no
    "model default" fallback inside the library; an empty ref_file blows up
    in preprocess_ref_audio_text. Resolution order:
      1. Per-request voice override (sibling .txt)
      2. Per-lang configured default (F5_VOICE_PATH for en, F5_DE_VOICE_PATH for de, etc.)
      3. F5's bundled basic_ref_en.wav (only sensible for English)
    The transcript is optional — F5 will auto-transcribe via Whisper if it's
    missing, but quality and prosody suffer."""
    cfg = _f5_config_for(lang)
    model = get_f5(lang)

    ref_audio: Optional[str] = None
    ref_text: Optional[str] = None

    # 1. Per-request override
    if voice and os.path.exists(voice):
        ref_audio = voice
        sibling_txt = os.path.splitext(voice)[0] + ".txt"
        if os.path.exists(sibling_txt):
            with open(sibling_txt, "r", encoding="utf-8") as f:
                ref_text = f.read().strip()
    elif voice:
        log.warning("f5 per-request voice ref not found at %s", voice)

    # 2. Per-lang configured default
    cfg_voice = cfg["voice"]
    cfg_voice_text = cfg["voice_text"]
    if ref_audio is None and cfg_voice and os.path.exists(cfg_voice):
        ref_audio = cfg_voice
        if cfg_voice_text and os.path.exists(cfg_voice_text):
            with open(cfg_voice_text, "r", encoding="utf-8") as f:
                ref_text = f.read().strip()

    # 3. Bundled example (English only — using it for other langs would
    # poison the model's prosodic conditioning)
    if ref_audio is None:
        if cfg["lang"] != "en":
            raise HTTPException(
                500,
                f"f5: no reference WAV configured for lang={cfg['lang']!r}. "
                f"Set the per-lang voice path (e.g. F5_DE_VOICE_PATH) to a "
                f"6-10s reference clip and drop the matching .txt next to it.",
            )
        bundled_wav, bundled_txt = _f5_bundled_example()
        if bundled_wav is None:
            raise HTTPException(
                500,
                "f5: no reference WAV configured and bundled example not "
                "found. Set F5_VOICE_PATH to a 6-10s reference clip.",
            )
        log.info("f5 using bundled example reference at %s", bundled_wav)
        ref_audio = bundled_wav
        if bundled_txt:
            with open(bundled_txt, "r", encoding="utf-8") as f:
                ref_text = f.read().strip()

    if not ref_text:
        log.warning(
            "f5 ref transcript missing for %s; F5 will auto-transcribe via "
            "whisper (slower + less accurate prosody)",
            ref_audio,
        )

    with _f5_gen_lock:
        wav, sample_rate, _ = model.infer(
            ref_file=ref_audio,
            ref_text=ref_text or "",
            gen_text=text,
            speed=speed,
            nfe_step=F5_NFE_STEP,
            cfg_strength=F5_CFG_STRENGTH,
            remove_silence=False,
            show_info=lambda *_a, **_k: None,
            progress=None,
        )
    samples = np.asarray(wav, dtype=np.float32)
    samples = _fade_out(samples, int(sample_rate), fade_ms=120)
    return samples, int(sample_rate), ref_audio


def _synth_kokoro(text: str, kokoro_lang: str, speed: float, voice: Optional[str]):
    kokoro = get_kokoro()
    voice_used = voice or KOKORO_VOICE
    # Kokoro returns float32 samples in [-1, 1] + the model sample rate (24kHz).
    samples, sample_rate = kokoro.create(
        text, voice=voice_used, speed=speed, lang=kokoro_lang
    )
    return samples, sample_rate, voice_used


def _synth_piper(text: str, voice_id: str, speed: float):
    voice = get_piper_voice(voice_id)
    # Piper outputs raw int16 PCM. length_scale = seconds-per-phoneme; lower
    # = faster. Invert the requested speed so speed=2.0 means 2x faster.
    length_scale = 1.0 / max(0.1, speed)
    pcm_chunks: list[bytes] = []
    for chunk in voice.synthesize_stream_raw(text, length_scale=length_scale):
        pcm_chunks.append(chunk)
    int16 = np.frombuffer(b"".join(pcm_chunks), dtype=np.int16)
    samples = int16.astype(np.float32) / 32768.0
    return samples, voice.config.sample_rate, voice_id


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
