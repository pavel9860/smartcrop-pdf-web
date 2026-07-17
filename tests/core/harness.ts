// Shared mock RendererAdapter/bitmap for src/core/ tests (AppModel and its extracted services).
// Mirrors tests/ui/harness.ts's naming for the same concepts, one layer down.
import type { RendererAdapter, DocInfo, OutputPage } from '@core/model'
import { Mode } from '@core/enums'

export function make_bitmap(w = 200, h = 300): ImageBitmap {
  return { width: w, height: h, close: (): void => { /* no-op */ } } as unknown as ImageBitmap
}

export function make_adapter(page_count = 3, mode: Mode = Mode.NORMAL): RendererAdapter {
  const pw = 200, ph = 300
  return {
    load_files: (files: File[]): Promise<DocInfo> => Promise.resolve({
      page_count,
      page_sizes: Array.from({ length: page_count }, () => ({ width: pw, height: ph })),
      file_names: files.map(f => f.name),
      mode,
    }),
    get_source_image: () => Promise.resolve(make_bitmap(pw, ph)),
    get_work_image: () => Promise.resolve(make_bitmap(pw, ph)),
    render_output_image: (_s, box) => Promise.resolve(
      make_bitmap(Math.max(1, Math.round(box.x1 - box.x0)), Math.max(1, Math.round(box.y1 - box.y0)))),
    detect_content_box: (_i, w, h) => Promise.resolve({ x0: 20, y0: 20, x1: w - 20, y1: h - 20 }),
    export_pdf: (_p: OutputPage[]) => Promise.resolve(new Uint8Array([1, 2, 3])),
    export_images: () => Promise.resolve(new Uint8Array([4, 5, 6])),
    make_synth_page: (_i, w, h) => Promise.resolve(make_bitmap(w, h)),
    close: (): void => { /* no-op */ },
  }
}

export const FILE = (name = 'a.pdf'): File => new File(['x'], name, { type: 'application/pdf' })
