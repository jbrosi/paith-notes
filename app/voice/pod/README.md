# Voice service - RunPod GPU deployment

The local `app/voice` service (Kokoro / Chatterbox / F5 / Whisper) runs
CPU-only in Docker for dev. For F5-TTS in production we offload synthesis
to a RunPod GPU pod and keep STT local (Whisper sees raw mic audio - do
not ship that off-box).

This folder holds the pod-side artifacts:

- `voice_pod.py` - slim FastAPI service exposing `/tts/stream`,
  `/health`, `/voices` with the same wire format as the local service,
  gated by a bearer token. Per-lang F5 routing (en, de) with one
  cached instance per language.
- `download_f5_de.py` - fetches the German F5 checkpoint
  (`aihpi/F5-TTS-German`) and stages it where voice_pod.py looks for it.
- `get_thorsten_ref.py` - fetches a CC0 Thorsten-Voice clip plus
  transcript for the F5 German voice reference.

## One-time pod setup

Provision a Secure Cloud pod with an **RTX 4000 Ada** (cheapest GPU
that runs F5 at sub-second latency in EU). Attach a ~30 GB network
volume mounted at `/workspace` - venv, weights, and reference clips
live there so they survive stop/start and host migration.

In the pod terminal:

```bash
cd /workspace
python -m venv venv
source venv/bin/activate

# PyTorch must match the pod's CUDA driver (12.4 max on RTX 4000 Ada).
# Default PyPI ships cu128 which fails on this driver.
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install f5-tts fastapi uvicorn huggingface_hub
```

## German F5 checkpoint

`voice_pod.py` ships English (bundled in the f5-tts package) out of the
box. For German, fetch the community checkpoint - one-time, lives on
the network volume:

```bash
source /workspace/venv/bin/activate
python /workspace/download_f5_de.py
# writes /workspace/f5_de/model.safetensors + /workspace/f5_de/vocab.txt
```

## Reference clip (German)

The Thorsten-Voice HF mirror is parquet-shard format, so the picker
needs `datasets` + `soundfile` (only for this one-time download, not
at runtime):

```bash
source /workspace/venv/bin/activate
pip install -q datasets soundfile
python /workspace/get_thorsten_ref.py
# writes /workspace/ref_de.wav + /workspace/ref_de.txt
```

If candidate #5 sounds bad, try `--index 12` etc. The script is
idempotent - re-running overwrites both files.

## Bearer token

Generate once:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Then set it in **two** places:

- On the pod, before starting uvicorn:
  `export VOICE_TOKEN=<value>` (or bake it into `/workspace/.env`
  that you `source` at boot).
- Locally in `~/.config/paith/mcp.env`:

  ```
  VOICE_F5_URL=https://<pod-id>-8000.proxy.runpod.net
  VOICE_F5_TOKEN=<value>
  ```

  `VOICE_F5_URL` is the F5-only route. Leave `VOICE_BASE_URL` unset so
  Kokoro/Chatterbox/Piper keep going to the local `voice` container.
  `VOICE_F5_TOKEN` falls back to `VOICE_TOKEN` when unset, so a single
  shared secret on both endpoints needs only one line.

  Then `docker compose restart mcp`.

## RunPod port panels - HTTP vs TCP

RunPod has *two* port lists in the pod UI:

- **TCP Ports** - port 22 (SSH) lives here.
- **HTTP Ports** - **this** is where 8000 needs to go. Adds a
  `https://<pod-id>-8000.proxy.runpod.net` proxy URL.

If `/health` returns 404, you forgot to add 8000 to HTTP Ports.

## Start the service

Every time the pod boots (including after stop+resume - shell state
is wiped, so `uvicorn: command not found` means the venv isn't
sourced):

```bash
source /workspace/venv/bin/activate
cd /workspace
export VOICE_TOKEN=<value>     # if not loaded from a file
uvicorn voice_pod:app --host 0.0.0.0 --port 8000
```

The `startup` hook in `voice_pod.py` pre-warms the F5 model (~30 s on
first boot, faster on subsequent ones thanks to HF cache on the
volume), so the first real request is fast.

## Smoke test

```bash
curl -i https://<pod-id>-8000.proxy.runpod.net/health
# → 200 {"ok": true, ...}

curl -X POST https://<pod-id>-8000.proxy.runpod.net/tts/stream \
  -H "Authorization: Bearer $VOICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hallo Welt","lang":"de","engine":"f5"}' \
  --output test.wav
```

## Stop the pod when idle

In the RunPod UI: **Stop**. The container disk continues to bill at
~$0.01/h for storage; the GPU is released. Resume tries the same
host first; if it's gone the pod "migrates" to another node in the
same datacenter (a few minutes for container image re-pull). Your
`/workspace` survives either way.
