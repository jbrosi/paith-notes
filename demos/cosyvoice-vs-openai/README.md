# CosyVoice 2 vs OpenAI TTS — A/B vibes check

Spin up CosyVoice 2 locally (with their Gradio UI), then run the same
sentences against both engines and listen. No integration with the main
app — just enough to decide whether self-hosting is worth wiring in.

## Prereqs

- **GPU** with CUDA 12.x. RTX 2070 (8GB) is sufficient; allocate ~5GB VRAM.
- **NVIDIA Container Toolkit** installed and `docker run --gpus all` works.
  Quick sanity: `docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi`.
- **OPENAI_API_KEY** with TTS scope (the one already in your env).
- **Disk**: ~10GB for the model checkpoint + Docker image.

If `docker run --gpus all` fails, that's the bigger problem to solve first
(it means the Proxmox → VM → Docker GPU passthrough chain has a gap).
See the notes from the earlier GPU section — start with `nvidia-smi` inside
the VM, work down from there.

## Step 1 — Run CosyVoice 2's web UI

```bash
cd /workspace/demos/cosyvoice-vs-openai
docker compose up cosyvoice
```

First boot downloads the model checkpoint (~3GB) from ModelScope; subsequent
starts are instant. When you see `Running on local URL: http://0.0.0.0:50000`
open `http://localhost:50000` in your browser.

In the UI:

- **Pick "Instruct" mode** (3rd tab). This is the equivalent of OpenAI's
  `instructions` field.
- **Type your text** in the "tts_text" box.
- **Type your instruction** in the "instruct_text" box.
- Pick a **预训练音色 / pretrained voice** like `中文女` or `英文男`.
- Click "**生成**" / "Generate audio".

For zero-shot voice cloning, use the "Zero-shot" tab: upload a 3–10s
reference WAV, type its transcript, then synthesize new text in that
voice.

## Step 2 — Compare against OpenAI on the same prompts

The existing `demos/openai-tts/demo.mjs` script handles the OpenAI side.
Run the same texts there with similar instructions and listen back-to-back.

Or use the comparison script that drives both:

```bash
cd /workspace/demos/cosyvoice-vs-openai
OPENAI_API_KEY=sk-... node compare.mjs
```

It reads `samples.json`, generates one MP3 per (engine × sample) into
`out/`, and prints a table. Open `out/` in your file manager and play
pairs back-to-back.

## What to listen for

Categories that distinguish "good enough" from "no, really":

- **Plain narration** — clean prosody, no glitches?
- **Emphasis** ("speak slowly", "rushed") — is the change real or imagined?
- **Mood** ("warm", "anxious") — distinguishable from neutral?
- **Whisper** — actual whispering or just quieter?
- **Persona** ("conspiratorial", "radio announcer") — character or generic?
- **Multilingual** — same voice, German → English mid-sentence: smooth?
- **Non-verbal hint** ("laughing while speaking") — any reaction at all?

Honest expectations:

| | OpenAI gpt-4o-mini-tts | CosyVoice 2 |
|---|---|---|
| Plain quality | Excellent | Good |
| Emphasis / pace | Real | Real |
| Mood shifts | Subtle | Subtle |
| Whisper / extreme styles | Weak | Weak (sometimes better) |
| Persona | Weak | Weak |
| Voice cloning | No | Yes (3–10s reference) |
| German | Excellent | Acceptable |

If CosyVoice 2 is "close enough" for plain + mood AND you want voice
cloning, it justifies the wire-up. If neither engine can do what you
hoped — Orpheus-TTS is the next experiment (inline `<laugh>`/`<sigh>`
tokens, less polished overall but actually expressive).
