// Work-raster cache — RAM-only, content-addressed by (page, rotation, dewarp, filter, strength),
// no disk tier (spec-web §7, §12). Each page owns its own small version history (capacity =
// undo_depth + 1, no separate cache-size constant to keep in sync with it — spec-web §12): a page
// is computed at most once per distinct combination, Undo/Redo re-hit an already-computed bitmap
// when it is still within that page's own reach instead of recomputing, and — critically — this
// history is per PAGE, not shared, so visiting other pages never evicts it.
import { describe, it, expect } from 'vitest'
import { AppModel, type RendererAdapter, type DocInfo } from '@core/model'
import { Mode, FilterMode } from '@core/enums'
import { DEFAULT_UNDO_DEPTH } from '@core/constants'

function make_bitmap(w = 100, h = 100): ImageBitmap {
  return { width: w, height: h, close: (): void => { /* no-op */ } } as unknown as ImageBitmap
}

const FILE = (): File => new File(['x'], 'a.pdf', { type: 'application/pdf' })

function make_adapter(pages: number): {
  adapter: RendererAdapter
  get_work_calls: { n: number }
} {
  const get_work_calls = { n: 0 }
  const adapter: RendererAdapter = {
    load_files: (files: File[]): Promise<DocInfo> => Promise.resolve({
      page_count: pages,
      page_sizes: Array.from({ length: pages }, () => ({ width: 200, height: 300 })),
      file_names: files.map(f => f.name),
      mode: Mode.SCANNED,
    }),
    get_source_image: () => Promise.resolve(make_bitmap()),
    get_work_image: (): Promise<ImageBitmap> => { get_work_calls.n++; return Promise.resolve(make_bitmap()) },
    rotate_bitmap: (b) => Promise.resolve(b),
    render_output_image: () => Promise.resolve(make_bitmap()),
    detect_content_box: () => Promise.resolve({ x0: 20, y0: 20, x1: 120, y1: 280 }),
    export_pdf:    () => Promise.resolve(new Uint8Array()),
    export_images: () => Promise.resolve(new Uint8Array()),
    make_synth_page: (_i, w, h) => Promise.resolve(make_bitmap(w, h)),
    close: (): void => { /* no-op */ },
  }
  return { adapter, get_work_calls }
}

describe('work cache is RAM-only and content-addressed (spec-web §7, §12)', () => {
  it('re-fetching the same page under the same intent never recomputes', async () => {
    const { adapter, get_work_calls } = make_adapter(1)
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    await model.set_filter_mode(FilterMode.BW).result()
    await model.prepare_current_view()
    await model.prepare_current_view()
    expect(get_work_calls.n).toBe(1)
  })

  it('Undo after a filter-mode change reuses the still-resident bitmap instead of recomputing', async () => {
    const { adapter, get_work_calls } = make_adapter(1)
    const model = new AppModel(adapter)
    await model.load_files([FILE()])

    await model.set_filter_mode(FilterMode.BW).result()
    await model.prepare_current_view()
    expect(get_work_calls.n).toBe(1)

    await model.set_filter_mode(FilterMode.SHARPEN).result()
    await model.prepare_current_view()
    expect(get_work_calls.n).toBe(2)   // a genuinely different combination — real compute

    model.undo()   // back to BW
    await model.prepare_current_view()
    expect(get_work_calls.n).toBe(2)   // BW's bitmap is still cached from the first call — no recompute
    expect(model.filter_mode).toBe(FilterMode.BW)
  })

  it('Undo after Rotate reuses the pre-rotation bitmap instead of recomputing', async () => {
    const { adapter, get_work_calls } = make_adapter(1)
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    await model.set_filter_mode(FilterMode.BW).result()
    await model.prepare_current_view()
    expect(get_work_calls.n).toBe(1)

    model.rotate_pages()
    await model.prepare_current_view()
    expect(get_work_calls.n).toBe(2)   // new rotation -> new cache key -> real compute

    model.undo()   // back to rotation 0
    await model.prepare_current_view()
    expect(get_work_calls.n).toBe(2)   // rotation-0 bitmap is still cached — no recompute
  })

  it('processing many different pages never evicts any of them — walking N pages costs the same as 1', async () => {
    const pages = 20
    const { adapter, get_work_calls } = make_adapter(pages)
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    await model.set_filter_mode(FilterMode.BW).result()   // eager pass warms all `pages`
    expect(get_work_calls.n).toBe(pages)

    model.jump_to_output_page(1)   // page 0 — untouched by every other page's own version history
    await model.prepare_current_view()
    expect(get_work_calls.n).toBe(pages)   // still a cache hit, no recompute
  })

  it('a page\'s own version history is bounded by undo_depth+1 — cycling past it recomputes on revisit', async () => {
    const { adapter, get_work_calls } = make_adapter(1)   // DEFAULT_UNDO_DEPTH -> capacity = +1
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    expect(model.undo_depth).toBe(DEFAULT_UNDO_DEPTH)

    await model.set_filter_mode(FilterMode.BW).result()      // BW-1 (default strength)
    await model.prepare_current_view()
    await model.set_filter_strength(2).result()               // BW-2
    await model.prepare_current_view()
    await model.set_filter_strength(3).result()               // BW-3
    await model.prepare_current_view()
    await model.set_filter_mode(FilterMode.SHARPEN).result()  // SHARPEN-3 — a 4th distinct combination,
    await model.prepare_current_view()                        // exceeding capacity (undo_depth+1 = 3):
    expect(get_work_calls.n).toBe(4)                          // BW-1 is now evicted

    await model.set_filter_mode(FilterMode.BW).result()       // BW-3 — still cached (from the 3rd call)
    await model.prepare_current_view()
    expect(get_work_calls.n).toBe(4)                          // cache hit, no new compute

    await model.set_filter_strength(1).result()                // BW-1 — genuinely evicted earlier
    await model.prepare_current_view()
    expect(get_work_calls.n).toBe(5)                          // recomputed, not served stale
  })
})
