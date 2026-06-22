# Base image with system deps: ffmpeg for whisper audio decoding, curl to
# pre-fetch the Kokoro model at build time so first request isn't slow.
# Pinned to Python 3.11 — onnxruntime + ctranslate2 ship wheels for 3.10–3.12.
FROM python:3.11-slim AS base
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Kokoro-82M ONNX model + voice pack. ~330MB + ~26MB.
# Mirror: https://github.com/thewh1teagle/kokoro-onnx/releases
ARG KOKORO_RELEASE=model-files-v1.0
ARG KOKORO_MODEL_FILE=kokoro-v1.0.onnx
ARG KOKORO_VOICES_FILE=voices-v1.0.bin
ENV KOKORO_MODEL_PATH=/app/models/kokoro/${KOKORO_MODEL_FILE}
ENV KOKORO_VOICES_PATH=/app/models/kokoro/${KOKORO_VOICES_FILE}
RUN mkdir -p /app/models/kokoro && \
    curl -fsSL "https://github.com/thewh1teagle/kokoro-onnx/releases/download/${KOKORO_RELEASE}/${KOKORO_MODEL_FILE}" \
         -o "${KOKORO_MODEL_PATH}" && \
    curl -fsSL "https://github.com/thewh1teagle/kokoro-onnx/releases/download/${KOKORO_RELEASE}/${KOKORO_VOICES_FILE}" \
         -o "${KOKORO_VOICES_PATH}"

# Cache dir for faster-whisper model downloads. Mounted as a volume in dev so
# the model doesn't redownload on every container rebuild.
ENV HF_HOME=/app/models/whisper
RUN mkdir -p /app/models/whisper

# ── dev stage ────────────────────────────────────────────────────────────
FROM base AS dev
# uvicorn --reload picks up changes to /app/src bind-mounted at runtime
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload", "--app-dir", "/app/src"]

# ── prod stage ───────────────────────────────────────────────────────────
FROM base AS prod
COPY src /app/src
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "/app/src"]
