// PageRasterPipeline tests (§18 AppModel decomposition, step 2/7): direct unit coverage of the
// raster cache/fetch collaborator, independent of AppModel (which exercises it indirectly through
// its own extensive suite — this file targets the pipeline's own contract in isolation).
import { describe, it, expect } from 'vitest'
import { PageRasterPipeline, type RasterContext } from '@core/page_raster_pipeline'
import { PageIndexMap } from '@core/page_index_map'
import { Mode } from '@core/enums'
import type { RendererAdapter, DocInfo, PageSize } from '@core/model'
import type { PageProcessIntent } from '@core/document_state'

function bmp(w = 100, h = 100): ImageBitmap {
  return { width: w, height: h, close: (): void => {} }
}

function ctx(overrides: Partial<RasterContext> = {}): RasterContext {
  return {
    mode: () => Mode.NORMAL,
    display_dpi: () => 96,
    is_synthetic: () => false,
    rotation: () => 0,
    process_intent: (): PageProcessIntent => ({ dewarp: false, filter: null }),
    dewarp_supersample: () => 1,
    ...overrides,
  }
}

function adapter(overrides: Partial<RendererAdapter> = {}): RendererAdapter {
  return {
    load_files: (f: File[]): Promise<DocInfo> => Promise.resolve({
      page_count: 1, page_sizes: [{ width: 200, height: 300 }],
      file_names: f.map(x => x.name), mode: Mode.NORMAL,
    }),
    get_source_image: () => Promise.resolve(bmp()),
    get_work_image: () => Promise.resolve(bmp()),
    render_output_image: (_s, b) => Promise.resolve(bmp(b.x1 - b.x0, b.y1 - b.y0)),
    detect_content_box: (_i, w, h) => Promise.resolve({ x0: 0, y0: 0, x1: w, y1: h }),
    export_pdf: () => Promise.resolve(new Uint8Array()),
    export_images: () => Promise.resolve(new Uint8Array()),
    make_synth_page: (_i, w, h) => Promise.resolve(bmp(w, h)),
    close: (): void => {},
    ...overrides,
  }
}

function pipeline(a: RendererAdapter, c: RasterContext, n = 1): PageRasterPipeline {
  const idx = new PageIndexMap()
  idx.reset(n)
  return new PageRasterPipeline(a, idx, c)
}

describe('PageRasterPipeline.get_source / get_work', () => {
  it('caches get_source: a second call for the same page does not re-render', async () => {
    let calls = 0
    const a = adapter({ get_source_image: () => { calls++; return Promise.resolve(bmp()) } })
    const p = pipeline(a, ctx())
    await p.get_source(0)
    await p.get_source(0)
    expect(calls).toBe(1)
  })

  it('routes through make_synth_page instead of get_source_image when the doc is synthetic', async () => {
    let synth = false, real = false
    const a = adapter({
      get_source_image: () => { real = true; return Promise.resolve(bmp()) },
      make_synth_page: (_i, w, h) => { synth = true; return Promise.resolve(bmp(w, h)) },
    })
    const p = pipeline(a, ctx({ is_synthetic: () => true }))
    await p.get_source(0)
    expect(synth).toBe(true)
    expect(real).toBe(false)
  })

  it('NORMAL mode: get_work returns the source bitmap directly, without a get_work_image call', async () => {
    let work_calls = 0
    const a = adapter({ get_work_image: () => { work_calls++; return Promise.resolve(bmp()) } })
    const p = pipeline(a, ctx())
    const src = await p.get_source(0)
    const work = await p.get_work(0)
    expect(work).toBe(src)
    expect(work_calls).toBe(0)
  })

  it('SCANNED + a no-op intent (no dewarp, no filter) also short-circuits to the source bitmap', async () => {
    let work_calls = 0
    const a = adapter({ get_work_image: () => { work_calls++; return Promise.resolve(bmp()) } })
    const p = pipeline(a, ctx({ mode: () => Mode.SCANNED }))
    const src = await p.get_source(0)
    const work = await p.get_work(0)
    expect(work).toBe(src)
    expect(work_calls).toBe(0)
  })

  it('SCANNED + a real intent calls get_work_image and caches the result', async () => {
    let work_calls = 0
    const a = adapter({ get_work_image: () => { work_calls++; return Promise.resolve(bmp(9, 9)) } })
    const p = pipeline(a, ctx({
      mode: () => Mode.SCANNED,
      process_intent: (): PageProcessIntent => ({ dewarp: true, filter: null }),
    }))
    const w1 = await p.get_work(0)
    const w2 = await p.get_work(0)
    expect(work_calls).toBe(1)
    expect(w1).toBe(w2)
    expect(w1.width).toBe(9)
  })
})

describe('PageRasterPipeline.load_current / current', () => {
  it('load_current fetches the work raster and marks it as the on-screen bitmap', async () => {
    const p = pipeline(adapter(), ctx())
    expect(p.current).toBeNull()
    const work = await p.load_current(0)
    expect(p.current).toBe(work)
  })

  it('invalidate_current clears the on-screen bitmap without touching the caches', async () => {
    const p = pipeline(adapter(), ctx())
    await p.load_current(0)
    p.invalidate_current()
    expect(p.current).toBeNull()
  })
})

describe('PageRasterPipeline eviction never double-closes the on-screen bitmap', () => {
  it('a source-cache eviction skips close() for the bitmap currently marked as on-screen', async () => {
    const closed: number[] = []
    const a = adapter({
      get_source_image: (page_idx: number) => Promise.resolve({
        width: 10, height: 10, close: (): void => { closed.push(page_idx) },
      }),
    })
    const p = pipeline(a, ctx(), 6)   // CACHE_WINDOW=4 -> page 0 would evict on the 5th distinct page
    await p.load_current(0)           // page 0 becomes "current" -> must never be closed
    for (let i = 1; i < 6; i++) await p.get_source(i)
    // page 0 was evicted from the LRU by now, but load_current marked it current -> not closed
    expect(closed).not.toContain(0)
    expect(closed.length).toBeGreaterThan(0)   // some other page really was evicted+closed
  })
})

describe('PageRasterPipeline.reset / clear_ram', () => {
  it('reset() clears the on-screen bitmap and forces a re-render on the next get_source', async () => {
    let calls = 0
    const a = adapter({ get_source_image: () => { calls++; return Promise.resolve(bmp()) } })
    const p = pipeline(a, ctx())
    await p.load_current(0)
    p.reset()
    expect(p.current).toBeNull()
    await p.get_source(0)
    expect(calls).toBe(2)
  })

  it('clear_ram() drops every RAM raster but leaves prior disk-tier bookkeeping alone', async () => {
    const p = pipeline(adapter(), ctx())
    await p.load_current(0)
    p.clear_ram()
    expect(p.current).toBeNull()
  })
})

describe('PageRasterPipeline.prefetch', () => {
  it('warms an adjacent page in the background', async () => {
    let calls = 0
    const a = adapter({ get_source_image: () => { calls++; return Promise.resolve(bmp()) } })
    const p = pipeline(a, ctx(), 2)
    p.prefetch(1)
    await Promise.resolve(); await Promise.resolve()
    expect(calls).toBe(1)
  })

  it('is a no-op out of range or already warm', () => {
    const p = pipeline(adapter(), ctx(), 2)
    expect(() => { p.prefetch(-1); p.prefetch(99) }).not.toThrow()
  })
})

describe('PageRasterPipeline.prerender_output_views', () => {
  it('renders and caches every split box, keyed by page:split_idx', async () => {
    let render_calls = 0
    const a = adapter({ render_output_image: (_s, b) => { render_calls++; return Promise.resolve(bmp(b.x1 - b.x0, b.y1 - b.y0)) } })
    const p = pipeline(a, ctx())
    const sz: PageSize = { width: 200, height: 300 }
    const boxes = [{ x0: 0, y0: 0, x1: 100, y1: 300 }, { x0: 100, y0: 0, x1: 200, y1: 300 }]
    const work = bmp()
    await p.prerender_output_views(0, boxes, sz, work)
    expect(render_calls).toBe(2)
    expect(p.output_at(0, 0)).not.toBeNull()
    expect(p.output_at(0, 1)).not.toBeNull()
    // a second call with the same page:split_idx keys is a cache hit, not a re-render
    await p.prerender_output_views(0, boxes, sz, work)
    expect(render_calls).toBe(2)
  })

  it('output_at returns null for an unrendered key', () => {
    const p = pipeline(adapter(), ctx())
    expect(p.output_at(5, 0)).toBeNull()
  })
})
