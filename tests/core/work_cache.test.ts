// Two-tier work cache — write-back behavior (spec-web §W2 row 5, perf: the disk tier must not touch
// IndexedDB on the hot path for documents that fit in RAM). A processed raster is persisted to disk
// ONLY when it is genuinely evicted from the RAM LRU (capacity exceeded), never eagerly on compute;
// and the disk is READ only for a key that was actually persisted.
import { describe, it, expect, vi } from 'vitest'
import { AppModel, type RendererAdapter, type DocInfo } from '@core/model'
import { Mode, FilterMode } from '@core/enums'
import { CACHE_WINDOW } from '@core/constants'

function make_bitmap(w = 100, h = 100): ImageBitmap {
  return { width: w, height: h, close: (): void => { /* no-op */ } } as unknown as ImageBitmap
}

const FILE = (): File => new File(['x'], 'a.pdf', { type: 'application/pdf' })

function make_adapter(pages: number): {
  adapter: RendererAdapter
  persist: ReturnType<typeof vi.fn>
  load: ReturnType<typeof vi.fn>
} {
  const persist = vi.fn((): Promise<void> => Promise.resolve())
  const load = vi.fn((): Promise<ImageBitmap | null> => Promise.resolve(null))
  const adapter: RendererAdapter = {
    load_files: (files: File[]): Promise<DocInfo> => Promise.resolve({
      page_count: pages,
      page_sizes: Array.from({ length: pages }, () => ({ width: 200, height: 300 })),
      file_names: files.map(f => f.name),
      mode: Mode.SCANNED,
    }),
    get_source_image: () => Promise.resolve(make_bitmap()),
    get_work_image:   () => Promise.resolve(make_bitmap()),
    render_output_image: () => Promise.resolve(make_bitmap()),
    detect_content_box: () => Promise.resolve({ x0: 20, y0: 20, x1: 120, y1: 280 }),
    export_pdf:    () => Promise.resolve(new Uint8Array()),
    export_images: () => Promise.resolve(new Uint8Array()),
    make_synth_page: (_i, w, h) => Promise.resolve(make_bitmap(w, h)),
    close: (): void => { /* no-op */ },
    load_work: load,
    persist_work: persist,
    clear_work_cache: () => Promise.resolve(),
  }
  return { adapter, persist, load }
}

describe('write-back work cache (spec-web §W2 row 5)', () => {
  it('a document that fits in RAM never persists to disk', async () => {
    const { adapter, persist, load } = make_adapter(3)
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    await model.set_filter_mode(FilterMode.BW).result()   // warms all 3 pages
    expect(persist).not.toHaveBeenCalled()                 // 3 <= CACHE_WINDOW → no eviction
    expect(load).not.toHaveBeenCalled()                    // and no disk reads on the hot path
  })

  it('persists exactly the pages evicted past the RAM window', async () => {
    const overflow = 4
    const pages = CACHE_WINDOW + overflow
    const { adapter, persist } = make_adapter(pages)
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    await model.set_filter_mode(FilterMode.BW).result()   // warms all `pages`
    // Warming `pages` rasters through a CACHE_WINDOW-slot LRU evicts (pages - CACHE_WINDOW) of them,
    // and each eviction writes the raster back to disk exactly once.
    expect(persist).toHaveBeenCalledTimes(overflow)
  })
})
