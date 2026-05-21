import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Standalone Vite app for the MOVA admin panel. Independent of the
 * Nx webpack pipeline used by the Nest services — admin is a static
 * SPA, no shared build steps.
 *
 * Dev proxies `/v1` to the local api-gateway so a single origin serves
 * both the UI (5174) and the API (3000) without CORS headaches. In
 * production this SPA is served by any static host and configured via
 * VITE_API_BASE.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/v1': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../../dist/apps/admin',
    emptyOutDir: true,
  },
});
