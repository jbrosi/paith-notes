# OpenAI TTS demo

Minimal Node script to A/B OpenAI TTS against the local Kokoro container
before deciding to swap MCP's voice backend.

## Run

```sh
# Smallest test
OPENAI_API_KEY=sk-...  node demo.mjs "Hello, this is a test."

# German
OPENAI_API_KEY=sk-...  node demo.mjs "Hallo, das ist ein Test mit einem etwas längeren Satz."

# Play while it streams (needs ffplay from ffmpeg)
OPENAI_API_KEY=sk-...  PLAY=1  node demo.mjs "Anything..."

# Quality lane + a different voice
OPENAI_API_KEY=sk-...  MODEL=tts-1-hd  VOICE=nova  node demo.mjs "Compare this clip to Kokoro."

# Instructable model — INSTRUCTIONS shapes delivery, not the words spoken.
OPENAI_API_KEY=sk-...  MODEL=gpt-4o-mini-tts  VOICE=nova  PLAY=1 \
  INSTRUCTIONS="Speak slowly and warmly, like reading a bedtime story." \
  node demo.mjs "Once upon a time, in a quiet little forest at the edge of a sleepy village, there lived a small fox who loved to count stars."

# A/B the same text with different vibes:
OPENAI_API_KEY=sk-...  MODEL=gpt-4o-mini-tts  VOICE=nova  PLAY=1 \
  INSTRUCTIONS="Sound nervous and rushed, like you're late for a meeting." \
  node demo.mjs "I really think we need to talk about the deployment plan before tomorrow."

OPENAI_API_KEY=sk-...  MODEL=gpt-4o-mini-tts  VOICE=nova  PLAY=1 \
  INSTRUCTIONS="Calm, confident, lower-pitched. Doctor giving good news." \
  node demo.mjs "I really think we need to talk about the deployment plan before tomorrow."

# Works on German too — the voice picks up the language from the text,
# the instructions shape the delivery.
OPENAI_API_KEY=sk-...  MODEL=gpt-4o-mini-tts  VOICE=nova  PLAY=1 \
  INSTRUCTIONS="Warm, sachlich, leicht hanseatisch eingefärbt." \
  node demo.mjs "Guten Morgen — hier ist heute Ihr Tagesüberblick zum aktuellen Stand der Auslieferungen."
```

Output lands in `out.mp3` by default. Override with `OUT=foo.wav FORMAT=wav`.

## Knobs

| env | default | notes |
|---|---|---|
| `MODEL` | `tts-1` | `tts-1` ($15/1M), `tts-1-hd` ($30/1M), `gpt-4o-mini-tts` ($0.60/1M tokens) |
| `VOICE` | `alloy` | `alloy ash ballad coral echo fable nova onyx sage shimmer` |
| `FORMAT` | `mp3` | `mp3 opus aac flac wav pcm` |
| `OUT` | `out.mp3` | output file |
| `PLAY` | `0` | `1` to pipe to `ffplay` while streaming |
| `INSTRUCTIONS` | _(unset)_ | Free-form delivery hints. **Only honoured by `gpt-4o-mini-tts`** — `tts-1`/`tts-1-hd` ignore it. |

## What `INSTRUCTIONS` can do

It shapes **how** the text is delivered, not what's said. Useful axes:

- **Tone**: "warm", "matter-of-fact", "sceptical", "cheerful", "anxious"
- **Pace**: "slow and deliberate", "rapid newsroom delivery"
- **Emotion**: "excited", "consoling", "frustrated", "tired"
- **Persona**: "old-time radio broadcaster", "Bavarian grandmother", "patient teacher"
- **Pitch / register**: "lower-pitched", "breathy whisper"
- **Pronunciation hints**: "British pronunciation", "say acronyms letter by letter"
- **Pauses**: "pause briefly before names"

You can stack them: `"Calm, slow, warm — like reading to a child. Pause briefly between sentences."`

What it **can't** do:
- Speak in a specific real person's voice (no cloning).
- Add SFX or music (just speech).
- Change the words. If you say "speak as a French waiter" but pass English text, it'll speak English in a French-accented voice.

## German specifically

OpenAI's TTS is **multilingual** — every voice handles ~50 languages
(German, French, Spanish, Italian, Portuguese, Dutch, Polish, etc.). You
don't pick a language; the model infers it from the text. So the same
voice (e.g. `nova`) speaks both English and German cleanly. Pronunciation
is noticeably better than Kokoro for German prosody, where Kokoro doesn't
ship a German voice at all and you'd be falling back to Piper or
Chatterbox today.

Caveat: very short German fragments can occasionally get an English
accent if the text is ambiguous (e.g. "OK"). For full sentences this
isn't an issue.

## Why this exists

Today MCP's `SentenceTtsStreamer` (`app/mcp/src/chat.ts:120`) POSTs each
sentence to `{VOICE_BASE_URL}/tts/stream` and forwards the streamed
chunks as `audio_chunk` SSE events. OpenAI's `/v1/audio/speech` endpoint
has the same shape (POST with text, streamed audio response). Wiring it
in is a ~50-line addition: another engine branch in the streamer that
hits OpenAI instead of the local container.

The infrastructure delta is:
- No voice container in prod compose.
- Roughly $0.50/hour of continuous synthesis at `tts-1` rates (~16K
  chars/minute = real-time speaking speed).
- Same SSE shape to the frontend; the browser just gets MP3 (or PCM)
  chunks instead of WAV.

If after this demo you like the quality, ping me and I'll do the MCP
integration.
