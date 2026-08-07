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
      clearMocks: true,
      restoreMocks: true,
      unstubGlobals: true,
    },
  }),
);
