// DetectionService (§18 AppModel decomposition, step 5/7) — Auto-detect (spec-web §5). Does not
// own the detection-result state (detect_cache/union/auto_active): AppModel still owns it, read
// by CropController, PageOpsService, and AppModel's own apply_crop/_live_auto_crop_for too — the
// same "shared state stays on AppModel, exposed live" pattern those already established. This
// service owns the ALGORITHM (run detect over a page set, aggregate the union, refresh committed
// crops), not the data.
import type { Box } from './geometry'
import { auto_crop_rect, box_width, box_height, detection_union } from './geometry'
import type { DocumentState } from './document_state'
import type { History } from './history'
import { FULL_PAGE_FRAC } from './constants'
import { Mode } from './enums'
import {
  type BatchJob, type BatchController, type PageBatchJob, Ok, Cancelled,
  start_batch, fail_batch, make_paint_yielder,
} from './batch'
import type { PageSize, RendererAdapter } from './model'
import type { PageIndexMap } from './page_index_map'
import type { PageRasterPipeline } from './page_raster_pipeline'
import type { DetectionState } from './page_ops_service'

export interface DetectionContext {
  has_document(): boolean
  document(): DocumentState
  page_dims(p: number): PageSize
  mode(): Mode
  detection(): DetectionState
  set_detection(d: DetectionState): void
  anchor_left(): boolean
  anchor_top(): boolean
  keep_ratio(): boolean
  set_ratio(r: number): void
  outlier_pages(): number
  invalidate_output(p: number): void
}

export class DetectionService {
  constructor(
    private readonly _adapter: RendererAdapter,
    private readonly _history: History,
    private readonly _raster: PageRasterPipeline,
    private readonly _page_index: PageIndexMap,
    private readonly _ctx: DetectionContext,
  ) {}

  detect(pages: readonly number[]): BatchJob {
    return start_batch('Detecting content…', pages.length, job => this._run_detect(job, pages))
  }

  // Aggregate per-page boxes into the union frame, excluding full-page fallback boxes (spec-web
  // §5) and applying the outlier tolerance (settings.detect_outlier_pages, spec-web §5) — the ONE
  // shared aggregation path for every caller (detect, rotate, delete rebuilds via PageOpsService).
  compute_union(per_page_boxes: ReadonlyMap<number, Box>): Box | null {
    const valid: Box[] = []
    for (const [p, box] of per_page_boxes) {
      const sz = this._ctx.page_dims(p)
      if (box_width(box) / sz.width < FULL_PAGE_FRAC || box_height(box) / sz.height < FULL_PAGE_FRAC) {
        valid.push(box)
      }
    }
    return valid.length > 0 ? detection_union(valid, this._ctx.outlier_pages()) : null
  }

  private async _run_detect(job: PageBatchJob, pages: readonly number[]): Promise<void> {
    const ctrl = job.controller
    if (!this._ctx.has_document()) { ctrl.complete(new Cancelled()); return }

    const per_page_boxes = await this._detect_each_page(ctrl, pages)
    if (!per_page_boxes) return   // cancelled or failed; ctrl already completed

    const union = this.compute_union(per_page_boxes)

    // detect_cache/union/auto_active are non-undoable working state (spec-web §12). history.push
    // still runs here — it protects _refresh_committed_crops_after_detect's `applied` writes
    // below, which remain undoable.
    this._history.push(this._ctx.document())
    const det = this._ctx.detection()
    for (const [p, box] of per_page_boxes) det.cache.set(p, box)
    this._ctx.set_detection({ cache: det.cache, union, auto_active: true })

    this._refresh_committed_crops_after_detect(pages, union)
    // Ratio source is the detection UNION's aspect ratio, not the page's (model.py:375-376
    // _finish_detect) — keep-ratio locks the crop to the shape of the detected content, not the
    // whole page.
    if (!this._ctx.keep_ratio() && union && box_height(union) > 0) {
      this._ctx.set_ratio(box_width(union) / box_height(union))
    }

    ctrl.complete(new Ok())
  }

  private async _detect_each_page(
    ctrl: BatchController, pages: readonly number[],
  ): Promise<Map<number, Box> | null> {
    const per_page_boxes = new Map<number, Box>()
    const yield_to_paint = make_paint_yielder()
    for (const p of pages) {
      if (ctrl.is_cancelled) { ctrl.complete(new Cancelled()); return null }
      try {
        const size = this._ctx.page_dims(p)
        const orig = this._page_index.orig(p)
        let box: Box | null
        if (this._ctx.mode() === Mode.NORMAL) {
          // NORMAL: text-layer box ONLY — no rasterisation, no OpenCV, ever (spec-web §5). A page
          // with no extractable text (rare: vector-art/no-text page, still classified NORMAL by
          // is_native_page's vector-op check) simply gets no detected box — every downstream
          // consumer (AppModel's _compute_crop_boxes_for_page/_live_auto_crop_for) already
          // null-checks `detected` and degrades to "no auto-crop for this page" correctly.
          box = this._adapter.detect_text_box ? await this._adapter.detect_text_box(orig) : null
        } else {
          // SCANNED: raster/Sauvola on the RAW source, never the processed work image — running
          // dewarp+filter first would be pure waste (detect_content_box downscales to
          // DETECT_MAX_PX and re-binarizes anyway). This is what makes Auto-detect meet its
          // <0.1 s/page budget (spec-web §16).
          const img = await this._raster.get_source(p)
          box = await this._adapter.detect_content_box(img, size.width, size.height, this._ctx.mode())
        }
        if (box) per_page_boxes.set(p, box)
      } catch (e) {
        fail_batch(ctrl, e)
        return null
      }
      ctrl.advance()
      // Yield so the progress overlay repaints (matches ScanProcessingService/ExportService's
      // loops) — gated on elapsed time (PAINT_YIELD_INTERVAL_MS), not once per page.
      await yield_to_paint()
    }
    return per_page_boxes
  }

  // Re-detect refreshes committed crops without dropping them (spec-web §4.5)
  private _refresh_committed_crops_after_detect(pages: readonly number[], union: Box | null): void {
    if (!union) return
    const doc = this._ctx.document()
    const det = this._ctx.detection()
    for (const p of pages) {
      if (!doc.applied.has(p)) continue
      const detected = det.cache.get(p)
      if (!detected || !(this._ctx.anchor_left() || this._ctx.anchor_top())) continue
      const sz = this._ctx.page_dims(p)
      const rect = auto_crop_rect(detected, union, doc.offsets,
        sz.width, sz.height, this._ctx.anchor_left(), this._ctx.anchor_top())
      doc.applied.set(p, [rect])
      this._ctx.invalidate_output(p)
    }
  }
}
