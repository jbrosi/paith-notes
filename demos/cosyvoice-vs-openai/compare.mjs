#!/usr/bin/env node
// Drives both OpenAI TTS and CosyVoice 2 with the same sample set so you
// can listen side-by-side. Writes MP3/WAV per (engine × sample) into
// `out/` and prints a table you can read while browsing the files.
//
// Usage:
//   OPENAI_API_KEY=sk-... node compare.mjs
//
// Env overrides:
//   OPENAI_VOICE      voice for OpenAI side       (default: nova)
//   OPENAI_MODEL      model for OpenAI side       (default: gpt-4o-mini-tts)
//   COSYVOICE_URL     CosyVoice base URL          (default: http://localhost:50000)
//   COSYVOICE_SPK     pretrained voice id         (default: 中文女 — yes, "Chinese female"
//                                                  is the CosyVoice2 default; it handles
//                                                  English fine too. Switch via the UI to
//                                                  find an English voice you prefer.)
//   ONLY              regex on sample id          (default: matches everything)
//
// Note: CosyVoice 2 doesn't expose an OpenAI-compatible API by default.
// We use its Gradio /api/predict endpoint. If the Gradio API surface
// changes, this script may need tweaking — the more robust path is to
// use the official runtime gRPC/REST server they ship in `runtime/`.

import { mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
    console.error('Set OPENAI_API_KEY.');
    process.exit(1);
}

const OPENAI_VOICE = process.env.OPENAI_VOICE || 'nova';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini-tts';
const COSYVOICE_URL = process.env.COSYVOICE_URL || 'http://localhost:50000';
const COSYVOICE_SPK = process.env.COSYVOICE_SPK || '中文女';
const ONLY = new RegExp(process.env.ONLY || '.*');

const OUT_DIR = path.join(import.meta.dirname, 'out');
await mkdir(OUT_DIR, { recursive: true });

const samples = JSON.parse(
    await readFile(path.join(import.meta.dirname, 'samples.json'), 'utf8'),
).samples.filter((s) => ONLY.test(s.id));

console.log(
    `Generating ${samples.length} samples × 2 engines → ${OUT_DIR}\n`,
);

async function genOpenAI(sample) {
    const start = Date.now();
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: OPENAI_MODEL,
            input: sample.text,
            voice: OPENAI_VOICE,
            response_format: 'mp3',
            ...(sample.instruction ? { instructions: sample.instruction } : {}),
        }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const file = path.join(OUT_DIR, `${sample.id}.openai.mp3`);
    await writeFile(file, buf);
    return { ms: Date.now() - start, bytes: buf.length, file };
}

async function genCosyVoice(sample) {
    const start = Date.now();
    // The exact Gradio endpoint changes between versions. As of CosyVoice2
    // launch (March 2025), the Instruct mode is "/inference_instruct2".
    // If this 404s, the route name has likely changed — open the UI's
    // Network tab to see the current endpoint, then update here.
    const res = await fetch(`${COSYVOICE_URL}/inference_instruct2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            tts_text: sample.text,
            instruct_text: sample.instruction || '',
            spk_id: COSYVOICE_SPK,
            // streaming would be lower-latency; for A/B we just want the
            // full file, easier to compare.
            stream: false,
        }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`CosyVoice ${res.status}: ${body.slice(0, 200)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const file = path.join(OUT_DIR, `${sample.id}.cosyvoice.wav`);
    await writeFile(file, buf);
    return { ms: Date.now() - start, bytes: buf.length, file };
}

const rows = [];
for (const s of samples) {
    const row = { id: s.id, oai_ms: '-', oai_kb: '-', cv_ms: '-', cv_kb: '-' };
    try {
        const r = await genOpenAI(s);
        row.oai_ms = String(r.ms);
        row.oai_kb = String(Math.round(r.bytes / 1024));
    } catch (e) {
        row.oai_ms = `ERR: ${e.message.slice(0, 60)}`;
    }
    try {
        const r = await genCosyVoice(s);
        row.cv_ms = String(r.ms);
        row.cv_kb = String(Math.round(r.bytes / 1024));
    } catch (e) {
        row.cv_ms = `ERR: ${e.message.slice(0, 60)}`;
    }
    rows.push(row);
    console.log(
        `${s.id.padEnd(20)}  OAI ${row.oai_ms.padStart(6)}ms ${row.oai_kb.padStart(4)}KB   CV ${row.cv_ms.padStart(6)}ms ${row.cv_kb.padStart(4)}KB`,
    );
}

console.log(
    `\nDone. Play pairs back-to-back: \`mpv out/<id>.openai.mp3 out/<id>.cosyvoice.wav\``,
);
