import { defineConfig } from 'vite';
import checker from 'vite-plugin-checker';
import solid from 'vite-plugin-solid';

// onnxruntime-web (transitive dep of @ricky0123/vad-web) does a runtime
// `import("/onnx/ort-wasm-simd-threaded.mjs")` to load the WASM glue.
// Vite's import-analysis plugin tags every dynamic-import URL with a
// `?import` query so its transform middleware can recognize it. But the
// glue file is Emscripten output, not a real ES module Vite can
// transform — it falls through to the SPA htmlFallback which serves
// index.html with text/html, and the browser refuses to load it as a
// module ("disallowed MIME type"). Strip the query before publicDir
// gets a chance so the prebuilt copy under public/onnx/ is served as-is
// with the correct MIME type.
const servePrebuiltVadAssets = {
  name: 'serve-prebuilt-vad-assets',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && /^\/(onnx|vad)\//.test(req.url)) {
        req.url = req.url.split('?', 1)[0];
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [
    servePrebuiltVadAssets,
    solid(),
    checker({
      typescript: true,
    }),
  ],
  server: {
    host: true,
    allowedHosts: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '^/nooks/[^/]+/chat': {
        target: process.env.MCP_URL ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
