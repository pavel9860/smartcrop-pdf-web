// Pure decision-function tests for Dewarp & Deskew (spec-web §7.1a/§7.1b). Deliberately separate
// from the OpenCV/DBNet-dependent computations (src/pdf/deskew.ts, dbnet.ts, vanishing_point.ts —
// validated by tests/perf/deskew_speed.test.ts against real opencv-js/onnxruntime-web + e2e against
// real fixtures) — this file only tests the pure arithmetic given already-computed numbers, same
// split as dewarp.ts's fp16 helpers vs. its ONNX-dependent apply_dewarp.
import { describe, it, expect } from 'vitest'
import { classify_warp, needs_skew_trapezoid_correction } from '@core/deskew_classify'
import { WARP_SHARPNESS_MIN, DESKEW_MIN_DEG, TRAP_DELTA_MIN_DEG } from '@core/constants'

describe('classify_warp (spec-web §7.1a)', () => {
  it('classifies WARPED when sharpness is below the cutoff', () => {
    expect(classify_warp(WARP_SHARPNESS_MIN - 0.01)).toBe(true)
    expect(classify_warp(0)).toBe(true)
  })

  it('classifies NOT WARPED when sharpness clears the cutoff (exclusive on the warped side)', () => {
    expect(classify_warp(WARP_SHARPNESS_MIN)).toBe(false)
    expect(classify_warp(WARP_SHARPNESS_MIN + 1)).toBe(false)
  })

  it('never throws on degenerate input', () => {
    expect(() => classify_warp(0)).not.toThrow()
    expect(() => classify_warp(-1)).not.toThrow()
  })
})

describe('needs_skew_trapezoid_correction (spec-web §7.1b)', () => {
  it('no-op when every axis is within its noise-floor threshold', () => {
    expect(needs_skew_trapezoid_correction(0, 0, 0)).toBe(false)
    expect(needs_skew_trapezoid_correction(DESKEW_MIN_DEG, TRAP_DELTA_MIN_DEG, TRAP_DELTA_MIN_DEG)).toBe(false)
    expect(needs_skew_trapezoid_correction(-DESKEW_MIN_DEG, -TRAP_DELTA_MIN_DEG, -TRAP_DELTA_MIN_DEG)).toBe(false)
  })

  it('corrects when the center angle alone exceeds DESKEW_MIN_DEG (pure skew)', () => {
    expect(needs_skew_trapezoid_correction(DESKEW_MIN_DEG + 0.01, 0, 0)).toBe(true)
    expect(needs_skew_trapezoid_correction(-(DESKEW_MIN_DEG + 0.01), 0, 0)).toBe(true)
  })

  it('corrects when lr_delta alone exceeds TRAP_DELTA_MIN_DEG (pure horizontal keystone)', () => {
    expect(needs_skew_trapezoid_correction(0, TRAP_DELTA_MIN_DEG + 0.01, 0)).toBe(true)
    expect(needs_skew_trapezoid_correction(0, -(TRAP_DELTA_MIN_DEG + 0.01), 0)).toBe(true)
  })

  it('corrects when tb_delta alone exceeds TRAP_DELTA_MIN_DEG (pure vertical keystone)', () => {
    expect(needs_skew_trapezoid_correction(0, 0, TRAP_DELTA_MIN_DEG + 0.01)).toBe(true)
    expect(needs_skew_trapezoid_correction(0, 0, -(TRAP_DELTA_MIN_DEG + 0.01))).toBe(true)
  })

  it('corrects when skew and trapezoid are combined, even if no single axis alone would trigger', () => {
    // Real trapezoid fixture pattern: center under threshold, tb over — still corrects (OR gate).
    expect(needs_skew_trapezoid_correction(DESKEW_MIN_DEG - 0.1, 0, TRAP_DELTA_MIN_DEG + 0.1)).toBe(true)
  })

  it('is symmetric in sign on every axis independently', () => {
    for (const [a, l, t] of [[0.6, 0, 0], [0, 0.8, 0], [0, 0, 0.8], [0.6, 0.8, 0.9]] as const) {
      expect(needs_skew_trapezoid_correction(a, l, t)).toBe(needs_skew_trapezoid_correction(-a, -l, -t))
    }
  })

  it('never throws on degenerate input', () => {
    expect(() => needs_skew_trapezoid_correction(0, 0, 0)).not.toThrow()
    expect(() => needs_skew_trapezoid_correction(NaN, 0, 0)).not.toThrow()
  })
})
