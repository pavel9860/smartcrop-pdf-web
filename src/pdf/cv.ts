// cv.ts — OpenCV.js runtime access point, shared by imaging.ts (detect/filter) and dewarp.ts
// (dewarp's cv.Mat resize/color-convert steps). Runs on the MAIN thread, not in a Worker —
// deliberate, not an oversight.
//
// This used to run inside a dedicated imaging.worker.ts. Root cause of moving it here:
// @techstark/opencv-js's own .d.ts re-exports `onRuntimeInitialized` as a NAMED EXPORT
// (dist/src/types/opencv/_hacks.d.ts), which collides with the runtime property of the
// same name Emscripten expects the embedder to set. `cvModule.onRuntimeInitialized = fn`
// is therefore an illegal import-binding reassignment — esbuild rejects it outright
// ("Cannot assign to import 'onRuntimeInitialized'; imports are immutable") whenever it
// analyses the import strictly (confirmed via `optimizeDeps.exclude` and via the
// dedicated-worker bundle, which does its own separate esbuild pass). Where a looser
// bundling path lets the assignment through silently instead of erroring (Vite's
// dev-time `optimizeDeps` pre-bundle for a plain main-thread import), the write still
// doesn't reach the real Emscripten module object, so onRuntimeInitialized never fires
// and every `cv.Mat`/etc. call throws "cv.Mat is not a constructor" forever. Confirmed
// with isolated minimal repros in both a Worker and a main-thread script.
//
// Fix: go through `cvModule.default` — the actual mutable Emscripten module object at
// runtime — instead of the namespace import itself. `cv` below is a local const, not an
// import specifier, so ordinary property assignment on it is legal and actually reaches
// the runtime object. Confirmed working in both contexts once fixed; kept execution on
// the main thread anyway (see loader.ts's equivalent pdf.js note) since a Worker-hosted
// nested esbuild pass for this exact package has its own separate strictness quirks
// (the "Cannot assign to import" build error above) that are simplest to avoid entirely
// by not re-bundling this package for a Worker target at all.
//
// Trade-off: detect/filter/dewarp now run on the UI thread instead of off it. Each call
// is a single bounded operation (one page's worth of Sauvola/connected-components work,
// spec §17 budgets ~150 ms), so this is a UX regression (brief UI block) rather than a
// correctness one — tracked as follow-up work, not silently accepted as fine.

import type * as CvNamespace from '@techstark/opencv-js'
import { CV_INIT_TIMEOUT_MS } from '@core/constants'
import { with_module_status } from './module_status'

type Cv = typeof CvNamespace

// Loaded on first ensure_cv() (11 MB — kept out of the startup bundle); every caller awaits
// ensure_cv() before touching it.
export let cv: Cv

// `cv.Mat` cannot be used as a *type* (cv is a value, not a TS namespace) — alias it via
// ReturnType<typeof cv.matFromImageData>, as elsewhere.
export type Mat = ReturnType<typeof cv.matFromImageData>

let _cv_init: Promise<void> | null = null

// Cached so concurrent callers share one init and one onRuntimeInitialized assignment (C3).
// Exported for tests/pdf/cv.test.ts only.
export function ensure_cv(): Promise<void> {
  _cv_init ??= with_module_status('Loading image engine…', async () => {
    cv = ((await import('@techstark/opencv-js')) as unknown as { default: Cv }).default
    // cv.Mat existing is proof the runtime is already up (init can finish during module load,
    // when onRuntimeInitialized has already fired). Typed always-present, so read it loosely.
    if ((cv as { Mat?: unknown }).Mat != null) return
    await new Promise<void>((resolve, reject): void => {
      cv.onRuntimeInitialized = (): void => { resolve() }
      setTimeout(() => {
        if ((cv as { Mat?: unknown }).Mat != null) { resolve(); return }
        reject(new Error(`OpenCV.js failed to initialize within ${CV_INIT_TIMEOUT_MS / 1000}s`))
      }, CV_INIT_TIMEOUT_MS)
    })
  }).catch((e: unknown) => { _cv_init = null; throw e })
  return _cv_init
}
