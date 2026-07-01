#!/usr/bin/env node
// Standalone OpenAI TTS demo — synthesizes a sentence and writes it to disk
// (and optionally pipes to a player). Useful for A/B-ing OpenAI vs local
// Kokoro before deciding to swap MCP's voice backend.
//
// Usage:
//   OPENAI_API_KEY=sk-...  node demo.mjs "Hello, this is a test."
//   OPENAI_API_KEY=sk-...  VOICE=nova MODEL=tts-1-hd  node demo.mjs "..."
//   echo "..." | node demo.mjs                      # text from stdin
//
// Voices: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer.
// Models: tts-1 (~$15 / 1M chars, fast), tts-1-hd (~$30 / 1M chars, slower).
//         gpt-4o-mini-tts (~$0.60 / 1M tokens, instructable; supports
//                          `instructions: "speak slowly with warmth"`).
//
// The endpoint streams audio chunks (Transfer-Encoding: chunked) so the
// first audible byte is well under 500ms even for long sentences. This
// matches what MCP's SentenceTtsStreamer already does with Kokoro — same
// shape, different backend.

import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { stdin } from 'node:process';

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
    console.error('Set OPENAI_API_KEY in env.');
    process.exit(1);
}

const VOICE = process.env.VOICE || 'alloy';
const MODEL = process.env.MODEL || 'tts-1';
const FORMAT = process.env.FORMAT || 'mp3';
const OUT = process.env.OUT || `out.${FORMAT}`;
const PLAY = process.env.PLAY === '1';
// Only supported by gpt-4o-mini-tts. Silently ignored by tts-1 / tts-1-hd.
// Examples: "speak slowly and warmly", "whisper", "frustrated supervisor".
const INSTRUCTIONS = process.env.INSTRUCTIONS || '';

async function readStdin() {
    let chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').trim();
}

const text = process.argv.slice(2).join(' ').trim() || await readStdin();
if (!text) {
    console.error('Provide text via argv or stdin.');
    process.exit(1);
}

console.log(
    `[openai-tts] model=${MODEL} voice=${VOICE} chars=${text.length}` +
        (INSTRUCTIONS ? ` instructions=${JSON.stringify(INSTRUCTIONS)}` : ''),
);
if (INSTRUCTIONS && !MODEL.startsWith('gpt-4o')) {
    console.warn(
        `[openai-tts] note: INSTRUCTIONS is only honoured by gpt-4o-mini-tts; ${MODEL} will ignore it.`,
    );
}
const start = Date.now();

const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
    },
    body: JSON.stringify({
        model: MODEL,
        input: text,
        voice: VOICE,
        response_format: FORMAT,
        ...(INSTRUCTIONS ? { instructions: INSTRUCTIONS } : {}),
    }),
});

if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    console.error(`[openai-tts] failed: ${res.status} ${res.statusText} ${detail}`);
    process.exit(1);
}

// Stream chunks straight to disk (and to a player if asked) so we can
// observe first-byte latency the same way MCP forwards chunks via SSE.
const out = createWriteStream(OUT);
const player = PLAY
    ? spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-'], {
        stdio: ['pipe', 'inherit', 'inherit'],
    })
    : null;

let bytes = 0;
let firstByteAt = 0;
const reader = res.body.getReader();
while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!firstByteAt) {
        firstByteAt = Date.now() - start;
        console.log(`[openai-tts] first byte in ${firstByteAt}ms`);
    }
    bytes += value.length;
    out.write(value);
    player?.stdin.write(value);
}
out.end();
player?.stdin.end();

const totalMs = Date.now() - start;
console.log(`[openai-tts] done in ${totalMs}ms — ${bytes} bytes written to ${OUT}`);
