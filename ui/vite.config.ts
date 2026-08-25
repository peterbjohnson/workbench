import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const UI = fileURLToPath(new URL('.', import.meta.url));
const WORKBENCH = fileURLToPath(new URL('..', import.meta.url));

/** Everything the API answers. In development these go to a running `wb serve`. */
const API = ['/tickets', '/policy', '/events', '/health'];

export default defineConfig({
  root: UI,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    // The board imports the domain and the same API client the CLI uses, both of
    // which live above this directory.
    fs: { allow: [WORKBENCH] },
    proxy: Object.fromEntries(
      API.map((path) => [path, { target: 'http://127.0.0.1:4600', changeOrigin: false }]),
    ),
  },
});
