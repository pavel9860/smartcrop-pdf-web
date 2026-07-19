// Direct unit coverage for cv.ts's ensure_cv (C3). Excluded from the coverage gate for the rest
// of cv.ts (vitest.config.ts) — cv/Mat themselves need a real WASM cv context — but
// ensure_cv only touches `cv.onRuntimeInitialized`, mockable under jsdom without one.
import { describe, it, expect, vi, beforeEach } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */

const cv_mock: any = {}
vi.mock('@techstark/opencv-js', () => ({ default: cv_mock }))

describe('ensure_cv (C3)', () => {
  beforeEach(() => { vi.resetModules(); delete cv_mock.onRuntimeInitialized })

  it('two concurrent calls share one init and both resolve once the runtime fires', async () => {
    const { ensure_cv } = await import('@pdf/cv')
    const p1 = ensure_cv()
    const p2 = ensure_cv()
    // Caching means both callers got the SAME promise — a second concurrent call must not
    // install its own onRuntimeInitialized callback, clobbering the first's.
    expect(p1).toBe(p2)

    let settled = false
    const race = Promise.race([
      Promise.all([p1, p2]).then(() => { settled = true }),
      new Promise((resolve) => setTimeout(resolve, 50)),
    ])
    cv_mock.onRuntimeInitialized()
    await race
    expect(settled).toBe(true)
  })

  it('rejects if the runtime never fires within the fallback window, and retries cleanly after', async () => {
    vi.useFakeTimers()
    try {
      const { ensure_cv } = await import('@pdf/cv')
      const p1 = ensure_cv()
      const assertion = expect(p1).rejects.toThrow('OpenCV.js failed to initialize within 10s')
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion

      // A retry after the runtime actually finishes initializing must succeed, not keep
      // returning the stale rejected promise from the failed attempt.
      cv_mock.Mat = function (): void { /* stub constructor */ }
      await expect(ensure_cv()).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
      delete cv_mock.Mat
    }
  })
})
