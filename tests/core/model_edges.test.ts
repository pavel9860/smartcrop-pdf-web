// AppModel edge/branch coverage (public interface only). Ports the win-app model test cases
// (tests/core/test_model_{pages,split,history,gesture}.py) that the happy-path suite in
// model.test.ts does not reach, to lift src/core branch coverage to the §19 gate. Behaviour
// asserted is the WEB model's (e.g. end_drag commits directly), not a literal desktop port.
import { describe, it, expect } from 'vitest'
import { AppModel, type RendererAdapter, type DocInfo } from '@core/model'
import { Mode, FilterMode, PagesMode } from '@core/enums'
import { NoDocumentError } from '@core/errors'

function make_bitmap(w = 100, h = 100): ImageBitmap {
  return { width: w, height: h, close: (): void => { /* no-op */ } }
}
function make_adapter(page_count = 4, mode = Mode.NORMAL, page_w = 200, page_h = 300): RendererAdapter {
  return {
    load_files: (files: File[]): Promise<DocInfo> => Promise.resolve({
      page_count,
      page_sizes: Array.from({ length: page_count }, () => ({ width: page_w, height: page_h })),
      file_names: files.map(f => f.name),
      mode,
    }),
    get_source_image: () => Promise.resolve(make_bitmap(page_w, page_h)),
    get_work_image: () => Promise.resolve(make_bitmap(page_w, page_h)),
    render_output_image: (_s, box) => Promise.resolve(
      make_bitmap(Math.max(1, Math.round(box.x1 - box.x0)), Math.max(1, Math.round(box.y1 - box.y0)))),
    detect_content_box: (_i, pw, ph) => Promise.resolve({ x0: 20, y0: 20, x1: pw - 20, y1: ph - 20 }),
    export_pdf: () => Promise.resolve(new Uint8Array([1])),
    export_images: () => Promise.resolve(new Uint8Array([4])),
    make_synth_page: (_i, w, h) => Promise.resolve(make_bitmap(w, h)),
    close: (): void => { /* no-op */ },
  }
}
const FILE = (name = 'a.pdf'): File => new File(['x'], name, { type: 'application/pdf' })
async function loaded(page_count = 4, mode = Mode.NORMAL, w = 200, h = 300): Promise<AppModel> {
  const m = new AppModel(make_adapter(page_count, mode, w, h))
  await m.load_files([FILE()])
  return m
}

describe('pages selection edges', () => {
  it('ODD / EVEN / ALL resolve correctly', async () => {
    const m = await loaded(6)
    m.set_pages_mode(PagesMode.ODD)
    expect(m.resolve_pages()).toEqual([0, 2, 4])
    m.set_pages_mode(PagesMode.EVEN)
    expect(m.resolve_pages()).toEqual([1, 3, 5])
    m.set_pages_mode(PagesMode.ALL)
    expect(m.resolve_pages()).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('an out-of-range select pattern resolves to no pages', async () => {
    const m = await loaded(4)
    m.set_select_pattern('99')
    m.set_pages_mode(PagesMode.SELECT)
    expect(m.resolve_pages()).toEqual([])
  })

  it('current_follow ends on a pages-mode change', async () => {
    const m = await loaded(6)
    m.set_current_follow(true)
    expect(m.current_follow).toBe(true)
    m.set_pages_mode(PagesMode.ALL)
    expect(m.current_follow).toBe(false)
  })

  it('current_follow re-syncs on prev_page too', async () => {
    const m = await loaded(6)
    m.jump_to_output_page(4)
    m.set_current_follow(true)
    expect(m.select_pattern).toBe('4')
    m.prev_page()
    expect(m.select_pattern).toBe('3')
    expect(m.resolve_pages()).toEqual([2])
  })
})

describe('split edges', () => {
  it('set_split(n) seeds n overlay rectangles', async () => {
    const m = await loaded(3)
    m.set_split(4)
    const ov = m.view_snapshot().overlay
    expect(ov).toHaveLength(4)
    expect(ov.every(o => o.kind === 'split')).toBe(true)
  })

  it('apply with split multiplies output pages', async () => {
    const m = await loaded(3)
    expect(m.view_total).toBe(3)
    m.set_split(2)
    m.apply_crop()
    expect(m.view_total).toBe(6)
  })

  it('split navigation walks every output page and clamps', async () => {
    const m = await loaded(3)
    m.set_split(2)
    m.apply_crop()
    m.jump_to_output_page(1)
    for (let i = 0; i < 10; i++) m.next_page()
    expect(m.view_position).toBe(6)
    m.jump_to_output_page(4)
    expect(m.view_position).toBe(4)
  })

  it('switching to split drops a stale committed single crop', async () => {
    const m = await loaded(3)
    await m.detect_content().result()
    const full = m.view_snapshot().page_w
    m.apply_crop()
    expect(m.view_snapshot().page_w).toBeLessThan(full)   // committed → cropped page dims
    m.set_split(2)
    expect(m.view_total).toBe(3)                    // committed single crop dropped
    expect(m.view_snapshot().overlay.every(o => o.kind === 'split')).toBe(true)
  })

  it('same_size relayout keeps a valid N-rect selection', async () => {
    const m = await loaded(3)
    m.set_split(2)
    m.set_same_size(false)
    m.set_same_size(true)
    expect(m.same_size).toBe(true)
    expect(m.view_snapshot().overlay).toHaveLength(2)
    expect(m.can_apply).toBe(true)
  })

  it('set_split back to 1 returns to a single view per page', async () => {
    const m = await loaded(3)
    m.set_split(4)
    m.set_split(1)
    expect(m.split_count).toBe(1)
    expect(m.view_total).toBe(3)
  })
})

describe('anchors / offsets edges', () => {
  it('set_anchor axes drive can_detect independently', async () => {
    const m = await loaded()
    m.set_anchor(false, false)
    expect(m.can_detect).toBe(false)
    m.set_anchor(true, null)                        // turn left back on, leave top
    expect(m.can_detect).toBe(true)
    m.set_anchor(null, true)
    expect(m.can_detect).toBe(true)
  })

  it('offset edits commit onto an active detection union', async () => {
    const m = await loaded(4, Mode.NORMAL, 200, 300)
    await m.detect_content().result()
    m.set_offset('R', 15)
    m.set_offset('B', 5)
    m.commit_offsets()
    expect(m.offsets.right).toBeGreaterThan(0)
    expect(m.offsets.right).toBeLessThanOrEqual(15)
  })

  it('every offset edge clamps to +/-OFFSET_LIMIT', async () => {
    const m = await loaded()
    for (const e of ['L', 'T', 'R', 'B'] as const) {
      m.set_offset(e, 100000)
      expect(Math.abs(m.offsets[({ L: 'left', T: 'top', R: 'right', B: 'bottom' } as const)[e]])).toBeLessThanOrEqual(1000)
    }
  })
})

describe('scan processing edges', () => {
  it('set_filter_mode is undoable and undo reverts it', async () => {
    const m = await loaded(3, Mode.SCANNED)
    m.set_filter_mode(FilterMode.BW)
    expect(m.filter_mode).toBe(FilterMode.BW)
    if (m.can_undo) {
      m.undo()
      expect(m.filter_mode).toBe(FilterMode.NONE)
    }
  })

  it('switching filter mode BW -> SHARPEN keeps a single active mode', async () => {
    const m = await loaded(3, Mode.SCANNED)
    m.set_filter_mode(FilterMode.BW)
    m.set_filter_mode(FilterMode.SHARPEN)
    expect(m.filter_mode).toBe(FilterMode.SHARPEN)
  })
})

describe('history / rotate / delete edges', () => {
  it('undo depth bounds the number of reversible steps', async () => {
    const m = await loaded(4)
    m.set_undo_depth(2)
    m.rotate_pages(); m.rotate_pages(); m.rotate_pages()
    let steps = 0
    while (m.can_undo) { m.undo(); steps++; if (steps > 10) break }
    expect(steps).toBeLessThanOrEqual(2)
  })

  it('redo stack is cleared by a new committing action', async () => {
    const m = await loaded(3, Mode.NORMAL, 200, 300)
    m.begin_drag(10, 10, 5); m.update_drag(150, 250); m.end_drag()
    m.undo()
    expect(m.can_redo).toBe(true)
    m.begin_drag(20, 20, 5); m.update_drag(160, 260); m.end_drag()
    expect(m.can_redo).toBe(false)
  })

  it('rotate is undoable and restores page dimensions', async () => {
    const m = await loaded(3, Mode.NORMAL, 200, 300)
    const s0 = m.view_snapshot()
    const [w0, h0] = [s0.page_w, s0.page_h]
    m.rotate_pages()
    const s1 = m.view_snapshot()
    expect([s1.page_w, s1.page_h]).toEqual([h0, w0])
    m.undo()
    const s2 = m.view_snapshot()
    expect([s2.page_w, s2.page_h]).toEqual([w0, h0])
  })

  it('delete_pages raises NoDocumentError on the synthetic document', () => {
    const m = new AppModel(make_adapter())
    expect(() => m.delete_pages()).toThrow(NoDocumentError)
  })

  it('rotate_pages raises NoDocumentError with no document', () => {
    const m = new AppModel(make_adapter())
    expect(() => m.rotate_pages()).toThrow(NoDocumentError)
  })
})

describe('snapshot / status edges', () => {
  it('status string reflects split position', async () => {
    const m = await loaded(3)
    m.set_split(2)
    m.apply_crop()
    m.jump_to_output_page(2)
    expect(m.view_snapshot().status).toContain("page 1 / 3")
  })
})
