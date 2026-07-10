import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Standalone config for the perf regression suite (`npm run test:perf`). Kept OUT of the default
// `vitest run` (see vitest.config.ts `exclude: tests/perf/**`) so heavy, machine-dependent timing
// does not gate every commit — it is runnable on demand. environment:node for accurate wall-clock
// timing (no jsdom overhead) and because it drives OpenCV.js directly, not the DOM.
export default defineConfig({
  resolve: {
    alias: {
      '@core':    resolve(__dirname, 'src/core'),
      '@pdf':     resolve(__dirname, 'src/pdf'),
      '@ui':      resolve(__dirname, 'src/ui'),
      '@workers': resolve(__dirname, 'src/workers'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/perf/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
