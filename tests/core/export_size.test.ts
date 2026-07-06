// Export raster sizing (spec-web §W2 row 8, 2026-07-05): output long side = DPI × paper height
// (A4 = 11.69 in); short side follows the crop aspect. Preview always passes null (full working
// resolution). 'Original resolution' passes null on export too.
import { describe, it, expect } from 'vitest'
import { AppModel, type RendererAdapter, type DocInfo } from '@core/model'
import { Mode } from '@core/enums'
import { PAPER_SIZES, DEFAULT_PAPER } from '@core/constants'

function make_bitmap(w = 100, h = 100): ImageBitmap {
  return { width: w, height: h, close: (): void => { /* no-op */ } }
}

const FILE = (): File => new File(['x'], 'a.pdf', { type: 'application/pdf' })

function make_adapter(): { adapter: RendererAdapter; long_px: (number | null)[] } {
  const long_px: (number | null)[] = []
  const adapter: RendererAdapter = {
    load_files: (files: File[]): Promise<DocInfo> => Promise.resolve({
      page_count: 2,
      page_sizes: [{ width: 200, height: 300 }, { width: 200, height: 300 }],
      file_names: files.map(f => f.name),
      mode: Mode.NORMAL,
    }),
    get_source_image: () => Promise.resolve(make_bitmap()),
    get_work_image:   () => Promise.resolve(make_bitmap()),
    render_output_image: (_s, _b, _pw, _ph, target_long_px): Promise<ImageBitmap> => {
      long_px.push(target_long_px)
      return Promise.resolve(make_bitmap())
    },
    detect_content_box: () => Promise.resolve({ x0: 20, y0: 20, x1: 120, y1: 280 }),
    export_pdf:    () => Promise.resolve(new Uint8Array([1])),
    export_images: () => Promise.resolve(new Uint8Array([2])),
    make_synth_page: (_i, w, h) => Promise.resolve(make_bitmap(w, h)),
    close: (): void => { /* no-op */ },
  }
  return { adapter, long_px }
}

async function committed_model(): Promise<{ model: AppModel; long_px: (number | null)[] }> {
  const { adapter, long_px } = make_adapter()
  const model = new AppModel(adapter)
  await model.load_files([FILE()])
  model.begin_drag(10, 10, 5); model.update_drag(150, 250); model.end_drag()
  model.apply_crop()
  return { model, long_px }
}

describe('A4-based export sizing', () => {
  it('paper defaults to A4 and PAPER_SIZES carries its inch dimensions', () => {
    expect(DEFAULT_PAPER).toBe('A4')
    expect(PAPER_SIZES.A4.height_in).toBeCloseTo(11.69)
  })

  it('export long side = preset DPI × paper height in inches', async () => {
    const { model, long_px } = await committed_model()
    model.set_compress_preset('High — 300 dpi')
    long_px.length = 0
    await model.export('out.pdf').result()
    expect(long_px.some(v => v === Math.round(300 * 11.69))).toBe(true)   // 3507
  })

  it('Custom preset uses settings.custom_dpi', async () => {
    const { model, long_px } = await committed_model()
    model.set_compress_preset('Custom')
    model.set_custom_dpi(600)
    long_px.length = 0
    await model.export('out.pdf').result()
    expect(long_px.some(v => v === Math.round(600 * 11.69))).toBe(true)   // 7014
  })

  it("'Original resolution' exports at source size (null)", async () => {
    const { model, long_px } = await committed_model()
    model.set_compress_preset('Original resolution')
    long_px.length = 0
    await model.export('out.pdf').result()
    expect(long_px.length).toBeGreaterThan(0)
    expect(long_px.every(v => v === null)).toBe(true)
  })

  it('preview renders always pass null regardless of preset/paper', async () => {
    const { adapter, long_px } = make_adapter()
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    model.set_compress_preset('Low — 75 dpi')
    model.begin_drag(10, 10, 5); model.update_drag(150, 250); model.end_drag()
    long_px.length = 0
    model.apply_crop()
    await model.prepare_current_view()
    expect(long_px.length).toBeGreaterThan(0)
    expect(long_px.every(v => v === null)).toBe(true)
  })

  it('set_paper_size validates against PAPER_SIZES', async () => {
    const { model } = await committed_model()
    model.set_paper_size('nonsense')
    expect(model.paper_size).toBe('A4')
  })
})
