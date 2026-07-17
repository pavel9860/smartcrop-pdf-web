// ExportService tests (§18 AppModel decomposition, step 7/7): direct unit coverage of PDF/image
// export, independent of AppModel (which exercises it indirectly through its own suite).
import { describe, it, expect, vi } from 'vitest'
import { ExportService, type ExportContext } from '@core/export_service'
import { PageIndexMap } from '@core/page_index_map'
import { PageRasterPipeline } from '@core/page_raster_pipeline'
import { default_document_state, type DocumentState } from '@core/document_state'
import { Mode } from '@core/enums'
import { Failed, Cancelled } from '@core/batch'
import type { RendererAdapter, PageSize, VectorExportPage } from '@core/model'
import { make_adapter } from './harness'

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
    live_auto_crop_for: () => null,
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

describe('ExportService.export — raster path', () => {
  it('renders every page, downloads via export_pdf for PDF format', async () => {
    const export_pdf = vi.fn(() => Promise.resolve(new Uint8Array([9, 9, 9])))
    const { svc, pdf_bytes } = setup({ export_format: 'PDF', adapter: { export_pdf } })
    const result = await svc.export('out.pdf').result()
    expect(result).not.toBeInstanceOf(Failed)
    expect(export_pdf).toHaveBeenCalledTimes(1)
    expect(pdf_bytes).toHaveLength(1)
  })

  it('uses export_images and downloads a zip for image formats', async () => {
    const export_images = vi.fn(() => Promise.resolve(new Uint8Array([1])))
    const { svc, zip_bytes } = setup({ export_format: 'PNG', adapter: { export_images } })
    await svc.export('out.png').result()
    expect(export_images).toHaveBeenCalledTimes(1)
    expect(zip_bytes).toHaveLength(1)
  })

  it('doubles total for the progress bar (render+encode phases) but keeps display_total the real page count (bug: export progress showing 2x pages)', () => {
    const { svc } = setup({ page_count: 3, export_format: 'PNG' })
    const job = svc.export('out.png')
    expect(job.total).toBe(6)           // 3 pages x 2 phases
    expect(job.display_total).toBe(3)   // real page count, what the counter should show
  })

  it('PDF (no separate encode phase) has display_total equal to total', () => {
    const { svc } = setup({ page_count: 3, export_format: 'PDF' })
    const job = svc.export('out.pdf')
    expect(job.total).toBe(3)
    expect(job.display_total).toBe(3)
  })

  it('strips the extension before handing the base name to export_images', async () => {
    const export_images = vi.fn(() => Promise.resolve(new Uint8Array([1])))
    const { svc } = setup({ export_format: 'PNG', adapter: { export_images } })
    await svc.export('out.png').result()
    expect(export_images).toHaveBeenCalledWith(expect.anything(), 'PNG', 'out', expect.anything())
  })

  it('completes Failed when rendering throws', async () => {
    const render_output_image = vi.fn(() => Promise.reject(new Error('render failed')))
    const { svc } = setup({ adapter: { render_output_image } })
    const result = await svc.export('out.pdf').result()
    expect(result).toBeInstanceOf(Failed)
  })

  it('cancels cleanly mid-render', async () => {
    const { svc } = setup({ page_count: 5 })
    const job = svc.export('out.pdf')
    job.cancel()
    expect(await job.result()).toBeInstanceOf(Cancelled)
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
    const export_pdf = vi.fn(() => Promise.resolve(new Uint8Array([8])))
    const { svc } = setup({
      mode: Mode.SCANNED, export_format: 'PDF',
      adapter: { export_pdf_vector, export_pdf },
    })
    await svc.export('out.pdf').result()
    expect(export_pdf_vector).not.toHaveBeenCalled()
    expect(export_pdf).toHaveBeenCalledTimes(1)
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
    const export_pdf = vi.fn(() => Promise.resolve(new Uint8Array([8])))
    const { svc } = setup({ mode: Mode.NORMAL, export_format: 'PDF', adapter: { export_pdf } })
    await svc.export('out.pdf').result()
    expect(export_pdf).toHaveBeenCalledTimes(1)
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
