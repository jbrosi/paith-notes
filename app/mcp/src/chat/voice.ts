import type express from 'express';

/**
 * Voice-output streaming — takes finalized sentences from the chat
 * loop and pumps synthesized audio chunks to the client via SSE.
 *
 * Two backends behind one interface:
 *   - `local`  → Kokoro TTS container (default). Streams length-prefixed
 *                PCM chunks so the frontend can start playing before the
 *                whole sentence finishes synthesis.
 *   - `openai` → OpenAI /v1/audio/speech, gpt-4o-mini-tts. Emits a
 *                single mp3 blob per sentence and unlocks per-sentence
 *                `instructions` (delivery hints from `<voice instr>`
 *                model output).
 *
 * Extracted from chat.ts so the voice pipeline can be reasoned about
 * (and tested) without pulling in the whole streamConversation loop.
 */

// VOICE_BASE_URL points at the voice container (Kokoro TTS). STT is *not*
// routed through here — the frontend hits /api/voice/stt directly via
// Caddy, which always proxies to the local container so the user's mic
// audio never leaves the home network even when TTS runs in the cloud.
const VOICE_BASE_URL = process.env.VOICE_BASE_URL ?? 'http://voice:8000';
// Shared bearer secret matching the voice service's VOICE_TOKEN. Empty
// disables auth (fine for the local compose default; required when the
// URL is public).
const VOICE_TOKEN = (process.env.VOICE_TOKEN ?? '').trim();

// VOICE_PROVIDER=openai routes all TTS to OpenAI's /v1/audio/speech instead
// of the local Kokoro container, and unlocks per-sentence delivery
// instructions via the `<voice instr>` model output convention. STT still
// goes to the local voice container regardless. Defaults to `local`.
const VOICE_PROVIDER = (process.env.VOICE_PROVIDER ?? 'local').trim().toLowerCase();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY ?? '').trim();
// gpt-4o-mini-tts is the cheapest tier ($0.05/1M chars equiv) and is the
// only model that honours the `instructions` field.
const OPENAI_TTS_MODEL = (process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts').trim();
const OPENAI_TTS_VOICE = (process.env.OPENAI_TTS_VOICE ?? 'nova').trim();

// Sentence-end detection — fires when `.!?` (optionally followed by a
// closing quote/bracket) is followed by whitespace, or on a newline.
// Same regex shape as the previous frontend splitter but centralized here.
export const SENTENCE_END = /([.!?]+["')\]]*\s+|\n+)/;

// Strip markdown-y bits that sound bad read aloud (code fences, link
// targets, leading heading markers, UUID-shaped tokens like note IDs).
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NOTE_REF_RE = /\[\[note:[^\]]+\]\]/g;
export function stripForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // [[note:UUID]] is a UI-only marker — the user sees a clickable title;
    // for TTS we drop it entirely (no graceful spoken equivalent).
    .replace(NOTE_REF_RE, '')
    // Bare UUIDs (tool inputs, IDs the model wrote into prose) — TTS
    // would otherwise enunciate every digit and burn synth time.
    .replace(UUID_RE, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .trim();
}

function sseWrite(res: express.Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(a.length + b.length));
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Streams sentences to the voice service eagerly (fires fetch the moment a
 * sentence boundary closes) while emitting the resulting audio chunks to
 * the client in strict submission order.
 *
 * "Eager fetch + ordered drain" is the trick: by the time we get to
 * sentence N's drain, the voice service has often already produced its
 * chunks because N's fetch went out while N-1 was still being read. On a
 * laptop that can run two or three concurrent Kokoro syntheses, this
 * accumulates a buffer and the client never starves between sentences.
 */
export class VoiceStreamer {
  private pending: Promise<void> = Promise.resolve();
  private res: express.Response;
  private lang: string;
  private seq = 0;
  // Snapshot env once at construction so a hot-reload (or test override)
  // is the only way to flip provider mid-process.
  private provider: 'local' | 'openai' =
    VOICE_PROVIDER === 'openai' && OPENAI_API_KEY ? 'openai' : 'local';

  constructor(res: express.Response, lang: string) {
    this.res = res;
    this.lang = lang;
    if (VOICE_PROVIDER === 'openai' && !OPENAI_API_KEY) {
      console.warn(
        '[voice] VOICE_PROVIDER=openai but OPENAI_API_KEY is unset — falling back to local voice service.',
      );
    }
  }

  enqueueSentence(rawSentence: string, instructions?: string | null): void {
    const clean = stripForSpeech(rawSentence);
    if (!clean) return;
    const seq = ++this.seq;
    console.log(
      `[voice] #${seq} enqueue provider=${this.provider} lang=${this.lang} chars=${clean.length}` +
        (instructions ? ` instr=${JSON.stringify(instructions.slice(0, 60))}` : '') +
        ` text=${JSON.stringify(clean.slice(0, 60))}`,
    );
    const doFetch = () => {
      if (this.provider === 'openai') {
        return fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: OPENAI_TTS_MODEL,
            input: clean,
            voice: OPENAI_TTS_VOICE,
            // OpenAI returns the full audio per request; `mp3` is the
            // browser-friendliest format that AudioContext.decodeAudioData
            // accepts everywhere.
            response_format: 'mp3',
            // Only `gpt-4o-mini-tts` honours `instructions`; older tiers
            // silently ignore it, so we always pass it when present.
            ...(instructions ? { instructions } : {}),
          }),
        });
      }
      return fetch(`${VOICE_BASE_URL}/tts/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(VOICE_TOKEN ? { Authorization: `Bearer ${VOICE_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          text: clean,
          lang: this.lang,
        }),
      });
    };
    // Eager fetch: the next request goes out while we're still draining
    // the current one. Kokoro is fast and lockless, so the pipeline stays
    // saturated and the client never starves between sentences.
    const fetchPromise = doFetch();
    // Optional client-side debug: emit a structured event the frontend can
    // surface in a debug panel without parsing log lines.
    sseWrite(this.res, 'voice_debug', {
      seq,
      kind: 'sentence_enqueued',
      chars: clean.length,
      text: clean.slice(0, 80),
    });
    // Chain the drain after any previously queued drains so chunks reach
    // the SSE in the order their source sentences came in.
    this.pending = this.pending.then(async () => {
      const fetchStartedAt = Date.now();
      try {
        const r = await fetchPromise;
        const synthFirstByteMs = Date.now() - fetchStartedAt;
        if (!r.ok || !r.body) {
          // Read body for diagnostics — TTS providers return JSON error
          // details (e.g. "Incorrect API key", "model not accessible by
          // this project") that the raw status code hides.
          const errBody = await r.text().catch(() => '<unreadable>');
          console.error(
            `[voice] #${seq} tts failed status=${r.status} body=${errBody.slice(0, 500)}`,
          );
          sseWrite(this.res, 'voice_debug', {
            seq,
            kind: 'error',
            status: r.status,
            body: errBody.slice(0, 500),
          });
          return;
        }
        let chunkIdx = 0;
        let totalBytes = 0;

        if (this.provider === 'openai') {
          // OpenAI returns a single encoded audio body per request — no
          // framing. AudioContext.decodeAudioData needs the whole MP3 to
          // decode anyway, so we buffer and emit it as one chunk.
          const ab = await r.arrayBuffer();
          const all = new Uint8Array(ab);
          chunkIdx = 1;
          totalBytes = all.length;
          sseWrite(this.res, 'audio_chunk', {
            seq,
            chunk: chunkIdx,
            data: Buffer.from(all).toString('base64'),
          });
        } else {
          const reader = r.body.getReader();
          let buf = new Uint8Array(0);
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              // Reader's Uint8Array may be backed by SharedArrayBuffer; copy
              // into a fresh ArrayBuffer-backed buffer for type compatibility
              // and so subsequent subarray() slices outlive the reader.
              const copy = new Uint8Array(value.length);
              copy.set(value);
              buf = concatU8(buf, copy);
            }
            while (buf.length >= 4) {
              const length =
                (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
              if (buf.length < 4 + length) break;
              const chunk = buf.subarray(4, 4 + length);
              chunkIdx++;
              totalBytes += chunk.length;
              sseWrite(this.res, 'audio_chunk', {
                seq,
                chunk: chunkIdx,
                data: Buffer.from(chunk).toString('base64'),
              });
              buf = buf.subarray(4 + length);
            }
          }
        }
        const totalMs = Date.now() - fetchStartedAt;
        console.log(
          `[voice] #${seq} done chunks=${chunkIdx} bytes=${totalBytes} ttfb=${synthFirstByteMs}ms total=${totalMs}ms`,
        );
        sseWrite(this.res, 'voice_debug', {
          seq,
          kind: 'sentence_done',
          chunks: chunkIdx,
          bytes: totalBytes,
          ttfb_ms: synthFirstByteMs,
          total_ms: totalMs,
        });
      } catch (e) {
        console.error(`[voice] #${seq} drain error`, e);
        sseWrite(this.res, 'voice_debug', {
          seq,
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    });
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}
