import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Built on the app's own vite config so tests resolve `@api/…` and compile
// TSX exactly the way the bundle does — there is no second module graph to
// keep in step.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
      setupFiles: ['./vitest.setup.ts'],
      // Components read the URL directly; give every file a fixed starting
      // point instead of whatever the previous test navigated to.
      environmentOptions: { jsdom: { url: 'http://localhost:4041/' } },
      coverage: {
        // Reported, not enforced, and it undercounts: the browser suite
        // exercises the views and the canvases without contributing anything
        // here, so those read 0%. It answers "what has no unit test" without
        // a manual survey, which is the only question it is good for.
        provider: 'v8',
        reporter: ['text-summary', 'html'],
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          'src/lib/flamegraph/**', // vendored; see its VENDORED.md
          'src/main.tsx',
          'src/**/*.test.{ts,tsx}',
        ],
      },
      clearMocks: true,
      restoreMocks: true,
      unstubGlobals: true,
    },
  }),
);
