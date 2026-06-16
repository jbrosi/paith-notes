"""Slim F5-TTS service for the RunPod GPU pod.

Wire-compatible with the local app/voice service (`length-prefixed WAV
chunks` over `/tts/stream`). Bearer-token gated. Per-language routing
with one F5 instance cached per language:

  - `en` -> bundled F5TTS_v1_Base + bundled English reference clip
  - `de` -> F5TTS_Base + community German checkpoint (aihpi/F5-TTS-German)
           with `/workspace/ref_de.{wav,txt}` as the reference voice

The pod is intentionally F5-only - Kokoro/Chatterbox/Piper stay on the
local CPU service so we don't pay GPU minutes for things that don't
benefit from them.
"""

from __future__ import annotations

import io
import logging
import os
import secrets
import wave
from threading import Lock
from typing import Dict, Optional, Tuple

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel


# ── config ──────────────────────────────────────────────────────────────

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("voice_pod")

VOICE_TOKEN = (os.environ.get("VOICE_TOKEN") or "").strip()

# Flow-matching steps. F5 default is 32; 16 is the speed/quality sweet
# spot on this hardware. Drops below ~10 audibly degrade prosody.
F5_NFE_STEP = int(os.environ.get("F5_NFE_STEP", "16"))
# Classifier-free guidance strength. 1.0 skips the unconditional pass
# for ~2x speed at little quality cost on calm reference clips.
F5_CFG_STRENGTH = float(os.environ.get("F5_CFG_STRENGTH", "1.0"))

# Optional override of F5's bundled English reference. Drop a 6-10s WAV
# at the configured path with a sibling .txt of the exact transcript.
F5_EN_VOICE_PATH = os.environ.get("F5_EN_VOICE_PATH", "") or ""
F5_EN_VOICE_TEXT_PATH = os.environ.get("F5_EN_VOICE_TEXT_PATH", "") or ""

# German F5 - defaults match what download_f5_de.py drops on disk and
# what get_thorsten_ref.py writes for the reference voice.
F5_DE_MODEL_ARCH = os.environ.get("F5_DE_MODEL_ARCH", "F5TTS_Base")
F5_DE_CKPT_PATH = os.environ.get(
    "F5_DE_CKPT_PATH", "/workspace/f5_de/model.safetensors"
) or ""
F5_DE_VOCAB_PATH = os.environ.get(
    "F5_DE_VOCAB_PATH", "/workspace/f5_de/vocab.txt"
) or ""
F5_DE_VOICE_PATH = os.environ.get("F5_DE_VOICE_PATH", "/workspace/ref_de.wav") or ""
F5_DE_VOICE_TEXT_PATH = os.environ.get(
    "F5_DE_VOICE_TEXT_PATH", "/workspace/ref_de.txt"
) or ""


def _de_files_present() -> bool:
    return bool(
        F5_DE_CKPT_PATH and os.path.exists(F5_DE_CKPT_PATH)
        and F5_DE_VOCAB_PATH and os.path.exists(F5_DE_VOCAB_PATH)
    )


# ── app + auth ──────────────────────────────────────────────────────────

app = FastAPI(title="paith-notes voice-pod (F5)")


def require_token(authorization: Optional[str] = Header(default=None)) -> None:
    """Bearer-token gate. `/health` and `/voices` stay open so platform
    probes work; everything else 401s when the presented token mismatches.
    Constant-time compare to avoid leaking length via timing."""
    if not VOICE_TOKEN:
        return  # auth disabled
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    presented = authorization[len("Bearer "):].strip()
    if not secrets.compare_digest(presented, VOICE_TOKEN):
        raise HTTPException(401, "invalid bearer token")


# ── F5 model cache ──────────────────────────────────────────────────────

_f5_lock = Lock()
_f5_gen_lock = Lock()
_f5_instances: Dict[str, object] = {}


def _f5_bundled_ref() -> Tuple[Optional[str], Optional[str]]:
    """Path to F5's shipped English reference (basic_ref_en.wav + .txt).
    f5_tts is a PEP 420 namespace package - `f5_tts.__file__` is None -
    so we locate the package by walking from a regular submodule."""
    try:
        from f5_tts.infer import utils_infer as _ui  # type: ignore
    except Exception:
        return None, None
    root = os.path.dirname(_ui.__file__)
    wav = os.path.join(root, "examples", "basic", "basic_ref_en.wav")
    txt = os.path.join(root, "examples", "basic", "basic_ref_en.txt")
    return (
        wav if os.path.exists(wav) else None,
        txt if os.path.exists(txt) else None,
    )


def _f5_config_for(lang: str) -> Dict[str, str]:
    """Resolve F5 model + reference config for a request language. Each
    `lang` key in the result maps to one cached F5TTS instance - different
    checkpoints can't share runtime state."""
    short = lang.split("-")[0].lower()
    if short == "de" and _de_files_present():
        return {
            "lang": "de",
            "arch": F5_DE_MODEL_ARCH,
            "ckpt": F5_DE_CKPT_PATH,
            "vocab": F5_DE_VOCAB_PATH,
            "voice": F5_DE_VOICE_PATH,
            "voice_text": F5_DE_VOICE_TEXT_PATH,
        }
    if short == "de":
        log.warning(
            "f5 de requested but German checkpoint/vocab missing at %s / %s; "
            "falling back to English. Run download_f5_de.py to fetch weights.",
            F5_DE_CKPT_PATH, F5_DE_VOCAB_PATH,
        )
    return {
        "lang": "en",
        "arch": "F5TTS_v1_Base",
        "ckpt": "",
        "vocab": "",
        "voice": F5_EN_VOICE_PATH,
        "voice_text": F5_EN_VOICE_TEXT_PATH,
    }


def get_f5(lang: str = "en"):
    """Load (and cache) the F5-TTS instance for the given language. First
    call per lang downloads ~1GB of weights (model + vocoder) into HF cache."""
    cfg = _f5_config_for(lang)
    cache_key = cfg["lang"]
    if cache_key in _f5_instances:
        return _f5_instances[cache_key]
    with _f5_lock:
        if cache_key in _f5_instances:
            return _f5_instances[cache_key]
        import torch
        from f5_tts.api import F5TTS

        device = "cuda" if torch.cuda.is_available() else "cpu"
        log.info(
            "loading f5 lang=%s arch=%s ckpt=%s vocab=%s device=%s",
            cache_key, cfg["arch"], cfg["ckpt"] or "<bundled>",
            cfg["vocab"] or "<bundled>", device,
        )
        _f5_instances[cache_key] = F5TTS(
            model=cfg["arch"],
            ckpt_file=cfg["ckpt"],
            vocab_file=cfg["vocab"],
            device=device,
        )
        log.info("f5 lang=%s loaded", cache_key)
    return _f5_instances[cache_key]


# ── synthesis helpers ───────────────────────────────────────────────────

def _resolve_ref(req_voice: Optional[str], lang: str) -> Tuple[str, str]:
    """Pick (ref_wav, ref_text) by priority:
      1. per-request voice path + sibling .txt
      2. per-lang configured default (F5_*_VOICE_PATH)
      3. F5's bundled English ref (valid only when cfg lang resolved to en)
    Empty transcript would trigger F5's whisper auto-transcribe fallback,
    which pulls in torchcodec and explodes on this driver - so we treat
    a missing .txt as a hard problem and log loudly."""
    cfg = _f5_config_for(lang)

    if req_voice and os.path.exists(req_voice):
        sib = os.path.splitext(req_voice)[0] + ".txt"
        txt = ""
        if os.path.exists(sib):
            with open(sib, "r", encoding="utf-8") as f:
                txt = f.read().strip()
        return req_voice, txt

    if cfg["voice"] and os.path.exists(cfg["voice"]):
        txt = ""
        if cfg["voice_text"] and os.path.exists(cfg["voice_text"]):
            with open(cfg["voice_text"], "r", encoding="utf-8") as f:
                txt = f.read().strip()
        return cfg["voice"], txt

    if cfg["lang"] == "en":
        wav, txt_path = _f5_bundled_ref()
        if wav:
            txt = ""
            if txt_path:
                with open(txt_path, "r", encoding="utf-8") as f:
                    txt = f.read().strip()
            log.info("f5 using bundled english reference: %s", wav)
            return wav, txt

    raise HTTPException(
        500,
        f"f5: no reference WAV available for lang={cfg['lang']!r}. "
        f"For German, drop ref_de.wav + ref_de.txt at /workspace/.",
    )


def _fade_out(samples: np.ndarray, sr: int, fade_ms: int = 120) -> np.ndarray:
    """Cosine taper on the last `fade_ms`. A hard amplitude cutoff reads as
    'speaker was about to continue'; a gentle taper reads as 'sentence
    complete'."""
    n = min(samples.size, int(sr * fade_ms / 1000))
    if n <= 0:
        return samples
    fade = (0.5 * (1.0 + np.cos(np.linspace(0.0, np.pi, n)))).astype(samples.dtype)
    out = samples.copy()
    out[-n:] *= fade
    return out


def _synth_f5(text: str, voice: Optional[str], speed: float, lang: str) -> Tuple[np.ndarray, int, str]:
    model = get_f5(lang)
    ref_audio, ref_text = _resolve_ref(voice, lang)
    if not ref_text:
        log.warning(
            "f5 ref transcript missing for %s; F5 will fall back to whisper "
            "auto-transcribe, which requires torchcodec and may fail on this "
            "driver. Provide a sibling .txt to avoid this.",
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


def _encode_chunk(samples: np.ndarray, sample_rate: int) -> bytes:
    """One slice of float32 samples as length-prefixed WAV bytes for the
    /tts/stream wire format. The 4-byte big-endian length lets the client
    (MCP) carve chunks out of the byte stream without parsing WAV."""
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    wav_bytes = buf.getvalue()
    return len(wav_bytes).to_bytes(4, "big") + wav_bytes


# ── routes ──────────────────────────────────────────────────────────────

class TtsRequest(BaseModel):
    text: str
    speed: float = 1.0  # 0.5-2.0 typical
    lang: str = "en"  # short code; "en", "de"
    voice: Optional[str] = None  # per-request reference WAV path on the pod
    engine: Optional[str] = None  # accepted for compatibility; pod is F5-only


def _check_engine(engine: Optional[str]) -> None:
    if engine and engine.lower() != "f5":
        raise HTTPException(
            400,
            f"pod only serves f5; got engine={engine!r}. "
            f"Route non-f5 requests to the local voice service.",
        )


@app.get("/health")
def health():
    langs = ["en"] + (["de"] if _de_files_present() else [])
    return {"ok": True, "engines": ["f5"], "langs": langs}


@app.get("/voices")
def voices():
    langs = ["en"] + (["de"] if _de_files_present() else [])
    return {"engines": {"f5": {"langs": langs}}}


@app.post("/tts")
def tts(req: TtsRequest, _auth: None = Depends(require_token)):
    """Synthesize speech. Returns audio/wav (16-bit PCM mono)."""
    _check_engine(req.engine)
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text must be non-empty")
    if len(text) > 4000:
        raise HTTPException(413, f"text too long: {len(text)} chars (max 4000)")

    lang = (req.lang or "en").lower()
    speed = max(0.5, min(req.speed, 2.0))
    samples, sample_rate, voice_used = _synth_f5(text, req.voice, speed, lang)

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
        len(text), lang, voice_used, len(audio_bytes),
    )
    return Response(
        content=audio_bytes, media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/tts/stream")
async def tts_stream(req: TtsRequest, _auth: None = Depends(require_token)):
    """Streaming variant. Returns application/octet-stream of length-prefixed
    (uint32 BE) mini-WAV chunks. F5 doesn't expose mid-synthesis output so
    this emits a single chunk - the wire shape stays consistent with the
    local Kokoro multi-chunk path."""
    _check_engine(req.engine)
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text must be non-empty")
    if len(text) > 4000:
        raise HTTPException(413, f"text too long: {len(text)} chars (max 4000)")
    lang = (req.lang or "en").lower()
    speed = max(0.5, min(req.speed, 2.0))

    import time as _time

    async def gen():
        t0 = _time.monotonic()
        log.info("tts/stream start lang=%s chars=%d", lang, len(text))
        samples, sample_rate, voice_used = _synth_f5(text, req.voice, speed, lang)
        log.info(
            "tts/stream f5 single-chunk dur=%dms elapsed=%dms ref=%s",
            int(samples.size * 1000 / max(1, sample_rate)),
            int((_time.monotonic() - t0) * 1000),
            voice_used,
        )
        yield _encode_chunk(samples, int(sample_rate))

    return StreamingResponse(gen(), media_type="application/octet-stream")


# ── startup warm-up ─────────────────────────────────────────────────────

@app.on_event("startup")
def _warmup() -> None:
    """Pre-load English (and German if files present) so the first request
    doesn't pay the cold-load cost. Failures are logged but don't abort
    boot - partial service is more useful than no service."""
    try:
        get_f5("en")
        log.info("warmup: english F5 loaded")
    except Exception as e:
        log.exception("warmup: english F5 failed: %s", e)
    if _de_files_present():
        try:
            get_f5("de")
            log.info("warmup: german F5 loaded")
        except Exception as e:
            log.exception("warmup: german F5 failed: %s", e)
    else:
        log.info("warmup: german F5 skipped (no checkpoint at %s)", F5_DE_CKPT_PATH)
