import { defineConfig } from 'vite';
import checker from 'vite-plugin-checker';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [
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
