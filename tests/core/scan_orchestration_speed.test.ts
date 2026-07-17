// Orchestration-overhead regression (spec-web §16): isolates the pipeline/cache/dispatch code
// around Dewarp&Deskew and filter apply from the real OpenCV/ONNX compute cost (covered separately
// by tests/perf/scan_speed.test.ts) by using an instant-return mock adapter. A regression here
// (e.g. re-running ensure_cv()/ensure_onnx()-equivalent setup per page, an accidental O(n^2) loop,
// or the old IndexedDB disk-tier's per-page persist/load round trip) would blow well past these
// budgets even though the mocked "compute" itself costs nothing — that's the point: real per-page
// algorithm cost is a separate, expected budget (§16), wrapper overhead is not.
import { describe, it, expect } from 'vitest'
import { AppModel, type RendererAdapter, type DocInfo } from '@core/model'
import { Mode, FilterMode } from '@core/enums'

function make_bitmap(w = 100, h = 100): ImageBitmap {
  return { width: w, height: h, close: (): void => { /* no-op */ } } as unknown as ImageBitmap
}

const FILE = (): File => new File(['x'], 'a.pdf', { type: 'application/pdf' })

function make_adapter(pages: number): RendererAdapter {
  return {
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
  }
}

const PAGES = 50

describe('scan orchestration overhead (spec-web §16)', () => {
  it('Dewarp & Deskew over a multi-page selection completes in < 0.5s (mocked compute)', async () => {
    const model = new AppModel(make_adapter(PAGES))
    await model.load_files([FILE()])
    const t0 = performance.now()
    await model.run_dewarp().result()
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(500)
  })

  it('filter apply over a multi-page selection completes in < 0.3s (mocked compute)', async () => {
    const model = new AppModel(make_adapter(PAGES))
    await model.load_files([FILE()])
    const t0 = performance.now()
    await model.set_filter_mode(FilterMode.BW).result()
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(300)
  })

  it('revisiting pages within the RAM cache window after an eager warm pass never recomputes', async () => {
    let get_work_calls = 0
    const adapter: RendererAdapter = {
      ...make_adapter(PAGES),
      get_work_image: () => { get_work_calls++; return Promise.resolve(make_bitmap()) },
    }
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    await model.run_dewarp().result()   // eager pass over all PAGES; the last few stay RAM-resident
    const calls_after_warm = get_work_calls

    // Scroll back and forth across the last two pages — still within the cache window, no
    // intervening navigation far enough away to evict them. "No lazy processing" means this must
    // be a pure cache hit every time, not a recompute-on-every-visit.
    const t0 = performance.now()
    for (let round = 0; round < 5; round++) {
      model.jump_to_output_page(PAGES - 1)
      await model.prepare_current_view()
      model.jump_to_output_page(PAGES)
      await model.prepare_current_view()
    }
    const elapsed = performance.now() - t0

    expect(elapsed).toBeLessThan(500)
    expect(get_work_calls).toBe(calls_after_warm)   // pure cache hits — zero recomputes
  })
})
