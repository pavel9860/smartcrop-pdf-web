// Scan-processing speed regression test (user #4/#7, task T4). Runs on demand via `npm run
// test:perf` (NOT part of the default `vitest run` — see vitest.perf.config.ts), because timing is
// machine-dependent and would flap in CI.
//
// It drives the REAL OpenCV.js SIMD build (vendor/opencv-js-simd) through the exact op sequence
// src/pdf/imaging.ts's clean_document_bilevel / detect path uses — illumination flatten (downscaled
// morphological close, §W2 row 12) → Sauvola (box-filtered local mean/std) → connected-components
// despeckle — on real-scan-sized rasters, and asserts the T4 budgets:
//   • B/W filter (and, by the same cost, Dewarp&Deskew's OpenCV half): < 500 ms/page
//   • Auto-detect:                                                       < 100 ms/page
// plus prints the ratio to a DESKTOP reference captured once (see DESKTOP_REF below).
//
// Timing is size-driven, not content-driven (morphology/box-filter/CC costs scale with pixel count,
// not with what's on the page), so a deterministic synthetic page sized like the desktop test assets
// (smartcrop-pdf-desktop/tests/assets, ~1240×1755) gives a representative per-page number without
// shipping a multi-MB image fixture. The web numbers this asserts were also confirmed end-to-end
// in a real browser (Playwright tests/e2e/scan_simd.spec.ts) on the larger 1653×2339 scan PDF.
import { describe, it, expect, beforeAll } from 'vitest'
import {
  BG_KERNEL_SIZE, BG_DOWNSCALE, SAUVOLA_WINDOW, SAUVOLA_R, BW_STRENGTH,
  CC_CONNECTIVITY, MIN_COMP_FRAC, DETECT_MAX_PX,
} from '@core/constants'

// DESKTOP REFERENCE — captured once on this machine with the desktop app's own stack
// (smartcrop-pdf-desktop/.venv: opencv-python 5.0.0, numpy) on tests/assets/test_pdf_distorted_
// page-0001.jpg (1240×1755), mean of 5 iters after 2 warmup, upscale=1.0 to match this web port:
//   • clean_document_bilevel (== B/W filter / detect binarization): ~190 ms/page
//   • pymupdf 200-page open+insert_pdf+save (native export assembly): ~104 ms total
// Reproduce: smartcrop-pdf-desktop/.venv/bin/python -c "import cv2,numpy,time; from core.imaging
// import clean_document_bilevel; ..." (see task T4 notes). These are constants, not re-measured
// here, so the ratio is stable and CI-safe.
const DESKTOP_REF = {
  filter_ms_per_page: 190,
  detect_ms_per_page: 190,   // desktop detect runs the same clean_document_bilevel, at ~full res
} as const

// Real-scan page size (matches the desktop test assets' long edge ≈ 1755).
const PAGE_W = 1240
const PAGE_H = 1755

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

// Deterministic document-like grayscale: mostly white page with sparse dark "ink".
function make_gray(w: number, h: number): any {
  const data = new Uint8Array(w * h)
  let s = 42
  for (let i = 0; i < data.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0
    const v = Math.floor((s / 0xffffffff) * 255)
    data[i] = v > 30 ? 255 : v
  }
  return cv.matFromArray(h, w, cv.CV_8UC1, Array.from(data))
}

// Faithful mirror of imaging.ts illumination_flatten (downscaled morphological-close background).
function flatten(gray: any): any {
  const scale = BG_DOWNSCALE
  const sw = Math.round(gray.cols / scale), sh = Math.round(gray.rows / scale)
  const k = Math.round(BG_KERNEL_SIZE / scale) | 1
  const small = new cv.Mat(); cv.resize(gray, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA)
  const se = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k))
  const bgs = new cv.Mat(); cv.morphologyEx(small, bgs, cv.MORPH_CLOSE, se)
  const bg = new cv.Mat(); cv.resize(bgs, bg, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_LINEAR)
  const gf = new cv.Mat(); gray.convertTo(gf, cv.CV_32F)
  const bf = new cv.Mat(); bg.convertTo(bf, cv.CV_32F, 1, 1e-6)
  const ratio = new cv.Mat(); cv.divide(gf, bf, ratio, 255)
  const flat = new cv.Mat(); ratio.convertTo(flat, cv.CV_8U)
  small.delete(); se.delete(); bgs.delete(); bg.delete(); gf.delete(); bf.delete(); ratio.delete()
  return flat
}

// Faithful mirror of imaging.ts sauvola_ink_mask.
function sauvola_ink(flat: any, win: number, k: number): any {
  const sz = new cv.Size(win | 1, win | 1), anchor = new cv.Point(-1, -1)
  const f32 = new cv.Mat(); flat.convertTo(f32, cv.CV_32F)
  const mean = new cv.Mat(); cv.boxFilter(f32, mean, cv.CV_32F, sz, anchor, true, cv.BORDER_REFLECT_101)
  const sq = new cv.Mat(); cv.multiply(f32, f32, sq); f32.delete()
  const sqm = new cv.Mat(); cv.boxFilter(sq, sqm, cv.CV_32F, sz, anchor, true, cv.BORDER_REFLECT_101); sq.delete()
  const ms = new cv.Mat(); cv.multiply(mean, mean, ms)
  const variance = new cv.Mat(); cv.subtract(sqm, ms, variance); sqm.delete(); ms.delete()
  cv.threshold(variance, variance, 0, 0, cv.THRESH_TOZERO)
  const std = new cv.Mat(); cv.sqrt(variance, std); variance.delete()
  const ta = new cv.Mat(); mean.convertTo(ta, cv.CV_32F, 1 - k, 0)
  const msd = new cv.Mat(); cv.multiply(mean, std, msd); std.delete(); mean.delete()
  const tb = new cv.Mat(); msd.convertTo(tb, cv.CV_32F, k / SAUVOLA_R, 0); msd.delete()
  const thr = new cv.Mat(); cv.add(ta, tb, thr); ta.delete(); tb.delete()
  const ff = new cv.Mat(); flat.convertTo(ff, cv.CV_32F)
  const diff = new cv.Mat(); cv.subtract(ff, thr, diff); ff.delete(); thr.delete()
  const mask = new cv.Mat(); cv.threshold(diff, mask, 0, 255, cv.THRESH_BINARY_INV); diff.delete()
  const u8 = new cv.Mat(); mask.convertTo(u8, cv.CV_8U); mask.delete()
  return u8
}

// Full clean_document_bilevel (imaging.ts): flatten → Sauvola → connected-components despeckle.
function clean_bilevel(gray: any, k: number, min_area: number): void {
  const flat = flatten(gray)
  const ink = sauvola_ink(flat, SAUVOLA_WINDOW, k); flat.delete()
  const labels = new cv.Mat(), stats = new cv.Mat(), ctr = new cv.Mat()
  cv.connectedComponentsWithStats(ink, labels, stats, ctr, CC_CONNECTIVITY, cv.CV_32S)
  const n = stats.rows
  const keep = new Uint8Array(n)
  for (let i = 1; i < n; i++) keep[i] = stats.intAt(i, cv.CC_STAT_AREA) >= min_area ? 1 : 0
  const ld = labels.data32S
  const out = new cv.Mat(ink.rows, ink.cols, cv.CV_8U); const od = out.data
  for (let p = 0; p < ld.length; p++) od[p] = keep[ld[p]] ? 255 : 0
  labels.delete(); stats.delete(); ctr.delete(); ink.delete(); out.delete()
}

function bench(fn: () => void, iters: number): number {
  for (let i = 0; i < 2; i++) fn()   // warmup
  const t0 = performance.now()
  for (let i = 0; i < iters; i++) fn()
  return (performance.now() - t0) / iters
}

describe('scan processing speed (T4 budgets)', () => {
  beforeAll(async () => { cv = await load_cv() })

  it('B/W filter pipeline < 500 ms/page (10-page pass)', () => {
    const gray = make_gray(PAGE_W, PAGE_H)
    const cfg = BW_STRENGTH[2]
    const min_area = Math.max(8, MIN_COMP_FRAC * PAGE_W * PAGE_H)
    const ms = bench(() => clean_bilevel(gray, cfg.k, min_area), 10)
    gray.delete()
    console.log(`[perf] B/W filter: ${ms.toFixed(1)} ms/page @ ${PAGE_W}×${PAGE_H}  ` +
      `(desktop ref ${DESKTOP_REF.filter_ms_per_page} ms → ${(ms / DESKTOP_REF.filter_ms_per_page).toFixed(2)}×)`)
    expect(ms).toBeLessThan(500)
  })

  it('Auto-detect pipeline < 100 ms/page', () => {
    // Detect downscales the raw page to DETECT_MAX_PX (long edge) before binarizing (imaging.ts
    // detect_content), so it runs the same clean_bilevel on a smaller raster.
    const gray_full = make_gray(PAGE_W, PAGE_H)
    const scale = Math.min(1, DETECT_MAX_PX / Math.max(PAGE_W, PAGE_H))
    const dw = Math.round(PAGE_W * scale), dh = Math.round(PAGE_H * scale)
    const gray = new cv.Mat(); cv.resize(gray_full, gray, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA)
    gray_full.delete()
    const cfg = BW_STRENGTH[2]
    const min_area = Math.max(8, MIN_COMP_FRAC * dw * dh)
    const ms = bench(() => clean_bilevel(gray, cfg.k, min_area), 10)
    gray.delete()
    console.log(`[perf] Auto-detect: ${ms.toFixed(1)} ms/page @ ${dw}×${dh}  ` +
      `(desktop ref ${DESKTOP_REF.detect_ms_per_page} ms → ${(ms / DESKTOP_REF.detect_ms_per_page).toFixed(2)}×)`)
    expect(ms).toBeLessThan(100)
  })
})
