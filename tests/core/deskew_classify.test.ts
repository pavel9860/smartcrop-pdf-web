// Pure decision-function tests for the Dewarp & Deskew warp classifier (spec-web §7.1a).
// Deliberately separate from the OpenCV-dependent angle/sharpness computation (src/pdf/deskew.ts,
// validated by tests/perf/deskew_speed.test.ts against real opencv-js + tests/e2e against real
// fixtures) — this file only tests the pure arithmetic given already-computed numbers, same split
// as dewarp.ts's fp16 helpers vs. its ONNX-dependent apply_dewarp.
import { describe, it, expect } from 'vitest'
import { classify_deskew } from '@core/deskew_classify'
import { DESKEW_MIN_DEG, WARP_SHARPNESS_MIN } from '@core/constants'

describe('classify_deskew (spec-web §7.1a decision tree)', () => {
  it('classifies WARPED when sharpness is below the cutoff, regardless of angle', () => {
    expect(classify_deskew(0, WARP_SHARPNESS_MIN - 0.01)).toBe('warped')
    expect(classify_deskew(10, WARP_SHARPNESS_MIN - 0.01)).toBe('warped')
    expect(classify_deskew(-10, 0.1)).toBe('warped')
  })

  it('classifies FLAT when sharpness clears the cutoff and |angle| is at or below DESKEW_MIN_DEG', () => {
    expect(classify_deskew(0, WARP_SHARPNESS_MIN)).toBe('flat')
    expect(classify_deskew(DESKEW_MIN_DEG, WARP_SHARPNESS_MIN)).toBe('flat')
    expect(classify_deskew(-DESKEW_MIN_DEG, WARP_SHARPNESS_MIN)).toBe('flat')
  })

  it('classifies SKEWED when sharpness clears the cutoff and |angle| exceeds DESKEW_MIN_DEG', () => {
    expect(classify_deskew(DESKEW_MIN_DEG + 0.01, WARP_SHARPNESS_MIN)).toBe('skewed')
    expect(classify_deskew(-(DESKEW_MIN_DEG + 0.01), 5)).toBe('skewed')
    expect(classify_deskew(1.82, 1.5)).toBe('skewed')
  })

  it('sharpness cutoff is exclusive on the warped side (>= WARP_SHARPNESS_MIN is not warped)', () => {
    expect(classify_deskew(0, WARP_SHARPNESS_MIN)).not.toBe('warped')
  })

  it('angle cutoff is inclusive on the flat side (exactly DESKEW_MIN_DEG is flat, not skewed)', () => {
    expect(classify_deskew(DESKEW_MIN_DEG, WARP_SHARPNESS_MIN + 1)).toBe('flat')
  })

  it('treats angle sign symmetrically', () => {
    for (const a of [0.05, 0.19, 0.21, 1.82, 14.9]) {
      expect(classify_deskew(a, 2)).toBe(classify_deskew(-a, 2))
    }
  })

  it('sharpness=0 (fully blurred profile, degenerate empty page) classifies warped, never crashes', () => {
    expect(classify_deskew(0, 0)).toBe('warped')
    expect(() => classify_deskew(0, 0)).not.toThrow()
  })
})
