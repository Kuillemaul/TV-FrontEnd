import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the UI runs on :5173 and proxies API + websocket traffic to the Hearth server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
});
