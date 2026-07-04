// AppModel tests — exercises the public interface only (CLAUDE.md: "no private attribute
// assertions in tests"). A hand-rolled mock RendererAdapter stands in for pdf/loader.ts so
// these run headless, with no real PDF.js/OpenCV.js/browser APIs involved.
import { describe, it, expect, beforeEach } from 'vitest'
import { AppModel, type RendererAdapter, type DocInfo } from '@core/model'
import { Mode, FilterMode, PagesMode } from '@core/enums'
import { Ok } from '@core/batch'
import {
  NoDocumentError, EmptySelectionError, InvalidSplitError, DeleteAllPagesError,
} from '@core/errors'

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

function make_bitmap(w = 100, h = 100): ImageBitmap {
  return { width: w, height: h, close: (): void => { /* no-op */ } }
}

interface MockOpts {
  page_count?: number
  page_w?: number
  page_h?: number
  mode?: Mode
}

function make_mock_adapter(opts: MockOpts = {}): {
  adapter: RendererAdapter
  calls: Record<string, number>
  render_args: { dpi: number | null; grey: boolean }[]
} {
  const { page_count = 3, page_w = 200, page_h = 300, mode = Mode.NORMAL } = opts
  const calls: Record<string, number> = {}
  const render_args: { dpi: number | null; grey: boolean }[] = []
  const bump = (k: string): void => { calls[k] = (calls[k] ?? 0) + 1 }

  const adapter: RendererAdapter = {
    load_files: (files: File[]): Promise<DocInfo> => {
      bump('load_files')
      // page_count is independent of files.length — one PDF file can hold many pages, exactly
      // like the real PdfRendererAdapter derives it from parsed page count, not input count.
      return Promise.resolve({
        page_count,
        page_sizes: Array.from({ length: page_count }, () => ({ width: page_w, height: page_h })),
        file_names: files.map(f => f.name),
        mode,
      })
    },
    get_source_image: (): Promise<ImageBitmap> => {
      bump('get_source_image')
      return Promise.resolve(make_bitmap(page_w, page_h))
    },
    get_work_image: (): Promise<ImageBitmap> => {
      bump('get_work_image')
      return Promise.resolve(make_bitmap(page_w, page_h))
    },
    render_output_image: (_src, box, _pw, _ph, target_dpi, greyscale): Promise<ImageBitmap> => {
      bump('render_output_image')
      render_args.push({ dpi: target_dpi, grey: greyscale })
      const w = Math.max(1, Math.round(box.x1 - box.x0))
      const h = Math.max(1, Math.round(box.y1 - box.y0))
      return Promise.resolve(make_bitmap(w, h))
    },
    detect_content_box: (_img, pw, ph) => {
      bump('detect_content_box')
      // Inset box — not near-full-page, so it survives the FULL_PAGE_FRAC union filter.
      return Promise.resolve({ x0: 20, y0: 20, x1: pw - 20, y1: ph - 20 })
    },
    export_pdf: () => {
      bump('export_pdf')
      return Promise.resolve(new Uint8Array([1, 2, 3]))
    },
    export_images: () => {
      bump('export_images')
      return Promise.resolve(new Uint8Array([4, 5, 6]))
    },
    make_synth_page: (_idx, w, h) => {
      bump('make_synth_page')
      return Promise.resolve(make_bitmap(w, h))
    },
    close: (): void => { bump('close') },
  }
  return { adapter, calls, render_args }
}

const FILE = (name = 'a.pdf'): File => new File(['x'], name, { type: 'application/pdf' })

async function loaded_model(opts: MockOpts = {}): Promise<AppModel> {
  const { adapter } = make_mock_adapter(opts)
  const model = new AppModel(adapter)
  await model.load_files([FILE()])
  return model
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

describe('load_files / reset / has_document / page_count', () => {
  it('starts with no document', () => {
    const { adapter } = make_mock_adapter()
    const model = new AppModel(adapter)
    expect(model.has_document).toBe(false)
    expect(model.page_count()).toBe(0)
  })

  it('load_files populates has_document/page_count from the adapter', async () => {
    const model = await loaded_model({ page_count: 4 })
    expect(model.has_document).toBe(true)
    expect(model.page_count()).toBe(4)
  })

  it('reset() re-opens the same files and clears undoable state', async () => {
    const { adapter, calls } = make_mock_adapter()
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    model.set_split(2)
    await model.reset()
    expect(model.split_count).toBe(1)          // _reset_state() clears interaction state
    expect(calls['load_files']).toBe(2)            // reset() calls load_files([]) again
  })

  it('reset() is a no-op with no document loaded', async () => {
    const { adapter, calls } = make_mock_adapter()
    const model = new AppModel(adapter)
    await model.reset()
    expect(calls['load_files']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

describe('navigation', () => {
  it('view_total equals page_count with no committed splits', async () => {
    const model = await loaded_model({ page_count: 5 })
    expect(model.view_total).toBe(5)
    expect(model.view_position).toBe(1)
  })

  it('next_page/prev_page move and clamp at the bounds', async () => {
    const model = await loaded_model({ page_count: 3 })
    model.next_page(); model.next_page(); model.next_page()   // clamp at 3
    expect(model.view_position).toBe(3)
    model.prev_page(); model.prev_page(); model.prev_page()   // clamp at 1
    expect(model.view_position).toBe(1)
  })

  it('jump_to_output_page moves directly and clamps out-of-range targets', async () => {
    const model = await loaded_model({ page_count: 5 })
    model.jump_to_output_page(3)
    expect(model.view_position).toBe(3)
    model.jump_to_output_page(999)
    expect(model.view_position).toBe(5)
    model.jump_to_output_page(-5)
    expect(model.view_position).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Pages selection
// ---------------------------------------------------------------------------

describe('pages selection', () => {
  it('resolve_pages reflects the active PagesMode', async () => {
    const model = await loaded_model({ page_count: 4 })
    expect(model.resolve_pages()).toEqual([0, 1, 2, 3])
    model.set_pages_mode(PagesMode.ODD)
    expect(model.resolve_pages()).toEqual([0, 2])
  })

  it('set_select_pattern switches to a Select-mode pattern and turns off follow', async () => {
    const model = await loaded_model({ page_count: 10 })
    model.set_current_follow(true)
    model.set_select_pattern('2-4')
    expect(model.current_follow).toBe(false)
    expect(model.pages_mode).toBe(PagesMode.SELECT)
    expect(model.resolve_pages()).toEqual([1, 2, 3])
  })

  it('set_current_follow syncs the pattern to the current page and re-syncs on navigation', async () => {
    const model = await loaded_model({ page_count: 10 })
    model.jump_to_output_page(3)
    model.set_current_follow(true)
    expect(model.select_pattern).toBe('3')
    model.next_page()
    expect(model.select_pattern).toBe('4')
  })

  it('resolve_pages is empty with no document', () => {
    const { adapter } = make_mock_adapter()
    const model = new AppModel(adapter)
    expect(model.resolve_pages()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Crop / detect
// ---------------------------------------------------------------------------

describe('detect_content / apply_crop', () => {
  it('can_detect requires a document, split=1, and at least one anchor on', async () => {
    const model = await loaded_model()
    expect(model.can_detect).toBe(true)
    model.set_anchor(false, false)
    expect(model.can_detect).toBe(false)
  })

  it('detect_content raises NoDocumentError with no document', () => {
    const { adapter } = make_mock_adapter()
    const model = new AppModel(adapter)
    expect(() => model.detect_content()).toThrow(NoDocumentError)
  })

  it('detect_content resolves Ok and sets auto_active + a live overlay box', async () => {
    const model = await loaded_model()
    const job = model.detect_content()
    const result = await job.result()
    expect(result).toBeInstanceOf(Ok)
    expect(model.auto_active).toBe(true)
    const snap = model.view_snapshot()
    expect(snap.overlay.some(o => o.kind === 'auto')).toBe(true)
  })

  it('apply_crop with split=1 requires an active auto-detect box (draw/detect first)', async () => {
    const model = await loaded_model()
    model.apply_crop()   // no detect run yet — silently commits nothing (spec: crop never dropped, never fabricated)
    expect(model.view_snapshot().overlay).toEqual([])
  })

  it('apply_crop after detect_content commits the live box', async () => {
    const model = await loaded_model()
    await model.detect_content().result()
    const full = model.view_snapshot().page_w
    model.apply_crop()
    const snap = model.view_snapshot()
    expect(snap.page_w).toBeLessThan(full)   // committed page paints the cropped region at box dims
    expect(snap.overlay).toHaveLength(0)     // no crop outline over the already-cropped view
  })

  it('apply_crop with a mismatched split count raises InvalidSplitError', async () => {
    // split_count is a non-undoable interaction setting (ARCHITECTURE §5.2) but crop_rects
    // lives in undoable DocumentState — an undo can restore crop_rects from before a
    // set_split() call while split_count itself stays put, producing a real mismatch.
    const model = await loaded_model({ page_w: 200, page_h: 300 })
    model.begin_drag(10, 10, 5); model.update_drag(150, 250); model.end_drag()   // history.push, crop_rects=[]
    model.set_split(4)   // crop_rects now has 4 rects; split_count=4; not itself undoable
    model.undo()         // restores document to the pre-draw-commit snapshot: crop_rects=[]
    expect(model.split_count).toBe(4)              // untouched by undo
    expect(() => { model.apply_crop(); }).toThrow(InvalidSplitError)
  })

  it('detect_content raises EmptySelectionError when the page selection is empty', async () => {
    const model = await loaded_model({ page_count: 4 })
    model.set_select_pattern('999')   // resolves to no pages
    model.set_pages_mode(PagesMode.SELECT)
    expect(() => model.detect_content()).toThrow(EmptySelectionError)
  })

  it('set_offset clamps to +/-OFFSET_LIMIT and commit_offsets is a no-op with no detection', async () => {
    const model = await loaded_model()
    model.set_offset('L', 9999)
    expect(model.offsets.left).toBeLessThanOrEqual(100)
    model.commit_offsets()   // no detect_cache/union yet — must not throw
    expect(model.offsets.left).toBeLessThanOrEqual(100)
  })

  it('set_keep_ratio(true) with no union defaults to the PAGE aspect ratio (bug E)', async () => {
    const model = await loaded_model({ page_w: 200, page_h: 400 })
    model.set_keep_ratio(true)
    expect(model.keep_ratio).toBe(true)
    expect(model.ratio).toBeCloseTo(0.5)   // no detection yet → default to page w/h = 200/400
  })

  it('a hand-drawn window shows on every page and Crop applies it to ALL, then clears (bug D)', async () => {
    const model = await loaded_model({ page_count: 3, page_w: 200, page_h: 300 })
    model.begin_drag(40, 50, 8)
    model.update_drag(160, 250)
    model.end_drag()
    expect(model.view_snapshot().overlay).toHaveLength(1)   // drawn window outline, page 1
    model.next_page()
    expect(model.view_snapshot().overlay).toHaveLength(1)   // same global window on page 2
    model.prev_page()
    model.apply_crop()
    for (const n of [1, 2, 3]) {                            // every page now carries the crop
      model.jump_to_output_page(n)
      const s = model.view_snapshot()
      expect(s.page_w).toBeCloseTo(120)   // committed to the drawn window's width (160-40) on every page
      expect(s.overlay).toHaveLength(0)   // drawn window cleared; no stray outline on the crop
    }
  })

  it('pressing inside a manual drawn window MOVES it, not replaces it (bug: move manual crop)', async () => {
    const model = await loaded_model({ page_w: 200, page_h: 300 })
    model.begin_drag(40, 50, 8); model.update_drag(160, 250); model.end_drag()
    const before = model.view_snapshot().overlay[0]?.box   // {40,50,160,250}
    model.begin_drag(100, 150, 8)   // press INSIDE the window
    model.update_drag(120, 170)     // drag +20,+20
    model.end_drag()
    const after = model.view_snapshot().overlay[0]?.box
    expect(after?.x0).toBeCloseTo((before?.x0 ?? 0) + 20)   // moved, not a fresh tiny rubber-band
    expect(after?.y0).toBeCloseTo((before?.y0 ?? 0) + 20)
  })

  it('keep-ratio ratio initialises to the first page w/h on load, not 1.0 (bug E-init)', async () => {
    const model = await loaded_model({ page_w: 200, page_h: 300 })
    expect(model.ratio).toBeCloseTo(200 / 300)
  })

  it('moving a drawn window into the page edge preserves its size (no deform at border)', async () => {
    const model = await loaded_model({ page_w: 200, page_h: 300 })
    model.begin_drag(40, 40, 8); model.update_drag(120, 140); model.end_drag()  // {40,40,120,140}, 80×100
    model.begin_drag(80, 90, 8)              // press INSIDE → move
    model.update_drag(80 + 500, 90 + 500)    // shove far past the bottom-right corner
    model.end_drag()
    const box = model.view_snapshot().overlay[0]?.box
    expect(box?.x1 ?? 0 - (box?.x0 ?? 0)).not.toBeNaN()
    expect((box?.x1 ?? 0) - (box?.x0 ?? 0)).toBeCloseTo(80)    // width preserved (not shrunk)
    expect((box?.y1 ?? 0) - (box?.y0 ?? 0)).toBeCloseTo(100)   // height preserved
    expect(box?.x1).toBeCloseTo(200)                          // stopped at the right edge
    expect(box?.y1).toBeCloseTo(300)                          // stopped at the bottom edge
  })

  it('resizing a drawn window with keep-ratio holds the ratio live during the drag', async () => {
    const model = await loaded_model({ page_w: 400, page_h: 400 })
    model.begin_drag(50, 50, 8); model.update_drag(150, 150); model.end_drag()  // 100×100 square
    model.set_keep_ratio(true, 2.0)          // lock width:height = 2:1
    model.begin_drag(150, 150, 8)            // BR handle
    model.update_drag(300, 250)              // resize out (no end_drag → mid-drag state)
    const box = model.view_snapshot().overlay[0]?.box
    const w = (box?.x1 ?? 0) - (box?.x0 ?? 0), h = (box?.y1 ?? 0) - (box?.y0 ?? 0)
    expect(w / h).toBeCloseTo(2.0, 1)        // ratio preserved DURING the drag, not only on release
  })

  it('cancel_drag (Esc / right-click) drops the pending drawn window (bug 5)', async () => {
    const model = await loaded_model()
    model.begin_drag(40, 50, 8); model.update_drag(160, 250); model.end_drag()
    expect(model.view_snapshot().overlay).toHaveLength(1)   // drawn window shown
    model.cancel_drag()
    expect(model.view_snapshot().overlay).toHaveLength(0)   // dropped by Esc/right-click
  })

  it('starting a new draw drops the old drawn window immediately on press (bug 6)', async () => {
    const model = await loaded_model()
    model.begin_drag(40, 50, 8); model.update_drag(160, 250); model.end_drag()
    expect(model.view_snapshot().overlay).toHaveLength(1)
    model.begin_drag(20, 20, 8)                             // press to start a NEW draw
    expect(model.view_snapshot().overlay).toHaveLength(0)   // old window gone before any move
    model.cancel_drag()
  })

  it('set_keep_ratio(true) pre-populates from the detection UNION, not the page (model.py:435-441)', async () => {
    const model = await loaded_model({ page_w: 200, page_h: 400 })
    model.set_keep_ratio(false)
    await model.detect_content().result()   // mock detect_content_box -> {20,20,180,380} on 200x400
    model.set_keep_ratio(true)
    // union width=160, height=360 (page ratio would have been 200/400=0.5 — must not match that)
    expect(model.ratio).toBeCloseTo(160 / 360, 5)
  })

  it('set_split seeds crop_rects for the requested count', async () => {
    const model = await loaded_model()
    model.set_split(4)
    expect(model.split_count).toBe(4)
    expect(model.can_apply).toBe(true)   // crop_rects freshly seeded to exactly 4 -> matches split_count
  })

  it('set_same_size toggles', async () => {
    const model = await loaded_model()
    expect(model.same_size).toBe(false)
    model.set_same_size(true)
    expect(model.same_size).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Gestures — draw a new crop rectangle end to end
// ---------------------------------------------------------------------------

describe('gestures: draw / cancel', () => {
  it('a full draw gesture (begin -> update -> end) commits a crop box', async () => {
    const model = await loaded_model({ page_w: 200, page_h: 300 })
    model.begin_drag(10, 10, 5)
    model.update_drag(150, 250)
    model.end_drag()
    const snap = model.view_snapshot()
    expect(snap.overlay).toHaveLength(1)
    expect(snap.overlay[0]?.kind).toBe('committed')
  })

  it('a too-small draw is discarded (below MIN_RECT), nothing committed', async () => {
    const model = await loaded_model()
    model.begin_drag(10, 10, 5)
    model.update_drag(11, 11)
    model.end_drag()
    expect(model.view_snapshot().overlay).toEqual([])
  })

  it('cancel_drag on a crop-edit restores the prior committed box', async () => {
    const model = await loaded_model({ page_w: 200, page_h: 300 })
    // Commit a box: draw a window, then Crop (draw now sets the global drawn window).
    model.begin_drag(10, 10, 5)
    model.update_drag(150, 250)
    model.end_drag()
    model.apply_crop()                       // committed to {10,10,150,250}; drawn cleared
    // Grab the committed box's TL handle, drag, then cancel — the committed crop is restored.
    model.begin_drag(10, 10, 5)
    model.update_drag(80, 80)
    model.cancel_drag()
    const s = model.view_snapshot()
    expect(s.page_w).toBeCloseTo(140)        // 150 - 10, committed crop dims preserved
    expect(s.page_h).toBeCloseTo(240)        // 250 - 10
  })

  it('drag without a loaded document is a no-op', () => {
    const { adapter } = make_mock_adapter()
    const model = new AppModel(adapter)
    expect(() => { model.begin_drag(0, 0, 5); model.update_drag(1, 1); model.end_drag() }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Scan processing
// ---------------------------------------------------------------------------

describe('scan processing (lazy — toggles are instant, rendering deferred to view/export)', () => {
  it('run_dewarp toggles dewarp_on synchronously', async () => {
    const model = await loaded_model({ mode: Mode.SCANNED })
    expect(model.dewarp_on).toBe(false)
    model.run_dewarp()
    expect(model.dewarp_on).toBe(true)
  })

  it('set_filter_mode sets the mode, and pressing the same mode again turns it off', async () => {
    const model = await loaded_model({ mode: Mode.SCANNED })
    model.set_filter_mode(FilterMode.BW)
    expect(model.filter_mode).toBe(FilterMode.BW)
    model.set_filter_mode(FilterMode.BW)
    expect(model.filter_mode).toBe(FilterMode.NONE)
  })

  it('set_filter_strength clamps to [FILTER_STRENGTH_MIN, FILTER_STRENGTH_MAX]', async () => {
    const model = await loaded_model({ mode: Mode.SCANNED })
    model.set_filter_strength(99)
    expect(model.filter_strength).toBe(3)
    model.set_filter_strength(-5)
    expect(model.filter_strength).toBe(1)
  })

  it('run_dewarp does no eager rendering — a failing renderer does not throw here', async () => {
    const { adapter } = make_mock_adapter({ mode: Mode.SCANNED })
    adapter.get_work_image = (): Promise<ImageBitmap> => Promise.reject(new Error('boom'))
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    expect(() => { model.run_dewarp() }).not.toThrow()   // intent recorded; render is deferred
    expect(model.dewarp_on).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe('undo / redo', () => {
  it('can_undo/can_redo reflect history state around a crop commit', async () => {
    const model = await loaded_model({ page_w: 200, page_h: 300 })
    expect(model.can_undo).toBe(false)
    model.begin_drag(10, 10, 5)
    model.update_drag(150, 250)
    model.end_drag()
    expect(model.can_undo).toBe(true)
    model.undo()
    expect(model.view_snapshot().overlay).toEqual([])
    expect(model.can_redo).toBe(true)
    model.redo()
    expect(model.view_snapshot().overlay).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Output settings (outside History)
// ---------------------------------------------------------------------------

describe('output settings', () => {
  it('set_compress_preset only accepts known preset names', async () => {
    const model = await loaded_model()
    model.set_compress_preset('not-a-real-preset')
    expect(model.compress_preset).not.toBe('not-a-real-preset')
    model.set_compress_preset('Medium — 150 dpi')
    expect(model.compress_preset).toBe('Medium — 150 dpi')
  })

  it('set_output_colours / set_export_format / set_undo_depth', async () => {
    const model = await loaded_model()
    model.set_output_colours('Grayscale')
    expect(model.output_colours).toBe('Grayscale')
    model.set_export_format('JPG')
    expect(model.export_format).toBe('JPG')
    model.set_export_format('not-a-format')
    expect(model.export_format).toBe('JPG')   // rejected, unchanged
    model.set_undo_depth(2)
    expect(model.undo_depth).toBe(2)
  })

  it('set_output_folder / set_output_postfix / set_dewarp_supersample', async () => {
    const model = await loaded_model()
    model.set_output_folder('/tmp/out')
    expect(model.output_folder).toBe('/tmp/out')
    model.set_output_postfix('_x')
    expect(model.output_postfix).toBe('_x')
    model.set_dewarp_supersample(3)
    expect(model.dewarp_supersample).toBe(3)
    model.set_dewarp_supersample(99)
    expect(model.dewarp_supersample).toBe(4)   // clamped to [1,4]
  })

  it('output settings survive undo (spec §22 inv.4)', async () => {
    const model = await loaded_model({ page_w: 200, page_h: 300 })
    model.set_output_colours('Grayscale')
    model.begin_drag(10, 10, 5); model.update_drag(150, 250); model.end_drag()
    model.undo()
    expect(model.output_colours).toBe('Grayscale')
  })

  it('output quality (DPI + colour) applies to export only, not the committed-crop preview (§W2 row 8)', async () => {
    const { adapter, render_args } = make_mock_adapter({ page_w: 200, page_h: 300 })
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    model.set_compress_preset('Low — 75 dpi')
    model.set_output_colours('Grayscale')
    model.begin_drag(10, 10, 5); model.update_drag(150, 250); model.end_drag(); model.apply_crop()

    render_args.length = 0
    await model.prepare_current_view()
    expect(render_args.length).toBeGreaterThan(0)          // committed page pre-rendered for preview
    for (const a of render_args) {
      expect(a.dpi).toBeNull()                             // preview stays full working resolution
      expect(a.grey).toBe(false)                           // preview stays true-colour
    }

    render_args.length = 0
    await model.export('out.pdf').result()
    expect(render_args.some(a => a.dpi === 75)).toBe(true) // export honours the compress preset
    expect(render_args.some(a => a.grey)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Rotate / delete
// ---------------------------------------------------------------------------

describe('rotate_pages', () => {
  it('raises NoDocumentError with no document', () => {
    const { adapter } = make_mock_adapter()
    const model = new AppModel(adapter)
    expect(() => { model.rotate_pages(); }).toThrow(NoDocumentError)
  })

  it('swaps the reported page_w/page_h for a 90 degree rotation', async () => {
    const model = await loaded_model({ page_w: 200, page_h: 300 })
    const before = model.view_snapshot()
    expect(before.page_w).toBe(200)
    expect(before.page_h).toBe(300)
    model.rotate_pages()
    const after = model.view_snapshot()
    expect(after.page_w).toBe(300)
    expect(after.page_h).toBe(200)
  })

  it('four rotations return to the original page_w/page_h', async () => {
    const model = await loaded_model({ page_w: 200, page_h: 300 })
    for (let i = 0; i < 4; i++) model.rotate_pages()
    const snap = model.view_snapshot()
    expect(snap.page_w).toBe(200)
    expect(snap.page_h).toBe(300)
  })

  it('rotate carries a committed crop through (never dropped, spec §13)', async () => {
    const model = await loaded_model({ page_w: 200, page_h: 300 })
    model.begin_drag(10, 10, 5); model.update_drag(150, 250); model.end_drag()
    expect(model.view_snapshot().overlay).toHaveLength(1)
    model.rotate_pages()
    expect(model.view_snapshot().overlay).toHaveLength(1)
    expect(model.view_snapshot().overlay[0]?.kind).toBe('committed')
  })
})

describe('delete_pages', () => {
  it('raises DeleteAllPagesError when the selection covers every page', async () => {
    const model = await loaded_model({ page_count: 2 })
    expect(() => { model.delete_pages(); }).toThrow(DeleteAllPagesError)
  })

  it('deletes the selected pages and reindexes the rest', async () => {
    const model = await loaded_model({ page_count: 4 })
    model.set_select_pattern('2')       // 1-based -> source index 1
    model.set_pages_mode(PagesMode.SELECT)
    model.delete_pages()
    expect(model.page_count()).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe('export', () => {
  it('suggested_export_name derives from the first file name and current settings', async () => {
    const model = await loaded_model()
    const [name] = model.suggested_export_name()
    expect(name).toMatch(/^a_cropped\.pdf$/)
  })

  it('export raises NoDocumentError with no document', () => {
    const { adapter } = make_mock_adapter()
    const model = new AppModel(adapter)
    expect(() => model.export('out.pdf')).toThrow(NoDocumentError)
  })

  it('export(PDF) drives export_pdf and the registered download handler', async () => {
    const { adapter, calls } = make_mock_adapter({ page_count: 2 })
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    let got_bytes: Uint8Array | null = null
    model.set_download_handlers((bytes) => { got_bytes = bytes }, () => { /* unused */ })
    const result = await model.export('out.pdf').result()
    expect(result).toBeInstanceOf(Ok)
    expect(calls['export_pdf']).toBe(1)
    expect(got_bytes).not.toBeNull()
  })

  it('export(JPG) drives export_images and the zip download handler', async () => {
    const { adapter, calls } = make_mock_adapter({ page_count: 1 })
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    model.set_export_format('JPG')
    let got_zip: Uint8Array | null = null
    let got_base = ''
    model.set_download_handlers(() => { /* unused */ }, (bytes, base) => { got_zip = bytes; got_base = base })
    await model.export('out').result()
    expect(calls['export_images']).toBe(1)
    expect(calls['export_pdf']).toBeUndefined()
    expect(got_zip).not.toBeNull()
    expect(got_base).toBe('out')
  })

  it('export(TIFF) also drives the image/zip path, not export_pdf', async () => {
    const { adapter, calls } = make_mock_adapter({ page_count: 2 })
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    model.set_export_format('TIFF')
    let got_zip: Uint8Array | null = null
    model.set_download_handlers(() => { /* unused */ }, (bytes) => { got_zip = bytes })
    await model.export('out').result()
    expect(calls['export_images']).toBe(1)
    expect(calls['export_pdf']).toBeUndefined()
    expect(got_zip).not.toBeNull()
  })

  it('zip base strips a trailing image extension (no "name.png.zip")', async () => {
    const { adapter } = make_mock_adapter({ page_count: 1 })
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    model.set_export_format('PNG')
    let got_base = ''
    model.set_download_handlers(() => { /* unused */ }, (_b, base) => { got_base = base })
    await model.export('doc_cropped.png').result()   // filename carries the format ext
    expect(got_base).toBe('doc_cropped')
  })

  it('suggested_export_name uses .tif for TIFF', async () => {
    const { adapter } = make_mock_adapter({ page_count: 1 })
    const model = new AppModel(adapter)
    await model.load_files([FILE('scan.pdf')])
    model.set_export_format('TIFF')
    const [name] = model.suggested_export_name()
    expect(name.endsWith('.tif')).toBe(true)
  })

  it('image export doubles the job total so progress spans render + encode', async () => {
    const { adapter } = make_mock_adapter({ page_count: 3 })
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    model.set_export_format('JPG')
    expect(model.export('out').total).toBe(model.view_total * 2)
    model.set_export_format('PDF')
    expect(model.export('out.pdf').total).toBe(model.view_total)
  })
})

describe('document_name', () => {
  it('is empty with no document, the file name with one, "+N more" with several', async () => {
    const { adapter } = make_mock_adapter({ page_count: 1 })
    const model = new AppModel(adapter)
    expect(model.document_name).toBe('')
    await model.load_files([FILE('scan.pdf')])
    expect(model.document_name).toBe('scan.pdf')
    await model.load_files([FILE('a.pdf'), FILE('b.pdf'), FILE('c.pdf')])
    expect(model.document_name).toBe('a.pdf +2 more')
  })
})

// ---------------------------------------------------------------------------
// View snapshot / prepare_current_view
// ---------------------------------------------------------------------------

describe('view_snapshot / prepare_current_view', () => {
  it('returns a synthetic snapshot with no document', () => {
    const { adapter } = make_mock_adapter()
    const model = new AppModel(adapter)
    const snap = model.view_snapshot()
    expect(snap.image).toBeNull()
    expect(snap.total).toBe(0)
  })

  it('image is null until prepare_current_view() has fetched the raster', async () => {
    const model = await loaded_model()
    expect(model.view_snapshot().image).toBeNull()
    await model.prepare_current_view()
    expect(model.view_snapshot().image).not.toBeNull()
  })

  it('status string reports page position and size', async () => {
    const model = await loaded_model({ page_w: 200, page_h: 300, page_count: 2 })
    expect(model.view_snapshot().status).toContain('page 1 / 2')
  })
})

describe('AppModel constructor / has_document edge cases', () => {
  let model: AppModel
  beforeEach(() => {
    const { adapter } = make_mock_adapter()
    model = new AppModel(adapter)
  })

  it('a fresh model has no document and default mode NORMAL', () => {
    expect(model.has_document).toBe(false)
    expect(model.mode).toBe(Mode.NORMAL)
  })
})
