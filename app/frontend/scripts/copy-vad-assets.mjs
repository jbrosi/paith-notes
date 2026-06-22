// Copy the VAD model, worklet, and onnxruntime-web WASM/MJS pair into
// public/ so Vite's built-in publicDir handler serves them with the
// right MIME type and no `?import` rewriting. Without this, ort-web's
// runtime dynamic import of ort-wasm-simd-threaded.mjs gets intercepted
// by Vite's dep-optimizer and either fails MIME validation or hits the
// CJS-require/ESM-import mismatch we get when excluding ort.
//
// Runs from package.json `predev` / `prebuild` so the assets stay in
// sync with whatever versions yarn.lock pinned. public/vad/ and
// public/onnx/ are .gitignored — they're build artifacts, not source.

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const nm = (p) => resolve(root, 'node_modules', p);
const pub = (p) => resolve(root, 'public', p);

const targets = [
  {
    out: pub('vad'),
    files: [
      nm('@ricky0123/vad-web/dist/vad.worklet.bundle.min.js'),
      nm('@ricky0123/vad-web/dist/silero_vad_v5.onnx'),
    ],
  },
  {
    out: pub('onnx'),
    // ort picks one variant (jsep / asyncify / jspi / plain) at runtime
    // based on browser features. Ship all .mjs+.wasm pairs so any
    // browser's chosen path resolves; the unused ones aren't fetched.
    files: readdirSync(nm('onnxruntime-web/dist'))
      .filter((f) => /^ort-wasm-simd-threaded.*\.(mjs|wasm)$/.test(f))
      .map((f) => nm(`onnxruntime-web/dist/${f}`)),
  },
];

for (const { out, files } of targets) {
  mkdirSync(out, { recursive: true });
  for (const src of files) {
    if (!existsSync(src)) {
      console.warn(`[vad-assets] missing: ${src}`);
      continue;
    }
    const dest = join(out, src.split('/').pop());
    copyFileSync(src, dest);
    console.log(`[vad-assets] ${src} -> ${dest}`);
  }
}
