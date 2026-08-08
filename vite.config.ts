import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Point the dev server at any Pyroscope instance:
//   PYROSCOPE_URL=http://pyroscope.example.com:4040 yarn dev
const pyroscopeUrl = process.env.PYROSCOPE_URL ?? 'http://localhost:4040';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@components': fileURLToPath(
        new URL('./src/components', import.meta.url),
      ),
      '@hooks': fileURLToPath(new URL('./src/hooks', import.meta.url)),
      '@api': fileURLToPath(new URL('./src/api', import.meta.url)),
      '@lib': fileURLToPath(new URL('./src/lib', import.meta.url)),
      '@views': fileURLToPath(new URL('./src/views', import.meta.url)),
    },
  },
  base: process.env.BASE_PATH ?? '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // Mirrors the binary's allowlist (see proxyPrefixes in main.go), so the
    // dev server cannot reach anything the built server refuses.
    proxy: {
      '/querier.v1.QuerierService': pyroscopeUrl,
    },
  },
});
