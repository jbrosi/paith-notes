# Wake-word sidecar for the living-room kiosk. Runs openWakeWord
# locally; the browser opens a WebSocket and streams raw 16kHz PCM mic
# audio. On wake detection the sidecar emits a JSON event; the browser
# then triggers the regular voice flow (VAD-endpointed recording + STT
# upload to the voice service).
#
# This container is intentionally tiny (no torch, no transformers, no
# WASM tooling): just FastAPI + openWakeWord + ONNX runtime. Bind only
# to localhost in the host compose so the audio stream never leaves the
# device.
FROM python:3.11-slim AS base
WORKDIR /app

# No system deps required — openwakeword uses pure-Python audio handling
# and onnxruntime ships wheels for 3.10-3.12.

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the bundled wake-word models so the first WebSocket
# connection doesn't pay the network cost. openwakeword fetches into
# ~/.local/share/openwakeword on first init when Model() is called with
# no explicit paths.
ENV OPENWAKEWORD_MODELS_PATH=/app/models/openwakeword
RUN python -c "import os; os.environ.setdefault('OPENWAKEWORD_MODELS_PATH', '/app/models/openwakeword'); import openwakeword.utils as u; u.download_models()"

# ── dev stage ───────────────────────────────────────────────────────────
FROM base AS dev
EXPOSE 8889
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8889", "--reload", "--app-dir", "/app/src"]

# ── prod stage ──────────────────────────────────────────────────────────
FROM base AS prod
COPY src /app/src
EXPOSE 8889
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8889", "--app-dir", "/app/src"]
