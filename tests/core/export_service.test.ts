// ExportService tests (§18 AppModel decomposition, step 7/7): direct unit coverage of PDF/image
// export, independent of AppModel (which exercises it indirectly through its own suite).
import { describe, it, expect, vi } from 'vitest'
import { ExportService, type ExportContext } from '@core/export_service'
import { PageIndexMap } from '@core/page_index_map'
import { PageRasterPipeline } from '@core/page_raster_pipeline'
import { default_document_state, type DocumentState } from '@core/document_state'
import { Mode } from '@core/enums'
import { EXPORT_BYTES_PER_PX } from '@core/constants'
import { Failed, Cancelled } from '@core/batch'
import type { RendererAdapter, PageSize, VectorExportPage, OutputPage } from '@core/model'
import type { Box } from '@core/geometry'
import { make_adapter, make_bitmap, recording_sink } from './harness'

function setup(opts: {
  page_count?: number
  mode?: Mode
  adapter?: Partial<RendererAdapter>
  output_colours?: string
  export_format?: 'PDF' | 'JPG' | 'PNG' | 'TIFF'
} = {}): {
  svc: ExportService
  doc: DocumentState
  pdf_bytes: Uint8Array[]
  zip_bytes: Uint8Array[]
} {
  const page_count = opts.page_count ?? 2
  const mode = opts.mode ?? Mode.NORMAL
  const adapter: RendererAdapter = { ...make_adapter(page_count, mode), ...opts.adapter }
  const idx = new PageIndexMap()
  idx.reset(page_count)
  const raster = new PageRasterPipeline(adapter, idx, {
    mode: () => mode, display_dpi: () => 96, is_synthetic: () => false,
    rotation: () => 0, process_intent: () => ({ dewarp: false, filter: null }),
    dewarp_supersample: () => 1, undo_depth: () => 2,
  })
  const doc = default_document_state()
  const ctx: ExportContext = {
    document: () => doc,
    page_dims: (): PageSize => ({ width: 200, height: 300 }),
    page_count: () => idx.length,
    mode: () => mode,
    view_total: () => idx.length,
    file_names: () => ['book.pdf'],
    output_postfix: () => '_cropped',
    export_format: () => opts.export_format ?? 'PDF',
    output_colours: () => opts.output_colours ?? 'Original colors',
    compress_preset: () => 'Original resolution',
    custom_dpi: () => 300,
    paper_size: () => 'A4',
    custom_paper_in: () => 11.69,
    source_pages: () => 10,
    source_bytes: () => 1_000_000,
    source_px_per_unit: () => 2,
  }
  const svc = new ExportService(adapter, raster, idx, ctx)
  const pdf_bytes: Uint8Array[] = []
  const zip_bytes: Uint8Array[] = []
  svc.set_download_handlers(
    (bytes) => { pdf_bytes.push(bytes) },
    (bytes) => { zip_bytes.push(bytes) },
  )
  return { svc, doc, pdf_bytes, zip_bytes }
}

describe('ExportService.suggested_export_name', () => {
  it('strips the source extension, appends the postfix and the format extension', () => {
    const { svc } = setup({ export_format: 'PDF' })
    expect(svc.suggested_export_name()).toBe('book_cropped.pdf')
  })

  it('uses the right extension per export_format', () => {
    expect(setup({ export_format: 'JPG' }).svc.suggested_export_name()).toBe('book_cropped.jpg')
    expect(setup({ export_format: 'PNG' }).svc.suggested_export_name()).toBe('book_cropped.png')
    expect(setup({ export_format: 'TIFF' }).svc.suggested_export_name()).toBe('book_cropped.tif')
  })
})

describe('ExportService.export — raster path (streamed, spec-web §21 #9)', () => {
  it('streams every page into a PDF sink and downloads the PDF', async () => {
    const pages: OutputPage[] = []
    const begin_export = vi.fn(() => recording_sink(pages, new Uint8Array([9, 9, 9])))
    const { svc, pdf_bytes } = setup({ page_count: 3, export_format: 'PDF', adapter: { begin_export } })
    const result = await svc.export('out.pdf').result()
    expect(result).not.toBeInstanceOf(Failed)
    expect(begin_export).toHaveBeenCalledWith('PDF', 'out')
    expect(pages).toHaveLength(3)
    expect(pdf_bytes).toHaveLength(1)
  })

  it('image formats stream into one zip, base name without the extension', async () => {
    const begin_export = vi.fn(() => recording_sink())
    const { svc, zip_bytes } = setup({ export_format: 'PNG', adapter: { begin_export } })
    await svc.export('out.png').result()
    expect(begin_export).toHaveBeenCalledWith('PNG', 'out')
    expect(zip_bytes).toHaveLength(1)
  })

  it('progress counts real pages (total === display_total)', () => {
    const { svc } = setup({ page_count: 3, export_format: 'PNG' })
    const job = svc.export('out.png')
    expect(job.total).toBe(3)
    expect(job.display_total).toBe(3)
  })

  it('never holds more than two rendered, un-encoded pages (slow encoder)', async () => {
    let rendered = 0, encoded = 0, peak = 0
    const render_output_image = vi.fn((_s: ImageBitmap, box: Box) => {
      rendered++
      peak = Math.max(peak, rendered - encoded)
      return Promise.resolve(make_bitmap(box.x1 - box.x0, box.y1 - box.y0))
    })
    const begin_export = vi.fn(() => ({
      ...recording_sink(),
      add: () => new Promise<void>(r => setTimeout(() => { encoded++; r() }, 5)),
    }))
    const { svc } = setup({ page_count: 8, export_format: 'JPG', adapter: { render_output_image, begin_export } })
    expect(await svc.export('out.jpg').result()).not.toBeInstanceOf(Failed)
    expect(encoded).toBe(8)
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('completes Failed and aborts the sink when rendering throws', async () => {
    const sink = { ...recording_sink(), abort: vi.fn() }
    const render_output_image = vi.fn(() => Promise.reject(new Error('render failed')))
    const { svc } = setup({ adapter: { render_output_image, begin_export: () => sink } })
    expect(await svc.export('out.pdf').result()).toBeInstanceOf(Failed)
    expect(sink.abort).toHaveBeenCalled()
  })

  it('cancels cleanly with no partial file', async () => {
    const sink = { ...recording_sink(), abort: vi.fn(), finish: vi.fn(() => Promise.resolve(new Uint8Array())) }
    const { svc, pdf_bytes } = setup({ page_count: 5, adapter: { begin_export: () => sink } })
    const job = svc.export('out.pdf')
    job.cancel()
    expect(await job.result()).toBeInstanceOf(Cancelled)
    expect(sink.finish).not.toHaveBeenCalled()
    expect(pdf_bytes).toHaveLength(0)
  })
})

describe('ExportService.export — vector path', () => {
  it('uses export_pdf_vector when available for a NORMAL-mode PDF export, no rasterization', async () => {
    const export_pdf_vector = vi.fn((_p: readonly VectorExportPage[]) => Promise.resolve(new Uint8Array([7])))
    const render_output_image = vi.fn()
    const { svc, pdf_bytes } = setup({
      mode: Mode.NORMAL, export_format: 'PDF',
      adapter: { export_pdf_vector, render_output_image },
    })
    await svc.export('out.pdf').result()
    expect(export_pdf_vector).toHaveBeenCalledTimes(1)
    expect(render_output_image).not.toHaveBeenCalled()
    expect(pdf_bytes).toHaveLength(1)
  })

  it('does NOT use the vector path in SCANNED mode even if the adapter supports it', async () => {
    const export_pdf_vector = vi.fn(() => Promise.resolve(new Uint8Array([7])))
    const begin_export = vi.fn(() => recording_sink())
    const { svc } = setup({
      mode: Mode.SCANNED, export_format: 'PDF',
      adapter: { export_pdf_vector, begin_export },
    })
    await svc.export('out.pdf').result()
    expect(export_pdf_vector).not.toHaveBeenCalled()
    expect(begin_export).toHaveBeenCalledTimes(1)
  })

  it('does NOT use the vector path for an image export format', async () => {
    const export_pdf_vector = vi.fn(() => Promise.resolve(new Uint8Array([7])))
    const { svc } = setup({
      mode: Mode.NORMAL, export_format: 'JPG',
      adapter: { export_pdf_vector },
    })
    await svc.export('out.jpg').result()
    expect(export_pdf_vector).not.toHaveBeenCalled()
  })

  it('falls back to the raster export when export_pdf_vector is not defined', async () => {
    const begin_export = vi.fn(() => recording_sink())
    const { svc } = setup({ mode: Mode.NORMAL, export_format: 'PDF', adapter: { begin_export } })
    await svc.export('out.pdf').result()
    expect(begin_export).toHaveBeenCalledTimes(1)
  })

  it('passes each page a box from document.applied when committed, else the full page', async () => {
    let seen: VectorExportPage[] = []
    const export_pdf_vector = vi.fn((pages: readonly VectorExportPage[]) => {
      seen = [...pages]
      return Promise.resolve(new Uint8Array([1]))
    })
    const { svc, doc } = setup({
      page_count: 2, mode: Mode.NORMAL,
      adapter: { export_pdf_vector },
    })
    doc.applied.set(0, [{ x0: 5, y0: 5, x1: 100, y1: 100 }])
    await svc.export('out.pdf').result()
    expect(seen).toHaveLength(2)
    expect(seen[0]?.boxes).toEqual([{ x0: 5, y0: 5, x1: 100, y1: 100 }])
    expect(seen[1]?.boxes).toEqual([{ x0: 0, y0: 0, x1: 200, y1: 300 }])   // full page fallback
  })
})

describe('ExportService.estimate_bytes (Save size estimate)', () => {
  it('vector PDF: source size scaled by the kept page fraction', () => {
    const { svc } = setup({ mode: Mode.NORMAL, export_format: 'PDF', page_count: 5, adapter: { export_pdf_vector: () => Promise.resolve(new Uint8Array()) } })
    expect(svc.estimate_bytes()).toBe(500_000)
  })

  it('raster: output pixels x bytes-per-pixel for the format', () => {
    const { svc } = setup({ mode: Mode.SCANNED, export_format: 'JPG', page_count: 2 })
    // 2 full pages of 200x300 units at 2 px/unit = 2 x 400x600 px
    expect(svc.estimate_bytes()).toBeCloseTo(2 * 400 * 600 * EXPORT_BYTES_PER_PX.JPG)
  })

  it('counts committed crops, not full pages', () => {
    const { svc, doc } = setup({ mode: Mode.SCANNED, export_format: 'TIFF', page_count: 1 })
    doc.applied.set(0, [{ x0: 0, y0: 0, x1: 100, y1: 100 }, { x0: 100, y0: 0, x1: 200, y1: 100 }])
    expect(svc.estimate_bytes()).toBeCloseTo(2 * 200 * 200 * EXPORT_BYTES_PER_PX.TIFF)
  })
})
