import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

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
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/ui/**', 'src/pdf/**'],
      // Excluded from unit-coverage because they cannot be meaningfully exercised under jsdom
      // and are validated by the Playwright e2e suite (tests/e2e/) instead — matching this
      // repo's pure->unit / boundary->e2e testing rule (CLAUDE.md):
      //   imaging.ts     — OpenCV.js (cv.Mat) runtime; jsdom has no WASM cv context
      //   canvas_view.ts — real Canvas2D paint/drag; jsdom's canvas is a non-rendering stub
      //   app.ts         — top-level controller wiring/boot/shortcuts; integration, not a unit
      //   main.ts        — 3-line bootstrap; workers — run only in a real Worker context
      exclude: [
        'src/workers/**', 'src/main.ts',
        'src/pdf/imaging.ts', 'src/ui/canvas_view.ts', 'src/ui/app.ts',
      ],
      thresholds: {
        'src/core/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        lines: 80,
      },
      reporter: ['text', 'lcov', 'html'],
    },
  },
})
