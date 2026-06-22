# Base image with system deps: ffmpeg for whisper audio decoding, curl to
# pre-fetch the Kokoro model at build time so first request isn't slow.
# Pinned to Python 3.11 — onnxruntime + ctranslate2 ship wheels for 3.10–3.12.
FROM python:3.11-slim AS base
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
        # libsndfile1: soundfile's backend for reading non-WAV uploads.
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── speaker-embedding model (sherpa-onnx + wespeaker) ──────────────────
# wespeaker ResNet34 trained on VoxCeleb — 192-dim embeddings, ~25MB
# ONNX. Released under MIT by wenet-e2e; mirror hosted by k2-fsa as
# part of the sherpa-onnx model zoo. We bake it into the image so the
# first /enroll request doesn't pay a network cost.
ARG SPEAKER_MODEL_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx
ENV SPEAKER_EMBEDDING_MODEL=/app/models/speaker/wespeaker_en_voxceleb_resnet34_LM.onnx
RUN mkdir -p /app/models/speaker && \
    curl -fsSL "${SPEAKER_MODEL_URL}" -o "${SPEAKER_EMBEDDING_MODEL}"

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

# Speaker-ID enrollment file. Lives under /app/data so the existing
# voice_models volume (which already persists across rebuilds) doesn't
# need a new mount. Empty file = no enrollments = privacy default.
ENV SPEAKER_DB_PATH=/app/data/speaker_enrollments.json
RUN mkdir -p /app/data

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
