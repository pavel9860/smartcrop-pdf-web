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

// frozen §9.7: "a ratio-constrained edge that would leave the page is clamped to the page and
// the opposite dimension follows, never inverting the box." keep_ratio_anchored previously just
// let its final clamp_box_drag() clamp the ratio-derived edge without touching the other
// dimension, deforming the ratio instead of preserving it (bug: 2-split window >50% page width).
describe('keep_ratio_anchored — ratio-preserving clamp at the page wall', () => {
  const R = 1.0   // square lock
  const box: Box = { x0: 0, y0: 0, x1: 150, y1: 100 }   // w=150, h=100

  it('BR: height would exceed the page — clamps y1 and shrinks x1 back to hold the ratio', () => {
    const out = keep_ratio_anchored(box, R, 'BR', 200, 120)   // target h = w/R = 150 > page_h 120
    expect(out.x0).toBe(0); expect(out.y0).toBe(0)            // TL anchor unchanged
    expect(out.y1).toBe(120)                                  // clamped to the page
    expect(out.x1).toBeCloseTo(120)                           // width shrunk to match (ratio held)
    expect(box_width(out) / box_height(out)).toBeCloseTo(R)
  })

  it('BL: height would exceed the page — clamps y1 and pulls x0 in, TR anchor unchanged', () => {
    const b: Box = { x0: 50, y0: 0, x1: 200, y1: 100 }        // w=150, h=100, anchor (x1=200,y0=0)
    const out = keep_ratio_anchored(b, R, 'BL', 200, 120)
    expect(out.x1).toBe(200); expect(out.y0).toBe(0)
    expect(out.y1).toBe(120)
    expect(out.x0).toBeCloseTo(80)                            // 200 - 120
    expect(box_width(out) / box_height(out)).toBeCloseTo(R)
  })

  it('TR: height would go past the top — clamps y0 and pulls x1 in, BL anchor unchanged', () => {
    const b: Box = { x0: 0, y0: 20, x1: 150, y1: 120 }         // w=150, h=100, anchor (x0=0,y1=120)
    const out = keep_ratio_anchored(b, R, 'TR', 200, 200)
    expect(out.x0).toBe(0); expect(out.y1).toBe(120)
    expect(out.y0).toBe(0)                                     // clamped to the top
    expect(out.x1).toBeCloseTo(120)
    expect(box_width(out) / box_height(out)).toBeCloseTo(R)
  })

  it('TL: height would go past the top — clamps y0 and pulls x0 in, BR anchor unchanged', () => {
    const b: Box = { x0: 50, y0: 20, x1: 200, y1: 120 }        // w=150, h=100, anchor (x1=200,y1=120)
    const out = keep_ratio_anchored(b, R, 'TL', 200, 200)
    expect(out.x1).toBe(200); expect(out.y1).toBe(120)
    expect(out.y0).toBe(0)
    expect(out.x0).toBeCloseTo(80)
    expect(box_width(out) / box_height(out)).toBeCloseTo(R)
  })

  it('R edge: symmetric growth would leave the page — height capped, width follows inward from R', () => {
    const b: Box = { x0: 0, y0: 40, x1: 150, y1: 60 }   // w=150, h=20, cy=50, page_h=120 -> room 2*min(50,70)=100
    const out = keep_ratio_anchored(b, R, 'R', 200, 120)   // target h = w/R = 150 > 100 available
    expect(box_height(out)).toBeCloseTo(100)
    expect(out.x0).toBe(0)                                 // anchor (left edge) unchanged
    expect(box_width(out)).toBeCloseTo(100)                // ratio held: w == h
    expect(box_width(out) / box_height(out)).toBeCloseTo(R)
  })

  it('T edge: symmetric growth would leave the page — width capped, height follows inward from T', () => {
    const b: Box = { x0: 40, y0: 0, x1: 60, y1: 150 }   // h=150, w=20, cx=50, page_w=120 -> room 100
    const out = keep_ratio_anchored(b, R, 'T', 120, 200)
    expect(box_width(out)).toBeCloseTo(100)
    expect(out.y1).toBe(150)                               // anchor (bottom edge) unchanged
    expect(box_height(out)).toBeCloseTo(100)
    expect(box_width(out) / box_height(out)).toBeCloseTo(R)
  })
})
