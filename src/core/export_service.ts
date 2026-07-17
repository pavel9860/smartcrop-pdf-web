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
  type BatchJob, type BatchController, type PageBatchJob, Ok, Cancelled,
  start_batch, fail_batch, make_paint_yielder,
} from './batch'
import type { PageSize, RendererAdapter, OutputPage, VectorExportPage } from './model'
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
  live_auto_crop_for(p: number): Box | null
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
    // Image formats have a second, equally-long phase (encode + zip) after rendering; double the
    // BAR's total so it keeps advancing through encoding instead of freezing at 100% (bug: progress
    // bar completes, then a long invisible zip pass). PDF has no separate per-page encode phase —
    // true for both the raster and vector PDF paths, so total sizing is unaffected by which runs.
    // display_total stays the real page count either way — the doubled total is bar-smoothing
    // bookkeeping only, and must never surface as "2x more pages" in the counter text (bug).
    const total_views = this._ctx.view_total()
    const is_image = this._ctx.export_format() !== 'PDF'
    const total = is_image ? total_views * 2 : total_views
    // Vector export (§W9.3): NORMAL document, PDF output, adapter supports it. No rasterization —
    // crop/rotate/split go straight through pdf-lib embedPage/copyPages against the original page
    // content.
    const use_vector = this._ctx.mode() === Mode.NORMAL && this._ctx.export_format() === 'PDF'
      && this._adapter.export_pdf_vector !== undefined
    return start_batch(`Exporting ${this._ctx.export_format()}…`, total, job =>
      use_vector ? this._run_export_vector(job, filename) : this._run_export(job, filename),
      total_views)
  }

  private async _run_export(job: PageBatchJob, filename: string): Promise<void> {
    const ctrl = job.controller
    const target_long_px = this._resolved_target_long_px()
    const greyscale = this._ctx.output_colours() === 'Grayscale'

    const pages_out = await this._render_export_pages(ctrl, target_long_px, greyscale)
    if (!pages_out) return

    try {
      const format = this._ctx.export_format()
      if (format === 'PDF') {
        const bytes = await this._adapter.export_pdf(pages_out)
        this._download_pdf(bytes, filename)
      } else {
        // Strip any extension off the suggested name — the archive is `<base>.zip` and entries
        // are `<base>_NNN.<ext>`; a name like "doc_cropped.png" would yield "doc_cropped.png.zip".
        const base = filename.replace(/\.[^.]+$/, '')
        const zip = await this._adapter.export_images(
          pages_out, format, base,
          (done, total) => { if (total > 0) ctrl.advance() })
        this._download_zip(zip, base)
      }
    } catch (e) {
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

  private async _render_export_pages(
    ctrl: BatchController,
    target_long_px: number | null, greyscale: boolean,
  ): Promise<OutputPage[] | null> {
    const pages_out: OutputPage[] = []
    const yield_to_paint = make_paint_yielder()
    for (let p = 0; p < this._ctx.page_count(); p++) {
      if (ctrl.is_cancelled) { ctrl.complete(new Cancelled()); return null }
      const sz = this._ctx.page_dims(p)
      try {
        const src   = await this._raster.get_work(p)
        const boxes = this._export_boxes_for_page(p, sz)
        for (const box of boxes) {
          const bitmap = await this._adapter.render_output_image(
            src, box, sz.width, sz.height, target_long_px, greyscale)
          pages_out.push({ bitmap, width: bitmap.width, height: bitmap.height })
          ctrl.advance()
        }
      } catch (e) {
        fail_batch(ctrl, e)
        return null
      }
      // Yield so the progress overlay repaints (render_output_image runs on the main thread) —
      // gated on elapsed time (PAINT_YIELD_INTERVAL_MS), not once per page.
      await yield_to_paint()
    }
    return pages_out
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

  private _export_boxes_for_page(p: number, sz: PageSize): Box[] {
    const committed = this._ctx.document().applied.get(p)
    if (committed) return committed
    const live = this._ctx.live_auto_crop_for(p)
    if (live) return [live]
    return [{ x0: 0, y0: 0, x1: sz.width, y1: sz.height }]
  }
}
