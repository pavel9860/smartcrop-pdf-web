// Final branch closes: export render-stage failure path, and detection_union with a box that
// is neither wider nor taller than the running max (both comparison branches taken false).
import { describe, it, expect } from 'vitest'
import { AppModel, type RendererAdapter, type DocInfo } from '@core/model'
import { Mode } from '@core/enums'
import { Failed } from '@core/batch'
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
