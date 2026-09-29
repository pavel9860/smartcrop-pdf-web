// ExportService (§18 AppModel decomposition, step 7/7) — PDF/image export (spec-web §10, §W9.3).
// Vector export (NORMAL document, PDF output, adapter supports it) goes straight through pdf-lib
// against the original page content, no rasterization; every other case rasterizes each page via
// render_output_image, the ONE raster export path (CLAUDE.md).
import type { Box } from './geometry'
import type { DocumentState } from './document_state'
import { Mode } from './enums'
import {
  type ExportFormat,
  DPI_PRESETS, CUSTOM_DPI_PRESET, PAPER_SIZES, DEFAULT_PAPER, CUSTOM_PAPER_PRESET,
} from './constants'
import {
  type BatchJob, type PageBatchJob, Ok, Cancelled,
  start_batch, fail_batch, make_paint_yielder,
} from './batch'
import type { PageSize, RendererAdapter, VectorExportPage } from './model'
import type { PageIndexMap } from './page_index_map'
import type { PageRasterPipeline } from './page_raster_pipeline'

export interface ExportContext {
  document(): DocumentState
  page_dims(p: number): PageSize
  page_count(): number
  mode(): Mode
  view_total(): number
  file_names(): string[]
  output_postfix(): string
  export_format(): ExportFormat
  output_colours(): string
  compress_preset(): string
  custom_dpi(): number
  paper_size(): string
  custom_paper_in(): number
}

export class ExportService {
  // Set by AppController after construction to wire up download handling
  private _download_pdf: (bytes: Uint8Array, name: string) => void = () => { return }
  private _download_zip: (bytes: Uint8Array, base: string) => void = () => { return }

  constructor(
    private readonly _adapter: RendererAdapter,
    private readonly _raster: PageRasterPipeline,
    private readonly _page_index: PageIndexMap,
    private readonly _ctx: ExportContext,
  ) {}

  set_download_handlers(
    pdf: (bytes: Uint8Array, name: string) => void,
    zip: (bytes: Uint8Array, base: string) => void,
  ): void {
    this._download_pdf = pdf
    this._download_zip = zip
  }

  suggested_export_name(): string {
    const base = this._ctx.file_names()[0]?.replace(/\.[^.]+$/, '') ?? 'document'
    const name = base + this._ctx.output_postfix()
    const fmt = this._ctx.export_format()
    const ext = fmt === 'PDF' ? '.pdf' : fmt === 'JPG' ? '.jpg' : fmt === 'TIFF' ? '.tif' : '.png'
    return name + ext
  }

  export(filename: string): BatchJob {
    // Vector export (§W9.3): NORMAL document, PDF output, adapter supports it. No rasterization —
    // crop/rotate/split go straight through pdf-lib embedPage/copyPages against the original page
    // content.
    const use_vector = this._ctx.mode() === Mode.NORMAL && this._ctx.export_format() === 'PDF'
      && this._adapter.export_pdf_vector !== undefined
    return start_batch(`Saving ${this._ctx.export_format()}…`, this._ctx.view_total(), job =>
      use_vector ? this._run_export_vector(job, filename) : this._run_export(job, filename))
  }

  // Streams pages through the adapter's export sink (spec-web §21 #9): each page is rendered, then
  // handed off to be encoded while the next one renders — at most one raw bitmap waits in flight.
  private async _run_export(job: PageBatchJob, filename: string): Promise<void> {
    const ctrl = job.controller
    const target_long_px = this._resolved_target_long_px()
    const greyscale = this._ctx.output_colours() === 'Grayscale'
    const format = this._ctx.export_format()
    // The archive is `<base>.zip` with `<base>_NNN.<ext>` entries — strip any extension first.
    const base = filename.replace(/\.[^.]+$/, '')
    const sink = this._adapter.begin_export(format, base)
    const yield_to_paint = make_paint_yielder()
    let in_flight: Promise<void> = Promise.resolve()
    try {
      for (let p = 0; p < this._ctx.page_count(); p++) {
        const sz = this._ctx.page_dims(p)
        const src = await this._raster.get_work(p)
        for (const box of this._export_boxes_for_page(p, sz)) {
          if (ctrl.is_cancelled) { await in_flight.catch(() => undefined); sink.abort(); ctrl.complete(new Cancelled()); return }
          const bitmap = await this._adapter.render_output_image(src, box, sz.width, sz.height, target_long_px, greyscale)
          await in_flight
          in_flight = sink.add({ bitmap, width: bitmap.width, height: bitmap.height }).then(() => { ctrl.advance() })
        }
        await yield_to_paint()
      }
      await in_flight
      const bytes = await sink.finish()
      if (format === 'PDF') this._download_pdf(bytes, filename)
      else this._download_zip(bytes, base)
    } catch (e) {
      sink.abort()
      fail_batch(ctrl, e)
      return
    }
    ctrl.complete(new Ok())
  }

  // Vector counterpart to _run_export: builds VectorExportPage entries (current-frame box +
  // rotation per source page — the adapter converts to the source's native frame itself) and
  // hands off to the adapter in one call. No render_output_image, no OffscreenCanvas here — box
  // resolution is the only work done on this thread; the adapter defensively falls back to
  // _run_export if export_pdf_vector is somehow missing (export() already checks this ­— belt and
  // braces, since this method could in principle be called directly by a future caller).
  private async _run_export_vector(job: PageBatchJob, filename: string): Promise<void> {
    const ctrl = job.controller
    if (!this._adapter.export_pdf_vector) { await this._run_export(job, filename); return }

    const pages: VectorExportPage[] = []
    for (let p = 0; p < this._ctx.page_count(); p++) {
      if (ctrl.is_cancelled) { ctrl.complete(new Cancelled()); return }
      const sz = this._ctx.page_dims(p)
      const boxes = this._export_boxes_for_page(p, sz)
      pages.push({
        orig_page: this._page_index.orig(p),
        boxes,
        page_w: sz.width, page_h: sz.height,
        rotation: this._ctx.document().rotation.get(p) ?? 0,
      })
      for (let i = 0; i < boxes.length; i++) ctrl.advance()
    }

    try {
      const bytes = await this._adapter.export_pdf_vector(pages)
      this._download_pdf(bytes, filename)
    } catch (e) {
      fail_batch(ctrl, e)
      return
    }
    ctrl.complete(new Ok())
  }

  // Resolve the export target LONG-SIDE pixel count (spec-web §W2 row 8): the output page's long
  // side is assumed to be the paper height, so long side = dpi × paper_height_in. 'Custom' compress
  // preset uses custom_dpi; 'Custom' paper_size uses custom_paper_in; null = keep source
  // resolution. Export-only, never the preview.
  private _resolved_target_long_px(): number | null {
    const dpi = this._ctx.compress_preset() === CUSTOM_DPI_PRESET
      ? this._ctx.custom_dpi()
      : (DPI_PRESETS[this._ctx.compress_preset()] ?? null)
    if (dpi === null) return null
    const papers: Record<string, { width_in: number; height_in: number }> = PAPER_SIZES
    const height_in = this._ctx.paper_size() === CUSTOM_PAPER_PRESET
      ? this._ctx.custom_paper_in()
      : (papers[this._ctx.paper_size()] ?? PAPER_SIZES[DEFAULT_PAPER]).height_in
    return Math.round(dpi * height_in)
  }

  // Only a committed crop (Crop/Split & Crop) affects the exported file — an active but
  // uncommitted live auto-crop or drawn window is a preview only (spec-web §10.6).
  private _export_boxes_for_page(p: number, sz: PageSize): Box[] {
    const committed = this._ctx.document().applied.get(p)
    if (committed) return committed
    return [{ x0: 0, y0: 0, x1: sz.width, y1: sz.height }]
  }
}
