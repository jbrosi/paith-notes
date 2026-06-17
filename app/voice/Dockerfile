# Base image with system deps: ffmpeg for whisper audio decoding, curl to
# pre-fetch the Kokoro model at build time so first request isn't slow.
# Pinned to Python 3.11 — kept for build-cache stability now that the only
# native dep is onnxruntime (which ships wheels for 3.10–3.12).
FROM python:3.11-slim AS base
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        curl \
        # build-essential is required because pkuseg (pulled in transitively
        # by chatterbox-tts for Chinese text segmentation) has no wheels for
        # Python 3.11 and compiles its Cython extension from source.
        build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# Pkuseg's setup.py does `import numpy` at module level without declaring
# numpy in pyproject.toml's build-system.requires, so pip's default build
# isolation fails. Pre-install numpy + cython + setuptools and run the rest
# without isolation so pkuseg's setup.py can see them.
RUN pip install --no-cache-dir numpy cython setuptools wheel
RUN pip install --no-cache-dir --no-build-isolation -r requirements.txt

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

# Piper voices to pre-bake into the image. Comma-separated list of Piper voice
# IDs (e.g. "de_DE-thorsten-medium,fr_FR-siwis-medium"). Anything else can be
# auto-downloaded at runtime on first use — these are just the "warm" ones.
# Catalog: https://huggingface.co/rhasspy/piper-voices
ARG PIPER_VOICES_BUILD=de_DE-thorsten-medium
ENV PIPER_VOICES_DIR=/app/models/piper
RUN mkdir -p "${PIPER_VOICES_DIR}" && \
    for voice in $(echo "${PIPER_VOICES_BUILD}" | tr ',' ' '); do \
        lang_full=$(echo "$voice" | cut -d- -f1); \
        lang_short=$(echo "$lang_full" | cut -d_ -f1); \
        speaker=$(echo "$voice" | cut -d- -f2); \
        quality=$(echo "$voice" | cut -d- -f3); \
        base="https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang_short}/${lang_full}/${speaker}/${quality}"; \
        echo "fetching piper voice ${voice}"; \
        curl -fsSL "${base}/${voice}.onnx"      -o "${PIPER_VOICES_DIR}/${voice}.onnx"; \
        curl -fsSL "${base}/${voice}.onnx.json" -o "${PIPER_VOICES_DIR}/${voice}.onnx.json"; \
    done

# Cache dir for faster-whisper model downloads. Mounted as a volume in dev so
# the model doesn't redownload on every container rebuild.
ENV HF_HOME=/app/models/whisper
RUN mkdir -p /app/models/whisper

# Chatterbox uses huggingface_hub's cache (HF_HOME). We already point HF_HOME
# at /app/models/whisper — share it: chatterbox stores under hub/, whisper
# stores under huggingface/, so they don't collide and one volume mount
# persists both.
RUN mkdir -p /app/models/whisper/hub

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
