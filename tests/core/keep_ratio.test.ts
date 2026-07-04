import { describe, it, expect } from 'vitest'
import { keep_ratio_anchored, box_width, box_height, type Box } from '@core/geometry'

// spec-web §W2 row 9: a keep-ratio resize is anchored on the corner/edge OPPOSITE the dragged
// handle, so only the dragged side moves; edge drags grow the perpendicular axis about the centre.
describe('keep_ratio_anchored (§W2 row 9)', () => {
  const R = 2.0                                             // width:height locked at 2:1
  const box: Box = { x0: 100, y0: 100, x1: 300, y1: 260 }  // w=200, h=160

  it('BR drag anchors the top-left corner; height follows width', () => {
    const out = keep_ratio_anchored(box, R, 'BR', 1000, 1000)
    expect(out.x0).toBe(100); expect(out.y0).toBe(100)     // TL fixed
    expect(out.x1).toBe(300)                                // dragged x kept
    expect(out.y1).toBeCloseTo(100 + 200 / R)              // 200
    expect(box_width(out) / box_height(out)).toBeCloseTo(R)
  })

  it('TL drag anchors the bottom-right corner; only the dragged side moves', () => {
    const out = keep_ratio_anchored(box, R, 'TL', 1000, 1000)
    expect(out.x1).toBe(300); expect(out.y1).toBe(260)     // BR fixed (opposite corner)
    expect(out.x0).toBe(100)                                // dragged x kept
    expect(out.y0).toBeCloseTo(260 - 200 / R)              // 160
    expect(box_width(out) / box_height(out)).toBeCloseTo(R)
  })

  it('R edge anchors the left edge and grows height symmetric about the centre', () => {
    const out = keep_ratio_anchored(box, R, 'R', 1000, 1000)
    expect(out.x0).toBe(100); expect(out.x1).toBe(300)     // x unchanged by the ratio step
    const cy = (100 + 260) / 2, nh = 200 / R               // 180, 100
    expect(out.y0).toBeCloseTo(cy - nh / 2)                // 130
    expect(out.y1).toBeCloseTo(cy + nh / 2)                // 230
    expect(box_width(out) / box_height(out)).toBeCloseTo(R)
  })

  it('move preserves the box (a translation cannot break the ratio)', () => {
    expect(keep_ratio_anchored(box, R, 'move', 1000, 1000)).toEqual(box)
  })
})
