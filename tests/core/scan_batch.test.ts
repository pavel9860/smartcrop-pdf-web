// Scan toggles = eager warm-cache batches (spec-web §W2 row 5, 2026-07-05): the intent flips
// synchronously (undoable), then a BatchJob pre-computes the selection's work rasters so
// Auto-detect and navigation hit a warm cache instead of paying render+OpenCV per page view.
import { describe, it, expect } from 'vitest'
import { AppModel, type RendererAdapter, type DocInfo } from '@core/model'
import { Mode, FilterMode } from '@core/enums'
import { Ok, Cancelled, Failed } from '@core/batch'

function make_bitmap(w = 100, h = 100): ImageBitmap {
  return { width: w, height: h, close: (): void => { /* no-op */ } }
}

const FILE = (): File => new File(['x'], 'a.pdf', { type: 'application/pdf' })

function make_adapter(): { adapter: RendererAdapter; calls: Record<string, number> } {
  const calls: Record<string, number> = {}
  const bump = (k: string): void => { calls[k] = (calls[k] ?? 0) + 1 }
  const adapter: RendererAdapter = {
    load_files: (files: File[]): Promise<DocInfo> => Promise.resolve({
      page_count: 3,
      page_sizes: Array.from({ length: 3 }, () => ({ width: 200, height: 300 })),
      file_names: files.map(f => f.name),
      mode: Mode.SCANNED,
    }),
    get_source_image: () => { bump('get_source_image'); return Promise.resolve(make_bitmap()) },
    get_work_image:   () => { bump('get_work_image');   return Promise.resolve(make_bitmap()) },
    render_output_image: () => Promise.resolve(make_bitmap()),
    detect_content_box: () => Promise.resolve({ x0: 20, y0: 20, x1: 120, y1: 280 }),
    export_pdf:    () => Promise.resolve(new Uint8Array()),
    export_images: () => Promise.resolve(new Uint8Array()),
    make_synth_page: (_i, w, h) => Promise.resolve(make_bitmap(w, h)),
    close: (): void => { /* no-op */ },
  }
  return { adapter, calls }
}

describe('eager scan-toggle batches (spec-web §W2 row 5)', () => {
  it('run_dewarp flips the toggle synchronously and warms every selected page', async () => {
    const { adapter, calls } = make_adapter()
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    const base = calls['get_work_image'] ?? 0

    const job = model.run_dewarp()
    expect(model.dewarp_on).toBe(true)              // intent flipped before the job runs
    const r = await job.result()
    expect(r).toBeInstanceOf(Ok)
    expect((calls['get_work_image'] ?? 0) - base).toBe(3)   // all 3 pages pre-computed
  })

  it('after the warm job, viewing a processed page does not recompute it', async () => {
    const { adapter, calls } = make_adapter()
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    await model.set_filter_mode(FilterMode.BW).result()
    const after_job = calls['get_work_image'] ?? 0
    await model.prepare_current_view()              // navigation path
    expect(calls['get_work_image'] ?? 0).toBe(after_job)    // cache hit, no recompute
  })

  it('cancel stops the warm pass but keeps the intent (remaining pages stay lazy)', async () => {
    const { adapter, calls } = make_adapter()
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    const base = calls['get_work_image'] ?? 0

    const job = model.run_dewarp()
    job.cancel()
    const r = await job.result()
    expect(r).toBeInstanceOf(Cancelled)
    expect((calls['get_work_image'] ?? 0) - base).toBeLessThan(3)  // did not finish the pass
    expect(model.dewarp_on).toBe(true)              // intent survives — lazy fallback covers the rest
  })

  it('a failing page render fails the job via result(), not the toggle call', async () => {
    const { adapter } = make_adapter()
    adapter.get_work_image = (): Promise<ImageBitmap> => Promise.reject(new Error('boom'))
    const model = new AppModel(adapter)
    await model.load_files([FILE()])

    const job = model.run_dewarp()          // must not throw here (covered in model.test.ts)
    const r = await job.result()
    expect(r).toBeInstanceOf(Failed)
  })

  it('set_filter_mode and set_filter_strength also return warm jobs', async () => {
    const { adapter, calls } = make_adapter()
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    const base = calls['get_work_image'] ?? 0

    await model.set_filter_mode(FilterMode.SHARPEN).result()
    expect(model.filter_mode).toBe(FilterMode.SHARPEN)
    await model.set_filter_strength(3).result()
    expect(model.filter_strength).toBe(3)
    // two warm passes over 3 pages (strength re-processes with the new intent)
    expect((calls['get_work_image'] ?? 0) - base).toBe(6)
  })
})
