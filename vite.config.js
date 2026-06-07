import { defineConfig } from 'vite';

// The front end talks to the lean proxy backend (server/index.js) on :8787.
// Vite proxies /api/* there in dev so the browser can use same-origin URLs.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
