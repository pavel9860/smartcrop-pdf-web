// Correctness + speed regression for Dewarp & Deskew (spec-web §7.1a/§7.1b). Runs on demand via
// `npm run test:perf` (NOT part of the default `vitest run` — see vitest.perf.config.ts): real
// OpenCV.js timing is machine-dependent and would flap in CI.
//
// §7.1a's warp classifier is tested here against synthetic pages (rows of cv.putText, rotated via
// cv.warpAffine for skew, remapped via cv.remap for a curl/warp simulation).
//
// §7.1b's vanishing-point math (vanishing_point.ts, vp_correct.ts) needs real cv.eigen but NOT the
// DBNet model — tested here with directly-constructed line segments passing through a KNOWN
// vanishing point, isolating the PROSAC/MSAC/IRLS/correction math from DBNet's own detection
// accuracy (which real content can't prove in Node anyway — no dev server to fetch the model
// from, same reason dewarp.ts's real ONNX inference is e2e-only, never perf-tested). DBNet model
// loading + real inference + the full pipeline against real fixtures is covered by
// tests/e2e/scan_deskew_classify.spec.ts instead.
//
// Budgets asserted (spec-web §16): §7.1a classifier < 100ms/page; §7.1b (DBNet + VP fit + remap,
// e2e-timed) < 1s/page.
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

describe('warp classifier (spec-web §7.1a, §16 budgets)', () => {
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
    console.log(`[perf] warp classifier: ${ms.toFixed(1)} ms/page @ ${PAGE_W}x${PAGE_H}`)
    if (ms >= 100) {
      console.error(`[perf] FLAG: warp classifier ${ms.toFixed(1)}ms exceeds the 100ms/page budget`)
    }
    expect(ms).toBeLessThan(100)
  })
})

describe('vanishing-point math (spec-web §7.1b) — direct geometry, no DBNet', () => {
  beforeAll(async () => {
    cv = await load_cv()
  })

  // Builds a segment through (x, y) exactly along the direction implied by a known VP — self-
  // consistent synthetic data to test the ESTIMATOR's fidelity to the model it assumes, distinct
  // from DBNet's real-world detection accuracy (proven separately, see file header).
  function segment_through_vp(v: readonly [number, number, number], x: number, y: number,
    half_len = 80): readonly [{ x: number; y: number }, { x: number; y: number }] {
    const [vx, vy, vz] = v
    const vzs = Math.abs(vz) > 1e-12 ? vz : 1e-12
    const px = vx / vzs, py = vy / vzs
    const dx = px - x, dy = py - y
    const len = Math.hypot(dx, dy)
    const ux = dx / len, uy = dy / len
    return [{ x: x - ux * half_len, y: y - uy * half_len }, { x: x + ux * half_len, y: y + uy * half_len }]
  }

  it('recovers a known pure-rotation VP (at infinity) from clean segments', async () => {
    const { estimate_vanishing_point, local_angle_from_vp } = await import('@pdf/vanishing_point')
    const true_angle = 2.3
    const true_v: readonly [number, number, number] =
      [Math.cos(true_angle * Math.PI / 180), Math.sin(true_angle * Math.PI / 180), 0]
    const anchors = [[100, 200], [900, 300], [300, 900], [700, 1500], [500, 800], [200, 1200]] as const
    const segments = anchors.map(([x, y]) => segment_through_vp(true_v, x, y))
    const confidences = anchors.map(() => 0.99)
    const weights = anchors.map(() => 200 * 200)

    const result = estimate_vanishing_point(segments, confidences, weights)
    expect(result).not.toBeNull()
    const recovered_angle = local_angle_from_vp(result!.v, 500, 800)
    expect(Math.abs(recovered_angle - true_angle)).toBeLessThan(0.05)
  })

  it('recovers a known finite (keystone) VP from clean segments', async () => {
    const { estimate_vanishing_point, vp_edge_angles } = await import('@pdf/vanishing_point')
    const true_v: readonly [number, number, number] = (() => {
      const px = 50_000, py = -80
      const norm = Math.hypot(px, py, 1)
      return [px / norm, py / norm, 1 / norm]
    })()
    const anchors = [[100, 100], [900, 100], [300, 900], [700, 1600], [500, 1755], [200, 300]] as const
    const segments = anchors.map(([x, y]) => segment_through_vp(true_v, x, y))
    const confidences = anchors.map(() => 0.99)
    const weights = anchors.map(() => 200 * 200)

    const result = estimate_vanishing_point(segments, confidences, weights)
    expect(result).not.toBeNull()
    const edges = vp_edge_angles(result!.v, segments)
    // This keystone's tb swing over the anchor range is a few degrees; lr swing is negligible
    // (px is far outside the frame) — matches the real trapezoid fixture's characterization.
    expect(Math.abs(edges.tb_delta)).toBeGreaterThan(0.5)
    expect(Math.abs(edges.lr_delta)).toBeLessThan(0.1)
  })

  it('PROSAC/MSAC stay robust to a minority of outlier segments', async () => {
    const { estimate_vanishing_point, local_angle_from_vp } = await import('@pdf/vanishing_point')
    const true_angle = -1.5
    const true_v: readonly [number, number, number] =
      [Math.cos(true_angle * Math.PI / 180), Math.sin(true_angle * Math.PI / 180), 0]
    const good_anchors = [[100, 200], [900, 300], [300, 900], [700, 1500], [500, 800], [200, 1200], [800, 600]] as const
    const segments = good_anchors.map(([x, y]) => segment_through_vp(true_v, x, y))
    const confidences = good_anchors.map(() => 0.99)
    const weights = good_anchors.map(() => 200 * 200)
    // 2 outliers at a wildly different angle, same confidence/weight as the inliers.
    segments.push([{ x: 100, y: 100 }, { x: 300, y: 900 }], [{ x: 900, y: 900 }, { x: 700, y: 100 }])
    confidences.push(0.99, 0.99)
    weights.push(200 * 200, 200 * 200)

    const result = estimate_vanishing_point(segments, confidences, weights)
    expect(result).not.toBeNull()
    const recovered_angle = local_angle_from_vp(result!.v, 500, 800)
    expect(Math.abs(recovered_angle - true_angle)).toBeLessThan(0.1)
  })

  it('folds a line orientation to (-90, 90] regardless of which sign the estimator returns', async () => {
    const { fold_line_angle } = await import('@pdf/vanishing_point')
    expect(fold_line_angle(0)).toBeCloseTo(0, 5)
    expect(fold_line_angle(179.9)).toBeCloseTo(-0.1, 5)
    expect(fold_line_angle(-179.9)).toBeCloseTo(0.1, 5)
    expect(fold_line_angle(90)).toBeCloseTo(90, 5)
  })

  it('returns null rather than throwing on too few segments', async () => {
    const { estimate_vanishing_point } = await import('@pdf/vanishing_point')
    expect(estimate_vanishing_point([], [], [])).toBeNull()
    expect(estimate_vanishing_point(
      [[{ x: 0, y: 0 }, { x: 1, y: 1 }]], [0.9], [1],
    )).toBeNull()
  })
})

describe('VP-based correction (spec-web §7.1b) — direct geometry, no DBNet', () => {
  let flat: any, skewed_2_3: any

  beforeAll(async () => {
    cv = await load_cv()
    flat = make_text_page()
    skewed_2_3 = rotate_mat_test(flat, 2.3)
  })

  it('a pure-rotation VP straightens a skewed page (re-measured via the classic-CV classifier)', async () => {
    const { apply_vp_correction } = await import('@pdf/vp_correct')
    const { estimate_deskew } = await import('@pdf/deskew')
    // VP constructed directly (not detected) — isolates the correction math from DBNet. Matches
    // estimate_deskew's own convention (verified by the "detects the injected rotation angle"
    // test above): a page rotated by +2.3deg is DETECTED at -2.3deg, and that detected value is
    // what a real pipeline would feed into the correction, not the +2.3deg that was injected.
    const detected_v: readonly [number, number, number] =
      [Math.cos(-2.3 * Math.PI / 180), Math.sin(-2.3 * Math.PI / 180), 0]
    const corrected = apply_vp_correction(skewed_2_3.clone(), detected_v)
    const { angle_deg } = estimate_deskew(corrected, DESKEW_CLASSIFY_DOWNSCALE_PX, DESKEW_MAX_DEG)
    corrected.delete()
    expect(Math.abs(angle_deg)).toBeLessThan(0.2)
  })

  it('runs well under the 1s/page budget for the correction step alone (spec-web §16)', async () => {
    const { apply_vp_correction } = await import('@pdf/vp_correct')
    const true_v: readonly [number, number, number] =
      [Math.cos(2.3 * Math.PI / 180), Math.sin(2.3 * Math.PI / 180), 0]
    const ms = bench(() => apply_vp_correction(skewed_2_3.clone(), true_v).delete(), 5)
    console.log(`[perf] VP correction remap: ${ms.toFixed(1)} ms/page @ ${PAGE_W}x${PAGE_H}`)
    if (ms >= 1000) {
      console.error(`[perf] FLAG: VP correction ${ms.toFixed(1)}ms exceeds the 1s/page budget`)
    }
    expect(ms).toBeLessThan(1000)
  })
})
