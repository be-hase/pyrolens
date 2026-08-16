import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Point the dev server at any Pyroscope instance:
//   PYROSCOPE_URL=http://pyroscope.example.com:4040 yarn dev
const pyroscopeUrl = process.env.PYROSCOPE_URL ?? 'http://localhost:4040';

const querierPrefix = '/querier.v1.QuerierService/';

// This list mirrors `querierMethods` in main.go — a new RPC has to be added
// in both places, or it works under `yarn dev` and 404s in the shipped
// binary.
const querierMethods = [
  'Diff',
  'LabelNames',
  'LabelValues',
  'SelectMergeStacktraces',
  'SelectSeries',
  'Series',
];

// vite's proxy option only matches on path, so it would happily forward any
// method to any RPC under the prefix — looser than main.go, which registers
// one exact "POST /querier.v1.QuerierService/<Method>" route per name.
// Reject everything else before it reaches the proxy, so an RPC that is not
// yet allowlisted in the binary fails the same way in dev as it will in
// production instead of appearing to work. `server.proxy` is inherited by
// both the dev server and `vite preview`, so the middleware is wired up in
// both `configureServer` and `configurePreviewServer` — dropping either one
// reopens the gap for that server. It is still inert for `vite build` and
// for vitest, which build on this config but never start either server.
const querierMiddleware: Connect.NextHandleFunction = (req, res, next) => {
  const url = req.url ?? '';
  if (!url.startsWith(querierPrefix)) {
    next();
    return;
  }
  const method = url.slice(querierPrefix.length).split('?')[0];
  if (req.method === 'POST' && querierMethods.includes(method)) {
    next();
    return;
  }
  res.statusCode = 404;
  res.end('Not Found');
};

function querierAllowlist(): Plugin {
  return {
    name: 'querier-allowlist',
    configureServer(server) {
      server.middlewares.use(querierMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(querierMiddleware);
    },
  };
}

export default defineConfig({
  plugins: [react(), querierAllowlist()],
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
    // The allowlist plugin above rejects anything this proxy should not
    // forward before it gets here; this entry only decides where the rest
    // goes.
    proxy: {
      [querierPrefix]: pyroscopeUrl,
    },
  },
});
