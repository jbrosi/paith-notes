"""
Wake-word sidecar for paith-notes living-room kiosk.

The browser opens a WebSocket to /listen and streams 16kHz mono int16
PCM audio frames. openWakeWord scores each 80ms frame against the
configured wake-word models; when any model crosses the detection
threshold the server emits a JSON {"type":"wake",...} event and the
browser triggers its regular VAD-endpointed recording flow.

This service is intentionally local-only:
  - Bind to 127.0.0.1 in the host compose so the audio stream never
    leaves the device.
  - No outbound network calls after the wake-word models finish
    downloading at build time.
  - Fully open source stack (openWakeWord is Apache 2.0).

Models are bundled in the image; OPENWAKEWORD_MODELS env can override
the model list.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import List

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from openwakeword.model import Model

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("wake")

# Comma-separated wake-word models to load. Names match openWakeWord's
# bundled set: alexa, hey_jarvis, hey_mycroft, hey_rhasspy, weather,
# timer. Defaults to alexa — best-trained model in the bundled set and
# most natural to say. Note: "Alexa" is Amazon's trademark; fine for
# personal/family use, swap to hey_jarvis (or train custom) before
# shipping to anyone else.
WAKE_WORD_MODELS = [
    m.strip()
    for m in os.environ.get("OPENWAKEWORD_MODELS", "alexa").split(",")
    if m.strip()
]

# Score threshold. openWakeWord scores are 0-1; 0.5 is the library
# default. Lower → more false wakes; higher → more missed wakes.
# Tune for your living room (background TV, kids, etc.). 0.6-0.7 is the
# common sweet spot for noisy environments.
WAKE_THRESHOLD = float(os.environ.get("WAKE_THRESHOLD", "0.5"))

# Cooldown after a wake to avoid double-firing while the browser
# transitions to its recording state. The browser tears down the wake
# socket on fire anyway, but this is belt-and-suspenders.
WAKE_COOLDOWN_FRAMES = int(os.environ.get("WAKE_COOLDOWN_FRAMES", "12"))  # ~1s at 80ms/frame

# Periodic idle reset. openWakeWord keeps internal state across frames
# (recent mel-spec history, model hidden state) that drifts on long
# idle sessions and starts producing flaky scores after tens of
# minutes. Force a reset every N frames as insurance — the reset is
# free (just zeroes internal buffers) and a wake fire is unaffected
# because real speech fills the buffers again within a few frames.
# 375 frames * 80ms = ~30s; 0 disables.
WAKE_IDLE_RESET_FRAMES = int(os.environ.get("WAKE_IDLE_RESET_FRAMES", "375"))

# openWakeWord expects 80ms frames of 16kHz int16 mono audio.
FRAME_SAMPLES = 1280  # 16000 * 0.080
FRAME_BYTES = FRAME_SAMPLES * 2  # int16 = 2 bytes

# Optional bearer token. Unlike the voice service this binds to
# localhost only — the threat model is "anyone with code execution on
# the kiosk machine" which can already do anything. Auth here is
# overkill for the default deployment; keep it optional.
WAKE_TOKEN = (os.environ.get("WAKE_TOKEN") or "").strip()

app = FastAPI(title="paith-notes wake")

_model_lock = asyncio.Lock()
_model: Model | None = None


def get_model() -> Model:
    """Load the wake-word model on first use. openWakeWord initializes
    quickly (~100ms) since the ONNX models are tiny (a few MB each)."""
    global _model
    if _model is None:
        log.info("loading openwakeword models=%s", WAKE_WORD_MODELS)
        _model = Model(
            wakeword_models=WAKE_WORD_MODELS,
            inference_framework="onnx",
        )
        log.info(
            "openwakeword ready: %d model(s) loaded",
            len(_model.models),
        )
    return _model


@app.get("/health")
def health():
    return {
        "ok": True,
        "models": WAKE_WORD_MODELS,
        "threshold": WAKE_THRESHOLD,
    }


@app.websocket("/listen")
async def listen(ws: WebSocket) -> None:
    """Continuous wake-word detection.

    Wire format:
      Client → Server: binary frames of 16-bit little-endian PCM audio
        at 16kHz mono. Frame size doesn't have to be exactly 1280
        samples (80ms) — the server buffers and processes in 80ms
        chunks regardless.
      Server → Client: JSON text messages.
        {"type":"ready"} — sent immediately after the model finishes
            loading; safe to start sending audio.
        {"type":"wake","model":"alexa","score":0.83} — fired when
            any configured wake-word model crosses WAKE_THRESHOLD.
            The connection is NOT closed; the client typically closes
            it explicitly once it's switched to recording mode.
        {"type":"error","message":"..."} — fatal protocol error;
            connection will close right after.
    """
    if WAKE_TOKEN:
        # FastAPI doesn't expose pre-accept header inspection cleanly
        # for WebSockets; check after accept and close 1008 on bad auth.
        await ws.accept()
        presented = ws.query_params.get("token", "")
        import secrets as _secrets

        if not presented or not _secrets.compare_digest(presented, WAKE_TOKEN):
            await ws.send_text(json.dumps({"type": "error", "message": "auth"}))
            await ws.close(code=1008)
            return
    else:
        await ws.accept()

    try:
        model = get_model()
    except Exception as e:
        log.exception("model load failed: %s", e)
        await ws.send_text(json.dumps({"type": "error", "message": "model load failed"}))
        await ws.close(code=1011)
        return

    await ws.send_text(json.dumps({"type": "ready"}))
    log.info("wake session started")

    buf = bytearray()
    cooldown = 0
    frames_since_reset = 0
    try:
        while True:
            data = await ws.receive_bytes()
            buf.extend(data)
            while len(buf) >= FRAME_BYTES:
                frame_bytes = bytes(buf[:FRAME_BYTES])
                del buf[:FRAME_BYTES]
                frame = np.frombuffer(frame_bytes, dtype=np.int16)
                scores = model.predict(frame)
                frames_since_reset += 1
                # Periodic idle reset — guards against long-session drift.
                # Skipped if a wake just fired (reset already happened).
                if (
                    WAKE_IDLE_RESET_FRAMES > 0
                    and frames_since_reset >= WAKE_IDLE_RESET_FRAMES
                ):
                    model.reset()
                    frames_since_reset = 0
                if cooldown > 0:
                    cooldown -= 1
                    continue
                # scores is a dict {model_name: score}
                for name, score in scores.items():
                    if score >= WAKE_THRESHOLD:
                        log.info("wake: model=%s score=%.3f", name, score)
                        await ws.send_text(
                            json.dumps(
                                {
                                    "type": "wake",
                                    "model": name,
                                    "score": float(score),
                                }
                            )
                        )
                        cooldown = WAKE_COOLDOWN_FRAMES
                        # Reset internal state so the next session starts
                        # from a clean slate after the client tears down.
                        model.reset()
                        frames_since_reset = 0
                        break
    except WebSocketDisconnect:
        log.info("wake session closed")
    except Exception as e:
        log.exception("wake session error: %s", e)
        try:
            await ws.close(code=1011)
        except Exception:
            pass
