// CropController tests (§18 AppModel decomposition, step 3/7): direct unit coverage of the
// anchors/offsets/keep-ratio/split/same-size + drag-gesture collaborator, independent of AppModel
// (which exercises it indirectly through its own extensive suite — this file targets the
// controller's own contract in isolation, constructed with a minimal mock CropContext).
import { describe, it, expect } from 'vitest'
import { CropController, type CropContext } from '@core/crop_controller'
import { History } from '@core/history'
import { default_document_state, type DocumentState } from '@core/document_state'
import type { Box } from '@core/geometry'
import type { PageSize } from '@core/model'

function ctx(overrides: Partial<CropContext> = {}): { doc: DocumentState; ctx: CropContext } {
  const doc = default_document_state()
  const c: CropContext = {
    document: () => doc,
    has_document: () => true,
    current_page: () => 0,
    page_dims: (): PageSize => ({ width: 200, height: 300 }),
    detected: () => null,
    union: () => null,
    auto_active: () => false,
    drawn: () => null,
    set_drawn: () => {},
    ...overrides,
  }
  return { doc, ctx: c }
}

function controller(overrides: Partial<CropContext> = {}): { c: CropController; doc: DocumentState } {
  const { doc, ctx: cc } = ctx(overrides)
  return { c: new CropController(new History(20), cc), doc }
}

describe('CropController anchors/offsets', () => {
  it('set_anchor updates only the non-null argument', () => {
    const { c } = controller()
    c.set_anchor(false, null)
    expect(c.anchor_left).toBe(false)
    expect(c.anchor_top).toBe(true)
    c.set_anchor(null, false)
    expect(c.anchor_left).toBe(false)
    expect(c.anchor_top).toBe(false)
  })

  it('set_offset clamps to +/-OFFSET_LIMIT and writes only the targeted edge', () => {
    const { c, doc } = controller()
    c.set_offset('L', 9999)
    expect(doc.offsets.left).toBeLessThan(9999)
    expect(doc.offsets.top).toBe(0)
  })

  it('commit_offsets is a no-op without both a detected box and a union', () => {
    const { c, doc } = controller()
    const before = doc.offsets
    c.commit_offsets()
    expect(doc.offsets).toEqual(before)
  })

  it('commit_offsets recomputes offsets from the live auto-crop rect when detection exists', () => {
    const detected: Box = { x0: 20, y0: 20, x1: 180, y1: 280 }
    const union: Box = { x0: 20, y0: 20, x1: 180, y1: 280 }
    const { c, doc } = controller({ detected: () => detected, union: () => union })
    c.commit_offsets()
    expect(doc.offsets.left).toBeCloseTo(0)
    expect(doc.offsets.top).toBeCloseTo(0)
  })
})

describe('CropController manual offsets (spec-web §4.6, replaces the old Advanced accordion)', () => {
  function manual_controller(): { c: CropController; drawn: () => Box | null } {
    let drawn: Box | null = null
    const { c } = controller({ drawn: () => drawn, set_drawn: (b) => { drawn = b } })
    return { c, drawn: () => drawn }
  }

  it('turning on seeds a default 10%-margin window via set_drawn', () => {
    const { c, drawn } = manual_controller()
    c.set_manual_offsets_on(true)
    expect(c.manual_offsets_on).toBe(true)
    expect(drawn()).toEqual({ x0: 20, y0: 30, x1: 180, y1: 270 })   // 10% of 200x300 each edge
    expect(c.manual_offsets()).toEqual({ left: 10, top: 10, right: 10, bottom: 10 })
  })

  it('turning off drops the window', () => {
    const { c, drawn } = manual_controller()
    c.set_manual_offsets_on(true)
    c.set_manual_offsets_on(false)
    expect(c.manual_offsets_on).toBe(false)
    expect(drawn()).toBeNull()
  })

  it('set_manual_offset updates one edge and recomputes the window; a no-op while off', () => {
    const { c, drawn } = manual_controller()
    c.set_manual_offset('L', 20)   // off — no window to move, no-op
    expect(drawn()).toBeNull()

    c.set_manual_offsets_on(true)
    c.set_manual_offset('L', 20)
    expect(c.manual_offsets()).toEqual({ left: 20, top: 10, right: 10, bottom: 10 })
    expect(drawn()!.x0).toBeCloseTo(40)   // 20% of page_w=200
  })

  it('clicking outside the manual window does not drop it (no free-draw replacement)', () => {
    const { c, drawn } = manual_controller()
    c.set_manual_offsets_on(true)
    const before = drawn()
    c.begin_drag(1, 1, 5)   // page corner, well outside the 20..180 x 30..270 window
    c.update_drag(50, 50)
    c.end_drag()
    expect(drawn()).toEqual(before)   // untouched — begin_drag was a no-op
  })

  it('a handle-drag still resizes the manual window', () => {
    const { c, drawn } = manual_controller()
    c.set_manual_offsets_on(true)
    c.begin_drag(20, 30, 5)   // top-left handle of the seeded window
    c.update_drag(10, 10)
    c.end_drag()
    expect(drawn()).not.toBeNull()
    expect(drawn()!.x0).toBeLessThan(20)
  })
})

describe('CropController.set_keep_ratio', () => {
  it('off->on with no explicit ratio pre-populates from _default_ratio (page aspect fallback)', () => {
    const { c } = controller()
    c.set_keep_ratio(true)
    expect(c.ratio).toBeCloseTo(200 / 300)
  })

  it('an explicit positive ratio always wins', () => {
    const { c } = controller()
    c.set_keep_ratio(true, 2.5)
    expect(c.ratio).toBe(2.5)
  })

  it('toggling on twice in a row (already on) does not re-populate the ratio', () => {
    const { c } = controller()
    c.set_keep_ratio(true, 2.5)
    c.set_keep_ratio(true)   // no explicit ratio, but was_off is now false
    expect(c.ratio).toBe(2.5)
  })
})

describe('CropController.set_split', () => {
  it('n===1 clears crop_rects; n=2/4 seeds a grid and clears applied+drawn', () => {
    let drawn_cleared = false
    const { c, doc } = controller({ set_drawn: (b) => { if (b === null) drawn_cleared = true } })
    doc.applied.set(0, [{ x0: 0, y0: 0, x1: 10, y1: 10 }])
    c.set_split(2)
    expect(c.split_count).toBe(2)
    expect(doc.crop_rects).toHaveLength(2)
    expect(doc.applied.size).toBe(0)
    expect(drawn_cleared).toBe(true)
  })

  it('is a no-op when n equals the current split_count', () => {
    const { c, doc } = controller()
    c.set_split(2)
    const before = doc.crop_rects
    c.set_split(2)
    expect(doc.crop_rects).toBe(before)   // same array reference -> truly untouched
  })

  it('re-derives the ratio from the fresh grid when keep-ratio is already on', () => {
    const { c } = controller()
    c.set_keep_ratio(true)
    c.set_split(2)
    const r = c.ratio
    expect(r).toBeGreaterThan(0)
  })
})

describe('CropController.set_same_size', () => {
  it('turning on normalizes every window to the first window\'s w x h, capped to headroom', () => {
    const { c, doc } = controller()
    doc.crop_rects = [
      { x0: 0, y0: 0, x1: 50, y1: 50 },
      { x0: 100, y0: 100, x1: 120, y1: 120 },
    ]
    c.set_same_size(true)
    expect(c.same_size).toBe(true)
    expect(doc.crop_rects[0]).toEqual({ x0: 0, y0: 0, x1: 50, y1: 50 })
    // second window keeps its own origin, resized to the first window's 50x50 (within headroom)
    expect(doc.crop_rects[1]!.x1 - doc.crop_rects[1]!.x0).toBeCloseTo(50)
  })

  it('turning off is a pure flag flip with no rect changes', () => {
    const { c, doc } = controller()
    doc.crop_rects = [{ x0: 0, y0: 0, x1: 50, y1: 50 }]
    c.set_same_size(true)
    const before = doc.crop_rects
    c.set_same_size(false)
    expect(c.same_size).toBe(false)
    expect(doc.crop_rects).toBe(before)
  })
})

describe('CropController drag gestures', () => {
  it('begin/update/end a draw drag commits a new drawn window (via set_drawn)', () => {
    let drawn: Box | null = null
    const { c } = controller({ set_drawn: (b) => { drawn = b } })
    c.begin_drag(10, 10, 5)
    c.update_drag(150, 250)
    c.end_drag()
    expect(drawn).not.toBeNull()
    expect(drawn!.x1 - drawn!.x0).toBeGreaterThan(0)
  })

  it('a draw smaller than 2*MIN_RECT in either dimension is discarded on end_drag', () => {
    let drawn: Box | null = null
    const { c } = controller({ set_drawn: (b) => { drawn = b } })
    c.begin_drag(10, 10, 5)
    c.update_drag(11, 11)   // 1x1 px drag
    c.end_drag()
    expect(drawn).toBeNull()
  })

  it('cancel_drag with no active drag drops a pending drawn window (Esc, bug 5)', () => {
    const drawn_calls: (Box | null)[] = []
    const { c } = controller({ set_drawn: (b) => { drawn_calls.push(b) } })
    c.cancel_drag()
    expect(drawn_calls).toEqual([null])
  })

  it('cancel_drag on a split resize restores every window from rects0', () => {
    const { c, doc } = controller()
    doc.crop_rects = [{ x0: 0, y0: 0, x1: 100, y1: 100 }, { x0: 100, y0: 0, x1: 200, y1: 100 }]
    c.set_split(2)
    // re-seed after set_split (which reseeds its own grid) so the test's exact rects apply
    doc.crop_rects = [{ x0: 0, y0: 0, x1: 100, y1: 100 }, { x0: 100, y0: 0, x1: 200, y1: 100 }]
    const before = doc.crop_rects.map(r => ({ ...r }))
    c.begin_drag(100, 50, 5)   // hits the shared handle between the two windows
    c.update_drag(150, 50)
    c.cancel_drag()
    expect(doc.crop_rects).toEqual(before)
  })

  it('update_drag with no active drag is a no-op', () => {
    const { c } = controller()
    expect(() => { c.update_drag(10, 10) }).not.toThrow()
  })

  it('a split-drag on the interior (move) never resizes any other window even with same_size on', () => {
    const { c, doc } = controller()
    c.set_split(2)
    doc.crop_rects = [{ x0: 0, y0: 0, x1: 100, y1: 100 }, { x0: 100, y0: 0, x1: 200, y1: 100 }]
    c.set_same_size(true)
    const before1 = { ...doc.crop_rects[1]! }
    c.begin_drag(50, 50, 5)   // interior of window0 -> move
    c.update_drag(60, 60)
    c.end_drag()
    expect(doc.crop_rects[1]).toEqual(before1)   // partner untouched by a move
  })
})

describe('CropController.reset', () => {
  it('resets every field to its default, including the given initial ratio', () => {
    const { c } = controller()
    c.set_split(2)
    c.set_keep_ratio(true, 3)
    c.set_anchor(false, false)
    c.set_same_size(true)
    c.reset(1.5)
    expect(c.split_count).toBe(1)
    expect(c.keep_ratio).toBe(false)
    expect(c.ratio).toBe(1.5)
    expect(c.anchor_left).toBe(true)
    expect(c.anchor_top).toBe(true)
    expect(c.same_size).toBe(false)
    expect(c.draw_rect).toBeNull()
  })
})
