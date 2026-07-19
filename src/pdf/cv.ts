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

import * as cvModule from '@techstark/opencv-js'

export const cv = (cvModule as unknown as { default: typeof cvModule }).default

// `cv.Mat` cannot be used as a *type* (cv is a value, not a TS namespace) — alias it via
// ReturnType<typeof cv.matFromImageData>, as elsewhere.
export type Mat = ReturnType<typeof cv.matFromImageData>

// Cached at module scope so concurrent callers share one init and one onRuntimeInitialized
// assignment (C3): previously each call installed its own callback, so a second concurrent
// call clobbered the first's, and the first caller's `resolve` never fired.
let _cv_init: Promise<void> | null = null

// Exported for tests/pdf/cv.test.ts only (C3 races need direct unit coverage — jsdom has no
// WASM cv context to exercise them through detect_content_async/process_page_async).
export function ensure_cv(): Promise<void> {
  if (!_cv_init) {
    // Fast path: some builds' WASM init can complete before this is ever called (e.g. it
    // finished during module load), in which case onRuntimeInitialized already fired as a
    // no-op — assigning a new handler here would never be invoked and we'd eat the full 10s
    // fallback for nothing every time. cv.Mat existing is proof the runtime is already up.
    // (cv.Mat is typed as an always-present constructor but is genuinely undefined pre-init —
    // read through an optional view so the runtime guard isn't type-narrowed away.)
    const cv_ready = (cv as { Mat?: unknown }).Mat != null
    _cv_init = cv_ready ? Promise.resolve() : new Promise<void>((resolve, reject): void => {
      cv.onRuntimeInitialized = (): void => { resolve() }
      // Fallback timeout in case the callback doesn't fire (matches prior behaviour) — but only
      // resolve if init actually completed by then; otherwise reject with a diagnosable error
      // instead of silently proceeding into a "cv.Mat is not a constructor" crash downstream, and
      // clear the cache so the NEXT call re-checks cv.Mat / re-arms the callback rather than
      // permanently failing every future call just because init finished a moment late.
      setTimeout(() => {
        if ((cv as { Mat?: unknown }).Mat != null) { resolve(); return }
        _cv_init = null
        reject(new Error('OpenCV.js failed to initialize within 10s'))
      }, 10_000)
    })
  }
  return _cv_init
}
