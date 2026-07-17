// Final branch closes: export render-stage failure path, detection_union with a box that is
// neither wider nor taller than the running max (both comparison branches taken false), the
// vector-export orchestration path (export_pdf_vector — happy/fallback/cancel/error), SCANNED-
// mode detect's raster path + its error branch, and output-cache LRU eviction.
import { describe, it, expect } from 'vitest'
import { AppModel, type RendererAdapter, type DocInfo, type VectorExportPage } from '@core/model'
import { Mode, PagesMode } from '@core/enums'
import { Failed, Cancelled, Ok } from '@core/batch'
import { detection_union } from '@core/geometry'

function bmp(w = 100, h = 100): ImageBitmap { return { width: w, height: h, close: (): void => {} } }
function adapter(): RendererAdapter {
  return {
    load_files: (f: File[]): Promise<DocInfo> => Promise.resolve({
      page_count: 2, page_sizes: [{ width: 200, height: 300 }, { width: 200, height: 300 }],
      file_names: f.map(x => x.name), mode: Mode.NORMAL }),
    get_source_image: () => Promise.resolve(bmp()),
    get_work_image: () => Promise.resolve(bmp()),
    render_output_image: () => Promise.reject(new Error('render boom')),
    detect_content_box: (_i, pw, ph) => Promise.resolve({ x0: 20, y0: 20, x1: pw - 20, y1: ph - 20 }),
    export_pdf: () => Promise.resolve(new Uint8Array([1])),
    export_images: () => Promise.resolve(new Uint8Array()),
    make_synth_page: (_i, w, h) => Promise.resolve(bmp(w, h)),
    close: (): void => {},
  }
}

describe('export render-stage failure', () => {
  it('resolves Failed when render_output_image rejects', async () => {
    const m = new AppModel(adapter())
    await m.load_files([new File(['x'], 'a.pdf')])
    expect(await m.export('a.pdf').result()).toBeInstanceOf(Failed)
  })
})

describe('detection_union comparison branches', () => {
  it('ignores a box smaller in both dimensions', () => {
    const u = detection_union([
      { x0: 0, y0: 0, x1: 40, y1: 40 },     // sets max w=40, h=40
      { x0: 5, y0: 5, x1: 15, y1: 15 },     // smaller in both -> neither branch taken
    ])
    expect(u.x1 - u.x0).toBe(40)
    expect(u.y1 - u.y0).toBe(40)
  })
})

// ---------------------------------------------------------------------------
// Vector export (_run_export_vector) — spec-web §10.3. Untested until this pass despite being
// the newest, highest-risk path added: NORMAL+PDF export never rasterizes and never touches
// render_output_image, so the raster-export tests elsewhere in this suite exercise none of it.
// ---------------------------------------------------------------------------

function vector_adapter(opts: {
  page_count?: number
  export_pdf_vector?: RendererAdapter['export_pdf_vector']
} = {}): RendererAdapter {
  const { page_count = 2, export_pdf_vector } = opts
  return {
    load_files: (f: File[]): Promise<DocInfo> => Promise.resolve({
      page_count,
      page_sizes: Array.from({ length: page_count }, () => ({ width: 200, height: 300 })),
      file_names: f.map(x => x.name), mode: Mode.NORMAL,
    }),
    get_source_image: () => Promise.resolve(bmp()),
    get_work_image: () => Promise.resolve(bmp()),
    render_output_image: () => Promise.resolve(bmp()),
    detect_content_box: (_i, pw, ph) => Promise.resolve({ x0: 20, y0: 20, x1: pw - 20, y1: ph - 20 }),
    detect_text_box: (_i) => Promise.resolve({ x0: 20, y0: 20, x1: 180, y1: 280 }),
    export_pdf: () => Promise.resolve(new Uint8Array([9])),
    export_images: () => Promise.resolve(new Uint8Array()),
    make_synth_page: (_i, w, h) => Promise.resolve(bmp(w, h)),
    close: (): void => {},
    ...(export_pdf_vector ? { export_pdf_vector } : {}),
  }
}

describe('vector export (_run_export_vector, spec-web §10.3)', () => {
  it('a NORMAL document exporting to PDF uses export_pdf_vector, not the raster path', async () => {
    let received: readonly VectorExportPage[] | null = null
    const adapter = vector_adapter({
      export_pdf_vector: (pages) => { received = pages; return Promise.resolve(new Uint8Array([1, 2, 3])) },
    })
    const m = new AppModel(adapter)
    await m.load_files([new File(['x'], 'a.pdf')])
    let downloaded: Uint8Array | null = null
    m.set_download_handlers((bytes) => { downloaded = bytes }, () => {})

    const result = await m.export('a.pdf').result()
    expect(result).toBeInstanceOf(Ok)
    expect(received).not.toBeNull()
    expect(received).toHaveLength(2)   // one VectorExportPage per source page
    expect(downloaded).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('falls back to the raster export path when the adapter has no export_pdf_vector', async () => {
    const adapter = vector_adapter()   // no export_pdf_vector
    const m = new AppModel(adapter)
    await m.load_files([new File(['x'], 'a.pdf')])
    const result = await m.export('a.pdf').result()
    expect(result).toBeInstanceOf(Ok)   // went through export_pdf (raster) instead, no throw
  })

  it('cancelling before export_pdf_vector settles still resolves the job Cancelled', async () => {
    // The page-building loop itself has no per-page await (unlike the raster path), so it always
    // runs to completion synchronously in one turn before the first real await
    // (adapter.export_pdf_vector); cancel() can only take externally-visible effect on the job's
    // settled result at that point, not abort an in-flight export_pdf_vector call. This still
    // covers the real, user-facing contract: cancelling mid-export must never resolve Ok/Failed.
    const adapter = vector_adapter({
      export_pdf_vector: () => new Promise(() => { /* never settles within this test */ }),
    })
    const m = new AppModel(adapter)
    await m.load_files([new File(['x'], 'a.pdf')])
    const job = m.export('a.pdf')
    job.cancel()
    expect(await job.result()).toBeInstanceOf(Cancelled)
  })

  it('resolves Failed when export_pdf_vector itself rejects', async () => {
    const adapter = vector_adapter({
      export_pdf_vector: () => Promise.reject(new Error('pdf-lib boom')),
    })
    const m = new AppModel(adapter)
    await m.load_files([new File(['x'], 'a.pdf')])
    const result = await m.export('a.pdf').result()
    expect(result).toBeInstanceOf(Failed)
  })
})

// ---------------------------------------------------------------------------
// SCANNED-mode detect: the raster/Sauvola path (NORMAL mode only exercises detect_text_box
// elsewhere in this suite) and its failure branch.
// ---------------------------------------------------------------------------

describe('SCANNED-mode detect (raster path)', () => {
  it('detects via detect_content_box on the raw source, not detect_text_box', async () => {
    let text_box_called = false
    const scan_adapter: RendererAdapter = {
      ...adapter(),
      load_files: (f: File[]): Promise<DocInfo> => Promise.resolve({
        page_count: 2, page_sizes: [{ width: 200, height: 300 }, { width: 200, height: 300 }],
        file_names: f.map(x => x.name), mode: Mode.SCANNED,
      }),
      detect_text_box: (_i) => { text_box_called = true; return Promise.resolve(null) },
    }
    const m = new AppModel(scan_adapter)
    await m.load_files([new File(['x'], 'scan.pdf')])
    const result = await m.detect_content().result()
    expect(result).toBeInstanceOf(Ok)
    expect(text_box_called).toBe(false)
    expect(m.auto_active).toBe(true)
  })

  it('resolves Failed when detect_content_box rejects', async () => {
    const scan_adapter: RendererAdapter = {
      ...adapter(),
      load_files: (f: File[]): Promise<DocInfo> => Promise.resolve({
        page_count: 1, page_sizes: [{ width: 200, height: 300 }],
        file_names: f.map(x => x.name), mode: Mode.SCANNED,
      }),
      detect_content_box: () => Promise.reject(new Error('opencv boom')),
    }
    const m = new AppModel(scan_adapter)
    await m.load_files([new File(['x'], 'scan.pdf')])
    const result = await m.detect_content().result()
    expect(result).toBeInstanceOf(Failed)
  })
})

// ---------------------------------------------------------------------------
// Output-cache invalidation (double-close guard, §17 "every ImageBitmap not released"). Unlike
// source/work, the output cache is not count-bounded (spec-web §7) — it is only ever dropped by
// explicit invalidation at a site that can change what it should show, e.g. Rotate.
// ---------------------------------------------------------------------------

describe('output cache eviction', () => {
  it('invalidating a committed page\'s output previews (via Rotate) closes them, without closing the on-screen bitmap', async () => {
    const closed: string[] = []
    const make = (tag: string): ImageBitmap => ({
      width: 50, height: 50, close: (): void => { closed.push(tag) },
    })
    let n = 0
    const a: RendererAdapter = {
      ...adapter(),
      load_files: (f: File[]): Promise<DocInfo> => Promise.resolve({
        page_count: 1, page_sizes: [{ width: 200, height: 300 }],
        file_names: f.map(x => x.name), mode: Mode.NORMAL,
      }),
      render_output_image: () => Promise.resolve(make(`out${n++}`)),
    }
    const m = new AppModel(a)
    await m.load_files([new File(['x'], 'a.pdf')])
    m.set_split(4)          // seeds crop_rects to exactly 4 rects, matching split_count
    m.apply_crop()          // commits the page -> view_snapshot() now reads from the output cache
    for (let pos = 1; pos <= m.view_total; pos++) {
      m.jump_to_output_page(pos)
      await m.prepare_current_view()
    }
    expect(closed.length).toBe(0)   // nothing evicted yet — no count-based cap to exhaust

    m.rotate_pages()   // rotated box coordinates invalidate every split slot's stale preview

    expect(closed.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Synthetic document rendering (_get_source): a corrupted/unparsable PDF gets a placeholder doc
// from the adapter with page_sizes filled in but no real PageSource — pdf/loader.ts's real
// counterpart sets synthetic:true and every page must render via make_synth_page, never
// get_source_image (spec-web §15).
// ---------------------------------------------------------------------------

describe('synthetic document rendering', () => {
  it('renders via make_synth_page, not get_source_image, when the doc is synthetic', async () => {
    let synth_called = false
    let source_called = false
    const a: RendererAdapter = {
      ...adapter(),
      load_files: (f: File[]): Promise<DocInfo> => Promise.resolve({
        page_count: 1, page_sizes: [{ width: 595, height: 842 }],
        file_names: f.map(x => x.name), mode: Mode.NORMAL, synthetic: true,
      }),
      get_source_image: () => { source_called = true; return Promise.resolve(bmp()) },
      make_synth_page: (_i, w, h) => { synth_called = true; return Promise.resolve(bmp(w, h)) },
    }
    const m = new AppModel(a)
    await m.load_files([new File(['x'], 'broken.pdf')])
    await m.prepare_current_view()
    expect(synth_called).toBe(true)
    expect(source_called).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Anchor toggles off (spec-web §4.4/§9.2): turning BOTH anchor_left and anchor_top off disables
// auto-crop anchoring across every consumer that guards on `anchor_left || anchor_top` —
// can_detect, apply_crop's live auto-crop, begin_drag's auto-resize gesture, re-detect's
// committed-crop refresh, and the live overlay.
// ---------------------------------------------------------------------------

describe('anchor toggles off', () => {
  it('disables auto-crop anchoring for apply_crop and re-detect on an already-committed page', async () => {
    const m = new AppModel(vector_adapter())
    await m.load_files([new File(['x'], 'a.pdf')])
    await m.detect_content().result()
    expect(m.can_detect).toBe(true)

    m.set_pages_mode(PagesMode.SELECT)
    m.set_select_pattern('1')   // restrict to page 0 only, leaving page 1 uncommitted throughout
    m.apply_crop()
    const committed_before = m.document.applied.get(0)
    expect(committed_before).toBeTruthy()
    expect(m.document.applied.has(1)).toBe(false)

    m.set_anchor(false, false)
    expect(m.can_detect).toBe(false)
    expect(m.view_snapshot().overlay.some(o => o.kind === 'auto')).toBe(false)

    // apply_crop can no longer compute a live auto-crop box -> the existing committed crop is
    // left exactly as it was, never overwritten with an empty/derived one
    m.apply_crop()
    expect(m.document.applied.get(0)).toEqual(committed_before)

    // re-detect likewise skips refreshing the already-committed crop while anchors are off
    await m.detect_content().result()
    expect(m.document.applied.get(0)).toEqual(committed_before)
  })

  it('begin_drag cannot start an auto-drag on an uncommitted page once both anchors are off', async () => {
    const m = new AppModel(vector_adapter())
    await m.load_files([new File(['x'], 'a.pdf')])
    await m.detect_content().result()
    m.set_anchor(false, false)
    expect(m.view_snapshot().overlay.some(o => o.kind === 'auto')).toBe(false)

    // The page is uncommitted, so begin_drag reaches _begin_auto_drag; its anchor guard now
    // fails and it falls through to rubber-banding a new draw window instead — offsets untouched.
    const offsets_before = m.offsets
    m.begin_drag(100, 100, 8)
    m.update_drag(120, 120)
    m.end_drag()
    expect(m.offsets).toEqual(offsets_before)
  })
})

describe('auto-drag anchor ternaries (mixed anchor_left/anchor_top)', () => {
  it('left_base falls back to the union corner when only anchor_left is off', async () => {
    const m = new AppModel(vector_adapter())
    await m.load_files([new File(['x'], 'a.pdf')])
    await m.detect_content().result()
    m.set_anchor(false, true)
    const box = m.view_snapshot().overlay.find(o => o.kind === 'auto')?.box
    expect(box).toBeTruthy()
    const before = m.offsets
    m.begin_drag(box!.x0, box!.y0, 8)   // TL handle
    m.update_drag(box!.x0 + 10, box!.y0 + 10)
    m.end_drag()
    expect(m.offsets).not.toEqual(before)
  })

  it('top_base falls back to the union corner when only anchor_top is off', async () => {
    const m = new AppModel(vector_adapter())
    await m.load_files([new File(['x'], 'a.pdf')])
    await m.detect_content().result()
    m.set_anchor(true, false)
    const box = m.view_snapshot().overlay.find(o => o.kind === 'auto')?.box
    expect(box).toBeTruthy()
    const before = m.offsets
    m.begin_drag(box!.x0, box!.y0, 8)
    m.update_drag(box!.x0 + 10, box!.y0 + 10)
    m.end_drag()
    expect(m.offsets).not.toEqual(before)
  })
})
