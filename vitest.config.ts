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
    // tests/perf/** is the standalone perf suite (npm run test:perf, vitest.perf.config.ts) — heavy,
    // machine-dependent timing that must not gate every `vitest run`.
    exclude: ['tests/e2e/**', 'tests/perf/**'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/ui/**', 'src/pdf/**'],
      // Excluded from unit-coverage because they cannot be meaningfully exercised under jsdom
      // and are validated by the Playwright e2e suite (tests/e2e/) instead — matching this
      // repo's pure->unit / boundary->e2e testing rule (CLAUDE.md):
      //   imaging.ts     — OpenCV.js (cv.Mat) runtime; jsdom has no WASM cv context
      //   dewarp.ts      — ensure_onnx/apply_dewarp need a real ONNX+OpenCV runtime; its fp16
      //                    conversion + fetch_with_idb_cache ARE unit-tested (dewarp.test.ts),
      //                    but that's a minority of the file
      //   canvas_view.ts — real Canvas2D paint/drag; jsdom's canvas is a non-rendering stub
      //   app.ts         — top-level controller wiring/boot/shortcuts; integration, not a unit
      //   main.ts        — 3-line bootstrap; workers — run only in a real Worker context
      //   work_store.ts  — needs a real OffscreenCanvas for put()'s PNG encode; jsdom has none.
      //                    loader.ts stays INCLUDED — its pdf.js-mocked tests/pdf/loader.test.ts
      //                    is real, meaningful coverage, just not yet 90%. cv.ts and idb.ts also
      //                    stay INCLUDED — both are fully exercised under jsdom via a mocked
      //                    opencv-js / fake IndexedDB (cv.test.ts, idb.test.ts).
      exclude: [
        'src/workers/**', 'src/main.ts',
        'src/pdf/imaging.ts', 'src/pdf/dewarp.ts', 'src/ui/canvas_view.ts', 'src/ui/app.ts',
        'src/pdf/work_store.ts',
      ],
      thresholds: {
        'src/core/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        lines: 80,
      },
      reporter: ['text', 'lcov', 'html'],
    },
  },
})
