// Correctness + speed regression for the Dewarp & Deskew warp classifier / classic-CV rotate path
// (spec-web §7.1a, task T-deskew). Runs on demand via `npm run test:perf` (NOT part of the default
// `vitest run` — see vitest.perf.config.ts), same reasoning as scan_speed.test.ts: real OpenCV.js
// timing is machine-dependent and would flap in CI.
//
// Drives the REAL OpenCV.js SIMD build against deterministic synthetic pages (rows of cv.putText,
// rotated via cv.warpAffine for skew, remapped via cv.remap for a curl/warp simulation — same
// approach validated in the Python research prototype for this feature, see PROGRESS.md). Real
// fixture accuracy (the ~1.82deg number on tests/assets/..._rot.jpg, and trapezoid non-regression
// on ..._trap.png) is covered by tests/e2e/scan_deskew_classify.spec.ts instead, where a real
// browser decodes the real JPEG/PNG — no image-decode dependency needed here.
//
// Budgets asserted (spec-web §16): classifier < 100ms/page, classic-CV rotate-only < 300ms/page.
import { describe, it, expect, beforeAll } from 'vitest'
import { DESKEW_MAX_DEG, DESKEW_CLASSIFY_DOWNSCALE_PX } from '@core/constants'

/* eslint-disable @typescript-eslint/no-explicit-any */

let cv: any

async function load_cv(): Promise<any> {
  const mod: any = await import('@techstark/opencv-js')
  const inst = mod.default ?? mod
  if (inst.Mat) return inst
  await new Promise<void>((resolve) => {
    inst.onRuntimeInitialized = (): void => resolve()
    const poll = setInterval(() => { if (inst.Mat) { clearInterval(poll); resolve() } }, 20)
    setTimeout(() => { clearInterval(poll); resolve() }, 20_000)
  })
  return inst
}

const PAGE_W = 1240
const PAGE_H = 1755

// Dense rows of synthetic "text" (Hershey-font glyphs via cv.putText) — deterministic, no font/
// canvas dependency. Real-scan-like line spacing so the row-sum profile has genuine valleys.
function make_text_page(): any {
  // RGBA (CV_8UC4) — matches the real pipeline's cv.matFromImageData input (process_page,
  // imaging.ts), which is what estimate_deskew's cv.cvtColor(mat, gray, COLOR_RGBA2GRAY) expects.
  const mat = new cv.Mat(PAGE_H, PAGE_W, cv.CV_8UC4, new cv.Scalar(255, 255, 255, 255))
  const words = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog', 'import', 'return']
  let seed = 42
  const rand = (): number => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 0xffffffff }
  let y = 60
  while (y < PAGE_H - 40) {
    let x = 70
    while (x < PAGE_W - 150) {
      const word = words[Math.floor(rand() * words.length)] as string
      cv.putText(mat, word, new cv.Point(x, y), cv.FONT_HERSHEY_SIMPLEX, 0.7,
        new cv.Scalar(0, 0, 0, 255), 2)
      x += word.length * 14 + 14
    }
    y += 34
  }
  return mat
}

function rotate_mat_test(mat: any, angle_deg: number): any {
  const w = mat.cols, h = mat.rows
  const m = cv.getRotationMatrix2D(new cv.Point(w / 2, h / 2), angle_deg, 1.0)
  const out = new cv.Mat()
  cv.warpAffine(mat, out, m, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255))
  m.delete()
  return out
}

// Cylindrical-curl simulation (mirrors the Python research prototype's warp_page) — enough local
// curvature that no single rotation flattens the row profile, unlike a pure affine skew.
function warp_mat_test(mat: any, amplitude = 20, freq = 1.6): any {
  const w = mat.cols, h = mat.rows
  const map_x = new cv.Mat(h, w, cv.CV_32FC1)
  const map_y = new cv.Mat(h, w, cv.CV_32FC1)
  for (let y = 0; y < h; y++) {
    const ny = y / h - 0.5
    for (let x = 0; x < w; x++) {
      const nx = x / w - 0.5
      const shift_y = amplitude * Math.sin(freq * Math.PI * nx) * (ny * 2)
      map_x.floatPtr(y, x)[0] = x
      map_y.floatPtr(y, x)[0] = y + shift_y
    }
  }
  const out = new cv.Mat()
  cv.remap(mat, out, map_x, map_y, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255))
  map_x.delete(); map_y.delete()
  return out
}

function bench(fn: () => void, iters: number): number {
  for (let i = 0; i < 2; i++) fn()
  const t0 = performance.now()
  for (let i = 0; i < iters; i++) fn()
  return (performance.now() - t0) / iters
}

describe('deskew classifier + rotate-only path (spec-web §7.1a, §16 budgets)', () => {
  let flat: any, skewed_2_3: any, warped: any

  beforeAll(async () => {
    cv = await load_cv()
    flat = make_text_page()
    skewed_2_3 = rotate_mat_test(flat, 2.3)
    warped = warp_mat_test(flat)
  })

  it('detects the injected rotation angle within 0.1deg', async () => {
    const { estimate_deskew } = await import('@pdf/deskew')
    const { angle_deg } = estimate_deskew(skewed_2_3, DESKEW_CLASSIFY_DOWNSCALE_PX, DESKEW_MAX_DEG)
    expect(Math.abs(angle_deg - (-2.3))).toBeLessThan(0.1)
  })

  it('sharpness separates flat/skewed pages from a warped page', async () => {
    const { estimate_deskew } = await import('@pdf/deskew')
    const flat_result = estimate_deskew(flat, DESKEW_CLASSIFY_DOWNSCALE_PX, DESKEW_MAX_DEG)
    const skewed_result = estimate_deskew(skewed_2_3, DESKEW_CLASSIFY_DOWNSCALE_PX, DESKEW_MAX_DEG)
    const warped_result = estimate_deskew(warped, DESKEW_CLASSIFY_DOWNSCALE_PX, DESKEW_MAX_DEG)
    expect(flat_result.sharpness).toBeGreaterThan(1.0)
    expect(skewed_result.sharpness).toBeGreaterThan(1.0)
    expect(warped_result.sharpness).toBeLessThan(1.0)
    expect(warped_result.sharpness).toBeLessThan(flat_result.sharpness)
  })

  it('classifier runs under the 100ms/page budget (spec-web §16) — flag if exceeded', async () => {
    const { estimate_deskew } = await import('@pdf/deskew')
    const ms = bench(() => estimate_deskew(skewed_2_3, DESKEW_CLASSIFY_DOWNSCALE_PX, DESKEW_MAX_DEG), 10)
    console.log(`[perf] deskew classifier: ${ms.toFixed(1)} ms/page @ ${PAGE_W}x${PAGE_H}`)
    if (ms >= 100) {
      console.error(`[perf] FLAG: deskew classifier ${ms.toFixed(1)}ms exceeds the 100ms/page budget`)
    }
    expect(ms).toBeLessThan(100)
  })

  it('classic-CV rotate-only correction runs under the 300ms/page budget (spec-web §16) — flag if exceeded', async () => {
    const { estimate_deskew, rotate_mat } = await import('@pdf/deskew')
    const ms = bench(() => {
      const { angle_deg } = estimate_deskew(skewed_2_3, DESKEW_CLASSIFY_DOWNSCALE_PX, DESKEW_MAX_DEG)
      rotate_mat(skewed_2_3.clone(), angle_deg).delete()
    }, 10)
    console.log(`[perf] classic-CV rotate-only: ${ms.toFixed(1)} ms/page @ ${PAGE_W}x${PAGE_H}`)
    if (ms >= 300) {
      console.error(`[perf] FLAG: classic-CV rotate-only ${ms.toFixed(1)}ms exceeds the 300ms/page budget`)
    }
    expect(ms).toBeLessThan(300)
  })

  it('rotate_mat actually straightens the page (row-profile sharpness improves vs. uncorrected)', async () => {
    const { estimate_deskew, rotate_mat } = await import('@pdf/deskew')
    const { angle_deg } = estimate_deskew(skewed_2_3, DESKEW_CLASSIFY_DOWNSCALE_PX, DESKEW_MAX_DEG)
    const corrected = rotate_mat(skewed_2_3.clone(), angle_deg)
    const corrected_result = estimate_deskew(corrected, DESKEW_CLASSIFY_DOWNSCALE_PX, DESKEW_MAX_DEG)
    corrected.delete()
    expect(Math.abs(corrected_result.angle_deg)).toBeLessThan(0.2)
    expect(corrected_result.sharpness).toBeGreaterThan(1.0)
  })
})
