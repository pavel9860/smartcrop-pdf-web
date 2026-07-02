// geometry.ts branch edges: offset clamping, detection-union max tracking, keep-ratio
// double clamp (both page dimensions exceeded).
import { describe, it, expect } from 'vitest'
import { offsets_from_rect, detection_union, keep_ratio_normalise } from '@core/geometry'

describe('offsets_from_rect', () => {
  it('clamps every edge offset to +/-OFFSET_LIMIT', () => {
    const o = offsets_from_rect(
      { x0: -50, y0: -50, x1: 100, y1: 100 },
      { x0: 0, y0: 0, x1: 5, y1: 5 },
      { x0: 0, y0: 0, x1: 5, y1: 5 },
      10, 10, false, false)
    for (const v of [o.left, o.right, o.top, o.bottom]) {
      expect(Math.abs(v)).toBeLessThanOrEqual(100)
    }
  })
})

describe('detection_union', () => {
  it('tracks max width and height across boxes independently', () => {
    const u = detection_union([
      { x0: 0, y0: 0, x1: 10, y1: 10 },
      { x0: 2, y0: 1, x1: 22, y1: 6 },     // widest (20)
      { x0: 1, y0: 3, x1: 6, y1: 33 },     // tallest (30)
    ])
    expect(u.x1 - u.x0).toBe(20)
    expect(u.y1 - u.y0).toBe(30)
  })
  it('throws on an empty array', () => {
    expect(() => detection_union([])).toThrow(RangeError)
  })
})

describe('keep_ratio_normalise', () => {
  it('clamps both dimensions when the ratio box exceeds the page', () => {
    const b = keep_ratio_normalise({ x0: 0, y0: 0, x1: 200, y1: 0 }, 1, 50, 100)
    expect(b.y1).toBeLessThanOrEqual(100)
    expect(b.x1).toBeLessThanOrEqual(50)
  })
})
