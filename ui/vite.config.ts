import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const UI = fileURLToPath(new URL('.', import.meta.url));
const WORKBENCH = fileURLToPath(new URL('..', import.meta.url));

/**
 * Everything the API answers. In development these go to a running `wb serve`.
 *
 * A route missing from this list does not fail loudly: it falls through to the
 * SPA fallback, which hands back index.html with a 200. Keep it level with the
 * routes in src/api/server.ts.
 */
const API = ['/tickets', '/policy', '/events', '/health', '/agents', '/skills', '/settings'];

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
