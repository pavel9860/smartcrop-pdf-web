// AppModel mouse gestures (spec-web §6.4–§6.9): drawn window, auto-frame drag, split windows with
// same-size mirroring, keep-ratio, and drawing over a committed page. Public interface only; handle
// coordinates come from the live overlay so hit-tests are exact. Pages are 200×300 unless stated.
import { describe, it, expect } from 'vitest'
import type { AppModel } from '@core/model'
import { Mode } from '@core/enums'
import type { Box } from '@core/geometry'
import { loaded, draw, boxes_of, split_rects, overlay_box } from './harness'

const ratio_of = (b: Box): number => (b.x1 - b.x0) / (b.y1 - b.y0)
const drawn = (m: AppModel): Box[] => boxes_of(m, 'committed')

describe('drawn window', () => {
  it('a draw creates it; a draw below 2·MIN_RECT is discarded', async () => {
    const m = await loaded()
    draw(m, 10, 10, 11, 11)
    expect(drawn(m)).toEqual([])
    draw(m, 10, 10, 150, 250)
    expect(drawn(m)).toEqual([{ x0: 10, y0: 10, x1: 150, y1: 250 }])
  })

  it('pressing inside moves it; moving into the page edge keeps its size', async () => {
    const m = await loaded()
    draw(m, 40, 40, 120, 140, 8)
    draw(m, 80, 90, 100, 110, 8)
    expect(drawn(m)).toEqual([{ x0: 60, y0: 60, x1: 140, y1: 160 }])
    draw(m, 100, 100, 600, 600, 8)
    expect(drawn(m)).toEqual([{ x0: 120, y0: 200, x1: 200, y1: 300 }])
  })

  it('a press outside drops it at once; Esc mid-draw leaves nothing', async () => {
    const m = await loaded()
    draw(m, 40, 50, 160, 250)
    m.begin_drag(20, 20, 8)
    expect(drawn(m)).toEqual([])
    m.update_drag(30, 30)
    m.cancel_drag()
    expect(drawn(m)).toEqual([])
  })

  it('Esc during a resize restores it; Esc with no drag drops it', async () => {
    const m = await loaded()
    draw(m, 40, 50, 160, 250)
    m.begin_drag(40, 50, 8)
    m.update_drag(80, 90)
    expect(drawn(m)).toEqual([{ x0: 80, y0: 90, x1: 160, y1: 250 }])
    m.cancel_drag()
    expect(drawn(m)).toEqual([{ x0: 40, y0: 50, x1: 160, y1: 250 }])
    m.cancel_drag()
    expect(drawn(m)).toEqual([])
  })

  it('an Esc with no drawn window and no drag deactivates the auto frame', async () => {
    const m = await loaded()
    await m.detect_content().result()
    m.cancel_drag()
    expect([m.auto_active, boxes_of(m, 'auto')]).toEqual([false, []])
  })
})

describe('auto-frame drag', () => {
  it('a corner drag resizes through the shared offsets; Esc restores them', async () => {
    const m = await loaded()
    await m.detect_content().result()
    const b = overlay_box(m, 'auto')
    m.begin_drag(b.x0, b.y0, 8)
    m.update_drag(b.x0 + 30, b.y0 + 30)
    m.cancel_drag()
    expect(m.offsets).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
    draw(m, b.x0, b.y0, b.x0 + 20, b.y0 + 30, 8)
    expect([m.auto_active, overlay_box(m, 'auto')]).toEqual([true, { x0: 40, y0: 50, x1: 180, y1: 280 }])
    expect(m.offsets).toEqual({ left: -10, top: -10, right: 0, bottom: 0 })
  })

  it('an interior drag moves the whole frame', async () => {
    const m = await loaded()
    await m.detect_content().result()
    draw(m, 100, 150, 90, 140, 8)
    expect(overlay_box(m, 'auto')).toEqual({ x0: 10, y0: 10, x1: 170, y1: 270 })
  })

  it('each completed drag is its own undo step', async () => {
    const m = await loaded({ page_h: 400 })
    await m.detect_content().result()
    const b1 = overlay_box(m, 'auto')
    draw(m, b1.x0, b1.y0, b1.x0 + 15, b1.y0 + 15, 8)
    const after_first = m.offsets
    const b2 = overlay_box(m, 'auto')
    draw(m, b2.x1, b2.y1, b2.x1 + 15, b2.y1 + 15, 8)
    expect(m.offsets).not.toEqual(after_first)
    m.undo()
    expect(m.offsets).toEqual(after_first)
  })

  it('a press away from every handle falls through to a new drawn window', async () => {
    const m = await loaded()
    await m.detect_content().result()
    draw(m, 1000, 1000, 150, 250, 3)
    expect(m.view_snapshot().overlay).toEqual([{ kind: 'committed', box: { x0: 150, y0: 250, x1: 200, y1: 300 } }])
  })
})

describe('split windows', () => {
  it('set_split seeds an even grid; the same count again changes nothing; 1 returns to one view per page', async () => {
    const m = await loaded()
    m.set_split(4)
    expect(split_rects(m)).toEqual([
      { x0: 0, y0: 0, x1: 100, y1: 150 }, { x0: 0, y0: 150, x1: 100, y1: 300 },
      { x0: 100, y0: 0, x1: 200, y1: 150 }, { x0: 100, y0: 150, x1: 200, y1: 300 },
    ])
    draw(m, 100, 150, 110, 160, 8)
    const moved = split_rects(m)
    m.set_split(4)
    expect(split_rects(m)).toEqual(moved)
    m.set_split(1)
    expect([m.split_count, m.view_total, m.view_snapshot().overlay]).toEqual([1, 3, []])
  })

  it('switching to split drops a committed single crop', async () => {
    const m = await loaded()
    await m.detect_content().result()
    m.apply_crop()
    m.set_split(2)
    expect([m.view_total, m.document.applied.size, m.view_snapshot().page_w]).toEqual([3, 0, 200])
  })

  it('a drag that misses every window does nothing; a resize is undoable', async () => {
    const m = await loaded()
    m.set_split(2)
    const before = split_rects(m)
    draw(m, 1000, 1000, 1001, 1001, 3)
    expect(split_rects(m)).toEqual(before)
    draw(m, 0, 0, 15, 15, 8)
    expect(split_rects(m)[0]).toEqual({ x0: 15, y0: 15, x1: 100, y1: 300 })
    m.undo()
    expect(split_rects(m)).toEqual(before)
  })

  it('same-size 2-split: a resize mirrors across the shared column, a move never propagates, Esc restores all', async () => {
    const m = await loaded()
    m.set_split(2); m.set_same_size(true)
    m.begin_drag(0, 150, 8); m.update_drag(10, 150)
    expect(split_rects(m)).toEqual([{ x0: 10, y0: 0, x1: 100, y1: 300 }, { x0: 100, y0: 0, x1: 190, y1: 300 }])
    m.cancel_drag()
    m.begin_drag(50, 0, 8); m.update_drag(50, 20); m.end_drag()
    expect(split_rects(m)).toEqual([{ x0: 0, y0: 20, x1: 100, y1: 300 }, { x0: 100, y0: 20, x1: 200, y1: 300 }])
    draw(m, 50, 150, 60, 150, 8)
    expect(split_rects(m)).toEqual([{ x0: 10, y0: 20, x1: 110, y1: 300 }, { x0: 100, y0: 20, x1: 200, y1: 300 }])
  })

  it('same-size 4-split: a top-edge drag mirrors per row and column; a move leaves the others alone', async () => {
    const m = await loaded()
    m.set_split(4); m.set_same_size(true)
    draw(m, 50, 0, 50, 10, 8)
    expect(split_rects(m)).toEqual([
      { x0: 0, y0: 10, x1: 100, y1: 150 }, { x0: 0, y0: 150, x1: 100, y1: 290 },
      { x0: 100, y0: 10, x1: 200, y1: 150 }, { x0: 100, y0: 150, x1: 200, y1: 290 },
    ])
    const others = split_rects(m).slice(1)
    draw(m, 50, 75, 60, 85, 8)
    expect(split_rects(m).slice(1)).toEqual(others)
  })

  it('same-size growth is capped at the tightest window\'s headroom instead of deforming a partner', async () => {
    const m = await loaded()
    m.set_split(2); m.set_same_size(true)
    draw(m, 130, 150, 90, 150, 8)
    expect(split_rects(m)[1]).toEqual({ x0: 60, y0: 0, x1: 160, y1: 300 })
    m.begin_drag(100, 150, 8); m.update_drag(250, 150)
    expect(split_rects(m)).toEqual([{ x0: 0, y0: 0, x1: 160, y1: 300 }, { x0: 0, y0: 0, x1: 160, y1: 300 }])
  })

  it('turning same-size on snaps every window to the first one\'s size, capped by each own origin', async () => {
    const grow = await loaded()
    grow.set_split(2)
    draw(grow, 200, 150, 170, 150, 8)
    grow.set_same_size(true)
    expect(split_rects(grow)).toEqual([{ x0: 0, y0: 0, x1: 100, y1: 300 }, { x0: 100, y0: 0, x1: 200, y1: 300 }])

    const cap = await loaded()
    cap.set_split(2)
    draw(cap, 100, 150, 150, 150, 8)
    cap.set_same_size(true)
    expect(split_rects(cap)).toEqual([{ x0: 0, y0: 0, x1: 100, y1: 300 }, { x0: 100, y0: 0, x1: 200, y1: 300 }])
  })
})

describe('keep ratio', () => {
  it('the ratio defaults to the first page aspect on load and when switched on with nothing drawn', async () => {
    const m = await loaded({ page_h: 400 })
    expect(m.ratio).toBeCloseTo(0.5)
    m.set_keep_ratio(true)
    expect([m.keep_ratio, m.ratio]).toEqual([true, 0.5])
  })

  it('switching on takes the ratio from the detection union, a drawn window, or a resized split window', async () => {
    const union = await loaded({ page_h: 400 })
    await union.detect_content().result()
    union.set_keep_ratio(true)
    expect(union.ratio).toBeCloseTo(160 / 360)

    const window = await loaded()
    draw(window, 20, 20, 120, 70)
    window.set_keep_ratio(true)
    expect(window.ratio).toBeCloseTo(2)

    const split = await loaded()
    split.set_split(2)
    draw(split, 100, 150, 180, 150, 8)
    split.set_keep_ratio(true)
    expect(split.ratio).toBeCloseTo(180 / 300)
  })

  it('an explicit ratio wins; a split change re-derives it from the fresh grid', async () => {
    const m = await loaded()
    m.set_keep_ratio(true, 1.75)
    expect(m.ratio).toBe(1.75)
    m.set_split(2)
    expect(m.ratio).toBeCloseTo(100 / 300)
  })

  it('a new draw, a drawn-window resize and a split resize all hold the ratio live, anchored opposite the handle', async () => {
    const fresh = await loaded({ page_w: 400, page_h: 400 })
    fresh.set_keep_ratio(true, 2)
    draw(fresh, 10, 10, 150, 250)
    expect(ratio_of(drawn(fresh)[0]!)).toBeCloseTo(2)

    const resize = await loaded({ page_w: 400, page_h: 400 })
    draw(resize, 50, 50, 250, 250)
    resize.set_keep_ratio(true, 2)
    resize.begin_drag(50, 50, 8); resize.update_drag(80, 80)
    const tl = drawn(resize)[0]!
    expect([tl.x1, tl.y1, ratio_of(tl)]).toEqual([250, 250, 2])

    const split = await loaded({ page_w: 400, page_h: 600 })
    split.set_split(2)
    split.set_keep_ratio(true, 1)
    split.begin_drag(200, 600, 10); split.update_drag(150, 300)
    expect(ratio_of(split_rects(split)[0]!)).toBeCloseTo(1)
  })

  it('a ratio-locked split window stops at the page wall instead of deforming', async () => {
    const m = await loaded({ page_w: 400, page_h: 120 })
    m.set_split(2)
    m.set_keep_ratio(true, 2)
    m.begin_drag(200, 120, 10); m.update_drag(300, 120)
    expect(split_rects(m)[0]).toEqual({ x0: 0, y0: 0, x1: 240, y1: 120 })
  })
})

describe('drawing on a committed page (spec-web §6.8)', () => {
  async function committed(mode = Mode.NORMAL): Promise<AppModel> {
    const m = await loaded({ mode })
    draw(m, 10, 10, 150, 250)
    m.apply_crop()
    return m
  }
  const view = (m: AppModel): unknown => {
    const s = m.view_snapshot()
    return { o: s.crop_origin, w: s.page_w, h: s.page_h, drawn: drawn(m) }
  }

  it('stays zoomed to the crop and shows the new window over it, identically in both modes', async () => {
    for (const mode of [Mode.NORMAL, Mode.SCANNED]) {
      const m = await committed(mode)
      expect(view(m)).toEqual({ o: { x: 10, y: 10 }, w: 140, h: 240, drawn: [] })
      draw(m, 30, 40, 120, 200)
      expect(view(m)).toEqual({ o: { x: 10, y: 10 }, w: 140, h: 240, drawn: [{ x0: 30, y0: 40, x1: 120, y1: 200 }] })
    }
  })

  it('only Crop commits the new window — same result as drawing it on the fresh page', async () => {
    const m = await committed()
    draw(m, 30, 40, 120, 200)
    m.apply_crop()
    expect(view(m)).toEqual({ o: { x: 30, y: 40 }, w: 90, h: 160, drawn: [] })
  })

  it('the committed crop is no drag target; a sub-minimum draw and Esc leave it intact', async () => {
    const m = await committed()
    draw(m, 150, 250, 140, 240, 6)
    draw(m, 60, 60, 62, 62)
    m.begin_drag(30, 40, 5); m.update_drag(120, 200); m.cancel_drag()
    expect(view(m)).toEqual({ o: { x: 10, y: 10 }, w: 140, h: 240, drawn: [] })
  })
})
