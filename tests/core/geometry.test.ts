// Pure geometry tests (spec-web §6, §12, §17).
import { describe, it, expect } from 'vitest'
import {
  hit_handle, point_in_box, clamp_box_shift, clamp_box_drag, apply_handle_drag,
  auto_crop_rect, offsets_from_rect, detection_union, union_box, keep_ratio_normalise,
  keep_ratio_anchored, rotate_box_cw, rotate_box_ccw, to_native_frame, split_rects_grid, reindex_map,
  box_width, box_height, box_area,
  MIN_RECT, type Box,
} from '@core/geometry'
import type { Offsets } from '@core/document_state'

const ZERO_OFFSETS: Offsets = { left: 0, top: 0, right: 0, bottom: 0 }
const box = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0, y0, x1, y1 })

describe('box dimensions', () => {
  it('computes width/height/area', () => {
    const b = box(10, 20, 110, 70)
    expect(box_width(b)).toBe(100)
    expect(box_height(b)).toBe(50)
    expect(box_area(b)).toBe(5000)
  })
})

describe('hit_handle', () => {
  const b = box(100, 100, 200, 200)
  it('hits all 4 corners', () => {
    expect(hit_handle(b, 100, 100, 5)).toBe('TL')
    expect(hit_handle(b, 200, 100, 5)).toBe('TR')
    expect(hit_handle(b, 100, 200, 5)).toBe('BL')
    expect(hit_handle(b, 200, 200, 5)).toBe('BR')
  })
  it('hits all 4 edge midpoints', () => {
    expect(hit_handle(b, 150, 100, 5)).toBe('T')
    expect(hit_handle(b, 150, 200, 5)).toBe('B')
    expect(hit_handle(b, 100, 150, 5)).toBe('L')
    expect(hit_handle(b, 200, 150, 5)).toBe('R')
  })
  it('respects tolerance', () => {
    expect(hit_handle(b, 106, 100, 5)).not.toBe('TL')
    expect(hit_handle(b, 104, 100, 5)).toBe('TL')
  })
  it('returns move for interior click away from handles', () => {
    expect(hit_handle(b, 150, 150, 5)).toBe('move')
  })
  it('returns null outside the box', () => {
    expect(hit_handle(b, 500, 500, 5)).toBeNull()
  })
})

describe('point_in_box', () => {
  const b = box(0, 0, 100, 100)
  it('inside and on the border are true', () => {
    expect(point_in_box(b, 50, 50)).toBe(true)
    expect(point_in_box(b, 0, 0)).toBe(true)
    expect(point_in_box(b, 100, 100)).toBe(true)
  })
  it('outside is false', () => {
    expect(point_in_box(b, 101, 50)).toBe(false)
  })
})

describe('clamp_box_shift', () => {
  it('leaves an in-bounds box unchanged', () => {
    const b = box(10, 10, 60, 60)
    expect(clamp_box_shift(b, 200, 200)).toEqual(b)
  })
  it('shifts a negative-origin box inward, preserving size', () => {
    const b = box(-10, -5, 40, 45)
    const r = clamp_box_shift(b, 200, 200)
    expect(box_width(r)).toBeCloseTo(50)
    expect(box_height(r)).toBeCloseTo(50)
    expect(r.x0).toBe(0)
    expect(r.y0).toBe(0)
  })
  it('shifts an overhanging box inward, never shrinking W/H unless W/H > page', () => {
    const b = box(150, 150, 250, 250)   // 100x100, page is 200x200
    const r = clamp_box_shift(b, 200, 200)
    expect(box_width(r)).toBeCloseTo(100)
    expect(box_height(r)).toBeCloseTo(100)
    expect(r.x1).toBe(200)
    expect(r.y1).toBe(200)
  })
  it('shrinks only when the box itself exceeds the page', () => {
    const b = box(-50, 0, 250, 100)   // 300 wide, page is 200 wide
    const r = clamp_box_shift(b, 200, 200)
    expect(r.x0).toBe(0)
    expect(r.x1).toBe(200)
  })
})

describe('clamp_box_drag', () => {
  it('clamps each edge independently to the page', () => {
    const r = clamp_box_drag(box(-20, -20, 50, 50), 200, 200)
    expect(r.x0).toBe(0)
    expect(r.y0).toBe(0)
  })
  it('enforces MIN_RECT, never inverting', () => {
    const r = clamp_box_drag(box(195, 195, 196, 196), 200, 200)
    expect(box_width(r)).toBeGreaterThanOrEqual(MIN_RECT - 1e-9)
    expect(box_height(r)).toBeGreaterThanOrEqual(MIN_RECT - 1e-9)
    expect(r.x1).toBeGreaterThan(r.x0)
    expect(r.y1).toBeGreaterThan(r.y0)
  })
  it('result is always within the page', () => {
    const r = clamp_box_drag(box(-999, -999, 999, 999), 200, 200)
    expect(r.x0).toBeGreaterThanOrEqual(0)
    expect(r.y0).toBeGreaterThanOrEqual(0)
    expect(r.x1).toBeLessThanOrEqual(200)
    expect(r.y1).toBeLessThanOrEqual(200)
  })
})

describe('apply_handle_drag', () => {
  const rect0 = box(50, 50, 150, 150)
  it('each of the 8 handles moves only its own edge(s); opposite edges stay pixel-stable', () => {
    const cases: Array<[import('@core/geometry').HandleId, [number, number], Partial<Box>]> = [
      ['TL', [10, 10], { x1: 150, y1: 150 } ],
      ['TR', [10, 10], { x0: 50, y1: 150 } ],
      ['BL', [10, 10], { x1: 150, y0: 50 } ],
      ['BR', [10, 10], { x0: 50, y0: 50 } ],
      ['T',  [0, 10],  { x0: 50, x1: 150, y1: 150 } ],
      ['B',  [0, 10],  { x0: 50, x1: 150, y0: 50 } ],
      ['L',  [10, 0],  { y0: 50, y1: 150, x1: 150 } ],
      ['R',  [10, 0],  { y0: 50, y1: 150, x0: 50 } ],
    ]
    for (const [handle, delta, fixed] of cases) {
      const r = apply_handle_drag(handle, rect0, [0, 0], delta, 1000, 1000)
      for (const [k, v] of Object.entries(fixed)) {
        expect(r[k as keyof Box], `handle ${handle} field ${k}`).toBeCloseTo(v)
      }
    }
  })
  it('move translates the whole box, preserving size', () => {
    const r = apply_handle_drag('move', rect0, [0, 0], [20, -10], 1000, 1000)
    expect(box_width(r)).toBeCloseTo(box_width(rect0))
    expect(box_height(r)).toBeCloseTo(box_height(rect0))
    expect(r.x0).toBeCloseTo(70)
    expect(r.y0).toBeCloseTo(40)
  })
  it('result is always clamped onto the page', () => {
    const r = apply_handle_drag('BR', rect0, [0, 0], [10000, 10000], 200, 200)
    expect(r.x1).toBeLessThanOrEqual(200)
    expect(r.y1).toBeLessThanOrEqual(200)
  })
})

describe('detection_union (spec-web §5)', () => {
  it('size is max(width)/max(height), not the bounding span', () => {
    const boxes = [box(0, 0, 100, 40), box(10, 10, 60, 90)]
    const u = detection_union(boxes)
    // max width = 100 (from box 1), max height = 80 (from box 2)
    expect(box_width(u)).toBe(100)
    expect(box_height(u)).toBe(80)
  })
  it('position is the top-left corner (min x0, min y0)', () => {
    const boxes = [box(20, 5, 120, 55), box(5, 30, 55, 80)]
    const u = detection_union(boxes)
    expect(u.x0).toBe(5)
    expect(u.y0).toBe(5)
  })
  it('throws on an empty array', () => {
    expect(() => detection_union([])).toThrow()
  })
})

describe('detection_union outlier tolerance (spec-web §5, #11)', () => {
  // Widths 100/80/60/40/20, heights 40/90/30/10/70 — deliberately uncorrelated so W/H are
  // picked independently across pages.
  const boxes = [
    box(0, 0, 100, 40),   // w=100 h=40
    box(0, 0, 80, 90),    // w=80  h=90
    box(0, 0, 60, 30),    // w=60  h=30
    box(0, 0, 40, 10),    // w=40  h=10
    box(0, 0, 20, 70),    // w=20  h=70
  ]

  it('outlier=0 reproduces the plain max (backward-compatible default)', () => {
    const u = detection_union(boxes, 0)
    expect(box_width(u)).toBe(100)
    expect(box_height(u)).toBe(90)
  })

  it('outlier=1 uses the 2nd-largest width and 2nd-largest height, independently', () => {
    const u = detection_union(boxes, 1)
    // widths desc: 100,80,60,40,20 -> 2nd = 80. heights desc: 90,70,40,30,10 -> 2nd = 70.
    expect(box_width(u)).toBe(80)
    expect(box_height(u)).toBe(70)
  })

  it('outlier >= len-1 uses the smallest width/height', () => {
    const u = detection_union(boxes, 10)   // clamped to len-1 = 4
    expect(box_width(u)).toBe(20)
    expect(box_height(u)).toBe(10)
  })

  it('gL/gT (the min corner) are unaffected by outlier', () => {
    const b = [box(20, 5, 120, 55), box(5, 30, 55, 80)]
    const u0 = detection_union(b, 0)
    const u1 = detection_union(b, 1)
    expect(u0.x0).toBe(5)
    expect(u0.y0).toBe(5)
    expect(u1.x0).toBe(5)
    expect(u1.y0).toBe(5)
  })
})

describe('union_box (standard bounding box)', () => {
  it('is the min/max bounding span of all boxes', () => {
    const boxes = [box(0, 0, 50, 50), box(30, 30, 100, 40)]
    const u = union_box(boxes)
    expect(u).toEqual(box(0, 0, 100, 50))
  })

  it('throws on an empty array (no meaningful union of nothing)', () => {
    expect(() => union_box([])).toThrow(RangeError)
  })
})

describe('keep_ratio_anchored (spec-web §W2 row 9, live resize anchored opposite the handle)', () => {
  const b = box(40, 40, 140, 90)   // W=100, H=50 -> ratio 2

  it('L and R edge drags both grow symmetrically about the centre, anchored on the fixed side', () => {
    const r = keep_ratio_anchored(b, 2, 'R', 1000, 1000)
    const l = keep_ratio_anchored(b, 2, 'L', 1000, 1000)
    expect(r.x0).toBeCloseTo(b.x0)   // R drag: left edge fixed, right edge follows
    expect(l.x1).toBeCloseTo(b.x1)   // L drag: right edge fixed, left edge follows
  })

  it('T and B edge drags both grow symmetrically about the centre, anchored on the fixed side', () => {
    const t = keep_ratio_anchored(b, 2, 'T', 1000, 1000)
    const bb = keep_ratio_anchored(b, 2, 'B', 1000, 1000)
    expect(t.y1).toBeCloseTo(b.y1)   // T drag: bottom edge fixed, top edge follows
    expect(bb.y0).toBeCloseTo(b.y0)  // B drag: top edge fixed, bottom edge follows
  })

  it('a move (no resize) is a no-op beyond page clamping', () => {
    expect(keep_ratio_anchored(b, 2, 'move', 1000, 1000)).toEqual(b)
  })
})

describe('auto_crop_rect (spec §9.2)', () => {
  const union = box(10, 10, 110, 60)   // W=100, H=50
  it('anchor ON uses this page content edge; anchor OFF uses the union edge', () => {
    const detected = box(30, 5, 999, 999)   // only x0/y0 matter for anchoring
    const on  = auto_crop_rect(detected, union, ZERO_OFFSETS, 1000, 1000, true, true)
    const off = auto_crop_rect(detected, union, ZERO_OFFSETS, 1000, 1000, false, false)
    expect(on.x0).toBeCloseTo(30)
    expect(on.y0).toBeCloseTo(5)
    expect(off.x0).toBeCloseTo(10)
    expect(off.y0).toBeCloseTo(10)
  })
  it('constant W×H regardless of anchor', () => {
    const detected = box(30, 5, 999, 999)
    const on  = auto_crop_rect(detected, union, ZERO_OFFSETS, 1000, 1000, true, true)
    expect(box_width(on)).toBeCloseTo(100)
    expect(box_height(on)).toBeCloseTo(50)
  })
  it('each offset moves exactly one edge (no opposite-edge coupling)', () => {
    const detected = box(10, 10, 999, 999)
    const base = auto_crop_rect(detected, union, ZERO_OFFSETS, 1000, 1000, false, false)
    // Small offset (0.5% of 1000 = 5 units) so left_base - offset stays positive and
    // clamp_box_shift's boundary-shift doesn't kick in — this test isolates the
    // one-edge-per-offset formula, not the separate overhang-clamping behavior above.
    const leftOnly: Offsets = { left: 0.5, top: 0, right: 0, bottom: 0 }
    const moved = auto_crop_rect(detected, union, leftOnly, 1000, 1000, false, false)
    expect(moved.x0).toBeLessThan(base.x0)      // left offset pushes left edge outward
    expect(moved.x1).toBeCloseTo(base.x1)       // right edge untouched
    expect(moved.y0).toBeCloseTo(base.y0)
    expect(moved.y1).toBeCloseTo(base.y1)
  })
  it('an overhanging frame is shifted inward (opposite edge extends), never shrunk', () => {
    // Anchor far right/bottom on a small page so the union-sized box would overhang.
    const detected = box(180, 180, 999, 999)
    const r = auto_crop_rect(detected, union, ZERO_OFFSETS, 200, 200, true, true)
    expect(box_width(r)).toBeCloseTo(100)
    expect(box_height(r)).toBeCloseTo(50)
    expect(r.x1).toBeLessThanOrEqual(200)
    expect(r.y1).toBeLessThanOrEqual(200)
  })
})

describe('offsets_from_rect', () => {
  it('round-trips with auto_crop_rect for a zero-offset rect', () => {
    const union = box(10, 10, 110, 60)
    const detected = box(10, 10, 999, 999)
    const rect = auto_crop_rect(detected, union, ZERO_OFFSETS, 1000, 1000, false, false)
    const back = offsets_from_rect(rect, detected, union, 1000, 1000, false, false)
    expect(back.left).toBeCloseTo(0, 5)
    expect(back.top).toBeCloseTo(0, 5)
    expect(back.right).toBeCloseTo(0, 5)
    expect(back.bottom).toBeCloseTo(0, 5)
  })
})

describe('keep_ratio_normalise (spec §9.7)', () => {
  it('locks height = width / ratio, anchored at top-left', () => {
    const b = box(0, 0, 100, 30)
    const r = keep_ratio_normalise(b, 2, 1000, 1000)   // ratio 2 -> h = w/2 = 50
    expect(r.x0).toBe(0); expect(r.y0).toBe(0)
    expect(box_width(r)).toBeCloseTo(100)
    expect(box_height(r)).toBeCloseTo(50)
  })
  it('clamps to the page and follows the opposite dimension, never inverting', () => {
    const b = box(0, 0, 100, 10)
    const r = keep_ratio_normalise(b, 0.1, 50, 50)   // would want h=1000, page is 50
    expect(r.y1).toBeLessThanOrEqual(50)
    expect(r.x1).toBeLessThanOrEqual(50)
    expect(r.x1).toBeGreaterThan(r.x0)
    expect(r.y1).toBeGreaterThan(r.y0)
  })
})

describe('rotate_box_cw (spec §13)', () => {
  it('maps (x,y) -> (h-y, x) into the rotated h×w page', () => {
    const b = box(10, 20, 30, 40)
    const page_h = 100
    const r = rotate_box_cw(b, page_h)
    expect(r).toEqual(box(page_h - 40, 10, page_h - 20, 30))
  })
  it('four applications return the original box (crops survive full rotation)', () => {
    const page_w = 210, page_h = 297
    let b = box(10, 20, 80, 90)
    let w = page_w, h = page_h
    for (let i = 0; i < 4; i++) {
      b = rotate_box_cw(b, h)
      ;[w, h] = [h, w]
    }
    expect(b.x0).toBeCloseTo(10)
    expect(b.y0).toBeCloseTo(20)
    expect(b.x1).toBeCloseTo(80)
    expect(b.y1).toBeCloseTo(90)
  })
})

describe('rotate_box_ccw (algebraic inverse of rotate_box_cw)', () => {
  it('undoes exactly one CW step: rotate_box_ccw(rotate_box_cw(box, h), h) === box', () => {
    const page_h = 297
    const b = box(10, 20, 80, 90)
    const rotated = rotate_box_cw(b, page_h)
    // rotate_box_ccw's page_w is the CURRENT (post-CW) box's page width, which equals the
    // original page_h passed to rotate_box_cw (per its own doc comment).
    const back = rotate_box_ccw(rotated, page_h)
    expect(back.x0).toBeCloseTo(b.x0)
    expect(back.y0).toBeCloseTo(b.y0)
    expect(back.x1).toBeCloseTo(b.x1)
    expect(back.y1).toBeCloseTo(b.y1)
  })

  it('composes with rotate_box_cw for an arbitrary width/height page too', () => {
    const page_h = 150
    const b = box(5, 5, 100, 60)
    const rotated = rotate_box_cw(b, page_h)   // rotated page is now page_h wide
    const back = rotate_box_ccw(rotated, page_h)
    expect(back).toEqual(b)
  })
})

describe('to_native_frame (spec-web §10.3, vector export)', () => {
  it('rotation=0 is the identity — box is already in the native frame', () => {
    const b = box(10, 20, 80, 90)
    expect(to_native_frame(b, 200, 300, 0)).toEqual(b)
  })

  it('rotation=90 undoes exactly one rotate_box_cw step', () => {
    const page_w = 200, page_h = 300
    const b = box(10, 20, 80, 90)
    // The box as it would appear after the app rotated the page 90 CW once.
    const current = rotate_box_cw(b, page_h)
    const native = to_native_frame(current, page_h, page_w, 90)   // current page is page_h x page_w
    expect(native.x0).toBeCloseTo(b.x0)
    expect(native.y0).toBeCloseTo(b.y0)
    expect(native.x1).toBeCloseTo(b.x1)
    expect(native.y1).toBeCloseTo(b.y1)
  })

  it('rotation=180/270 walk back the corresponding number of CW steps, and 360 is a no-op', () => {
    const page_w = 200, page_h = 300
    const b = box(10, 20, 80, 90)
    let current = b, w = page_w, h = page_h
    for (let step = 1; step <= 3; step++) {
      current = rotate_box_cw(current, h)
      ;[w, h] = [h, w]
      const native = to_native_frame(current, w, h, step * 90)
      expect(native.x0).toBeCloseTo(b.x0)
      expect(native.y0).toBeCloseTo(b.y0)
      expect(native.x1).toBeCloseTo(b.x1)
      expect(native.y1).toBeCloseTo(b.y1)
    }
    // 360 normalises to 0 — identity, regardless of page dims passed.
    expect(to_native_frame(b, page_w, page_h, 360)).toEqual(b)
  })

  it('normalises an out-of-range rotation (e.g. negative) into [0,360) before stepping', () => {
    const page_w = 200, page_h = 300
    const b = box(10, 20, 80, 90)
    // -270 normalises to 90.
    const current = rotate_box_cw(b, page_h)
    const native = to_native_frame(current, page_h, page_w, -270)
    expect(native.x0).toBeCloseTo(b.x0)
    expect(native.y0).toBeCloseTo(b.y0)
  })
})

describe('split_rects_grid (spec §7.3, §9.6)', () => {
  it('n=1 is the whole page', () => {
    expect(split_rects_grid(1, 200, 100)).toEqual([box(0, 0, 200, 100)])
  })
  it('n=2 splits left/right evenly', () => {
    const r = split_rects_grid(2, 200, 100)
    expect(r).toHaveLength(2)
    expect(r[0]).toEqual(box(0, 0, 100, 100))
    expect(r[1]).toEqual(box(100, 0, 200, 100))
  })
  it('n=4 is an even 2x2 grid in reading order (TL, BL, TR, BR)', () => {
    const r = split_rects_grid(4, 200, 100)
    expect(r).toHaveLength(4)
    expect(r[0]).toEqual(box(0, 0, 100, 50))
    expect(r[1]).toEqual(box(0, 50, 100, 100))
    expect(r[2]).toEqual(box(100, 0, 200, 50))
    expect(r[3]).toEqual(box(100, 50, 200, 100))
  })
})

describe('reindex_map (spec §13 delete)', () => {
  it('drops deleted keys and shifts surviving keys down', () => {
    const m = new Map<number, string>([[0, 'a'], [1, 'b'], [2, 'c'], [3, 'd']])
    const r = reindex_map(m, [1])   // delete page 1
    expect([...r.entries()].sort()).toEqual([[0, 'a'], [1, 'c'], [2, 'd']])
  })
  it('handles multiple deletions (shift = count of deleted indices below each surviving key)', () => {
    const m = new Map<number, string>([[0, 'a'], [2, 'c'], [4, 'e']])
    const r = reindex_map(m, [0, 3])
    // key 2: one deleted index (0) below it -> 2-1=1. key 4: two deleted indices (0,3) below it -> 4-2=2.
    expect([...r.entries()].sort()).toEqual([[1, 'c'], [2, 'e']])
  })
})
