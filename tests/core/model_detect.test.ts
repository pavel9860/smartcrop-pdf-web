// AppModel Auto-detect, union aggregation, Crop and anchors (spec-web §4.5, §5, §6.2, §10.2) —
// public interface only.
import { describe, it, expect } from 'vitest'
import type { AppModel, PageSize } from '@core/model'
import { Mode, PagesMode } from '@core/enums'
import { Ok, Failed } from '@core/batch'
import { InvalidSplitError } from '@core/errors'
import type { Box } from '@core/geometry'
import { make_adapter, spy, n_calls, loaded, draw, select, boxes_of, split_rects, overlay_box } from './harness'

const ZERO = { left: 0, top: 0, right: 0, bottom: 0 }

// NORMAL document whose text layer reports `boxes[p]` (null = no usable text) for each page.
function with_text(boxes: (Box | null)[], sizes?: PageSize[], outlier = 0): Promise<AppModel> {
  const page_sizes = sizes ?? boxes.map(() => ({ width: 200, height: 300 }))
  return loaded({ ...make_adapter({ page_sizes }), detect_text_box: p => Promise.resolve(boxes[p] ?? null) })
    .then(m => { m.set_detect_outlier_pages(outlier); return m })
}

describe('Auto-detect', () => {
  it('shows a live auto frame, reports progress per page and never moves the view', async () => {
    const m = await loaded()
    m.next_page()
    const job = m.detect_content()
    const seen: number[] = []
    job.onProgress(d => { seen.push(d) })
    expect(await job.result()).toBeInstanceOf(Ok)
    expect([seen, m.auto_active, m.view_position]).toEqual([[1, 2, 3], true, 2])
    expect(boxes_of(m, 'auto')).toEqual([{ x0: 20, y0: 20, x1: 180, y1: 280 }])
  })

  it('NORMAL reads only the text layer — a page without text gets no box, never a raster fallback', async () => {
    const base = make_adapter({ page_count: 2 })
    const { adapter, calls } = spy({ ...base, detect_text_box: p => Promise.resolve(p === 0 ? { x0: 20, y0: 20, x1: 120, y1: 280 } : null) })
    const m = await loaded(adapter)
    await m.detect_content().result()
    expect([n_calls(calls, 'detect_text_box'), n_calls(calls, 'detect_content_box'), n_calls(calls, 'get_source_image')]).toEqual([2, 0, 0])
    expect(m.union).toEqual({ x0: 20, y0: 20, x1: 120, y1: 280 })
  })

  it('SCANNED detects on the raster, never the text layer; a raster failure resolves Failed', async () => {
    const { adapter, calls } = spy(make_adapter({ page_count: 2, mode: Mode.SCANNED }))
    const m = await loaded(adapter)
    await m.detect_content().result()
    expect([n_calls(calls, 'detect_content_box'), n_calls(calls, 'detect_text_box'), m.auto_active]).toEqual([2, 0, true])

    const bad = await loaded({ ...make_adapter({ mode: Mode.SCANNED }), detect_content_box: () => Promise.reject(new Error('cv')) })
    expect(await bad.detect_content().result()).toBeInstanceOf(Failed)
  })

  it('a fresh detect resets offsets and drops a drawn window', async () => {
    const m = await loaded()
    await m.detect_content().result()
    draw(m, 20, 20, 60, 70, 8)
    expect(m.offsets).not.toEqual(ZERO)
    await m.detect_content().result()
    draw(m, 5, 5, 100, 100)
    await m.detect_content().result()
    expect([m.offsets, m.view_snapshot().overlay.map(o => o.kind)]).toEqual([ZERO, ['auto']])
  })

  it('at split 2/4 detects per region and writes the anchored windows into the split layout', async () => {
    const m = await loaded()
    m.set_split(2)
    expect(m.can_detect).toBe(true)
    await m.detect_content().result()
    expect(split_rects(m)).toEqual([{ x0: 20, y0: 20, x1: 80, y1: 280 }, { x0: 120, y0: 20, x1: 180, y1: 280 }])
    m.set_split(4)
    await m.detect_content().result()
    expect(split_rects(m)).toEqual([
      { x0: 20, y0: 20, x1: 80, y1: 130 }, { x0: 20, y0: 170, x1: 80, y1: 280 },
      { x0: 120, y0: 20, x1: 180, y1: 130 }, { x0: 120, y0: 170, x1: 180, y1: 280 },
    ])
    expect(m.can_apply).toBe(true)
  })
})

describe('union aggregation (spec-web §5)', () => {
  it('aggregates top-left min and per-axis max size; full-page fallbacks are excluded', async () => {
    const m = await with_text([{ x0: 0, y0: 0, x1: 200, y1: 300 }, { x0: 20, y0: 30, x1: 120, y1: 280 }, { x0: 30, y0: 20, x1: 110, y1: 260 }])
    await m.detect_content().result()
    expect(m.union).toEqual({ x0: 20, y0: 20, x1: 120, y1: 270 })
  })

  it('rotate rebuilds the union through the same rule, rotating the page\'s cached box', async () => {
    const m = await with_text([{ x0: 0, y0: 0, x1: 200, y1: 300 }, { x0: 20, y0: 20, x1: 120, y1: 280 }, { x0: 30, y0: 30, x1: 110, y1: 260 }])
    await m.detect_content().result()
    select(m, '2'); m.rotate_pages()
    expect([m.union, m.auto_active]).toEqual([{ x0: 20, y0: 20, x1: 280, y1: 250 }, true])
  })

  it('delete rebuilds the union judging each fallback against its own reindexed page', async () => {
    const m = await with_text([
      { x0: 20, y0: 20, x1: 120, y1: 280 }, { x0: 10, y0: 10, x1: 110, y1: 210 }, { x0: 0, y0: 0, x1: 198, y1: 295 },
    ], [{ width: 200, height: 300 }, { width: 400, height: 300 }, { width: 200, height: 300 }])
    await m.detect_content().result()
    expect(m.union).toEqual({ x0: 10, y0: 10, x1: 110, y1: 270 })
    select(m, '1'); m.delete_pages()
    expect(m.union).toEqual({ x0: 10, y0: 10, x1: 110, y1: 210 })
  })

  it('deleting every detected page drops the auto frame', async () => {
    const m = await with_text([{ x0: 20, y0: 20, x1: 120, y1: 280 }, null])
    await m.detect_content().result()
    select(m, '1'); m.delete_pages()
    expect([m.union, m.auto_active]).toEqual([null, false])
  })

  it('outlier tolerance picks the (n+1)-th largest width and height, also on the rotate rebuild', async () => {
    const m = await with_text([{ x0: 0, y0: 0, x1: 200, y1: 100 }, { x0: 0, y0: 0, x1: 150, y1: 300 }, { x0: 0, y0: 0, x1: 10, y1: 180 }],
      Array.from({ length: 3 }, () => ({ width: 300, height: 400 })), 1)
    await m.detect_content().result()
    expect(m.union).toEqual({ x0: 0, y0: 0, x1: 150, y1: 180 })
    select(m, '3'); m.rotate_pages()
    expect(m.union).toEqual({ x0: 0, y0: 0, x1: 180, y1: 100 })
  })

  it('a page with no content is cropped to the union size, centred — live and on Crop', async () => {
    const m = await with_text([{ x0: 20, y0: 20, x1: 120, y1: 280 }, null])
    await m.detect_content().result()
    m.jump_to_output_page(2)
    expect(boxes_of(m, 'auto')).toEqual([{ x0: 50, y0: 20, x1: 150, y1: 280 }])
    m.apply_crop()
    expect(m.document.applied.get(1)).toEqual([{ x0: 50, y0: 20, x1: 150, y1: 280 }])
  })
})

describe('Crop (apply_crop)', () => {
  it('with no crop source is a silent no-op that takes no history step', async () => {
    const m = await loaded()
    m.apply_crop()
    expect([m.document.applied.size, m.can_undo, m.can_apply]).toEqual([0, false, false])
  })

  it('commits the live auto crop to every selected page and shows the page cropped', async () => {
    const m = await loaded()
    await m.detect_content().result()
    m.apply_crop()
    expect([...m.document.applied.values()]).toEqual(Array(3).fill([{ x0: 20, y0: 20, x1: 180, y1: 280 }]))
    expect(m.view_snapshot()).toMatchObject({ page_w: 160, page_h: 260, overlay: [] })
  })

  it('a drawn window shows on every page, commits to all of them, then clears', async () => {
    const m = await loaded()
    draw(m, 40, 50, 160, 250, 8)
    m.next_page()
    expect(boxes_of(m, 'committed')).toEqual([{ x0: 40, y0: 50, x1: 160, y1: 250 }])
    m.apply_crop()
    for (const n of [1, 2, 3]) {
      m.jump_to_output_page(n)
      expect(m.view_snapshot()).toMatchObject({ page_w: 120, page_h: 200, overlay: [] })
    }
  })

  it('re-detect refreshes committed pages instead of clearing them', async () => {
    const boxes: (Box | null)[] = [{ x0: 20, y0: 20, x1: 120, y1: 280 }]
    const m = await with_text(boxes)
    await m.detect_content().result()
    m.apply_crop()
    boxes[0] = { x0: 30, y0: 40, x1: 100, y1: 200 }
    await m.detect_content().result()
    expect(m.document.applied.get(0)).toEqual([{ x0: 30, y0: 40, x1: 100, y1: 200 }])
  })

  it('a split count restored by undo without its windows raises InvalidSplitError', async () => {
    const m = await loaded()
    draw(m, 10, 10, 150, 250)
    m.set_split(4)
    m.undo()
    expect(m.split_count).toBe(4)
    expect(() => { m.apply_crop() }).toThrow(InvalidSplitError)
  })
})

describe('anchors (spec-web §6.2)', () => {
  it('can_detect needs at least one anchor; either axis alone is enough', async () => {
    const m = await loaded()
    const states: boolean[] = []
    for (const [l, t] of [[false, false], [true, null], [false, true]] as const) { m.set_anchor(l, t); states.push(m.can_detect) }
    expect(states).toEqual([false, true, true])
  })

  it('both anchors off: no live frame, Crop and re-detect leave committed crops alone, a press draws', async () => {
    const m = await with_text([{ x0: 20, y0: 20, x1: 120, y1: 280 }, null])
    await m.detect_content().result()
    select(m, '1'); m.apply_crop()
    const committed = m.document.applied.get(0)
    m.set_pages_mode(PagesMode.ALL)
    m.set_anchor(false, false)
    m.apply_crop()
    await m.detect_content().result()
    expect([m.document.applied.get(0), m.document.applied.has(1), boxes_of(m, 'auto')]).toEqual([committed, false, []])
    m.jump_to_output_page(2)
    draw(m, 100, 100, 150, 160, 8)
    expect([m.offsets, boxes_of(m, 'committed')]).toEqual([ZERO, [{ x0: 100, y0: 100, x1: 150, y1: 160 }]])
  })

  it('an anchored axis follows each page\'s own content edge; an unanchored one uses the union edge', async () => {
    const boxes = [{ x0: 20, y0: 30, x1: 120, y1: 280 }, { x0: 40, y0: 40, x1: 130, y1: 250 }]
    for (const [l, t, want] of [
      [true, true, { x0: 40, y0: 40, x1: 140, y1: 290 }],
      [false, true, { x0: 20, y0: 40, x1: 120, y1: 290 }],
      [true, false, { x0: 40, y0: 30, x1: 140, y1: 280 }],
    ] as const) {
      const m = await with_text(boxes)
      await m.detect_content().result()
      m.set_anchor(l, t)
      m.jump_to_output_page(2)
      expect(overlay_box(m, 'auto')).toEqual(want)
    }
  })
})
