// DetectionService (§18 AppModel decomposition, step 5/7) — Auto-detect (spec-web §5). Does not
// own the detection-result state (detect_cache/union/auto_active): AppModel still owns it, read
// by CropController, PageOpsService, and AppModel's own apply_crop/_live_auto_crop_for too — the
// same "shared state stays on AppModel, exposed live" pattern those already established. This
// service owns the ALGORITHM (run detect over a page set, aggregate the union, refresh committed
// crops), not the data.
import type { Box } from './geometry'
import {
  auto_crop_rect, centered_crop_rect, box_width, box_height, detection_union,
  split_rects_grid, translate_box, clamp_box_shift,
} from './geometry'
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

// Per-region detection results (split = 2/4, spec §5a) — parallel to DetectionState above but one
// entry per split region instead of one shared page-wide result. Non-undoable AppModel state, same
// tier as DetectionState (spec-web §12). Only the aggregated union is kept: unlike split=1 (where
// each page resolves its OWN crop from its own cached box at apply time, spec §6.2), split mode's
// crop_rects is a single template shared by every page (§5a) — there is no per-page anchor to read
// a per-page cache back out for, so retaining one would be dead state.
export interface RegionDetectionState {
  unions: (Box | null)[]   // per region index: cross-page union, spec §5
}

export interface DetectionContext {
  has_document(): boolean
  document(): DocumentState
  page_dims(p: number): PageSize
  mode(): Mode
  detection(): DetectionState
  set_detection(d: DetectionState): void
  region_detection(): RegionDetectionState
  set_region_detection(d: RegionDetectionState): void
  split_count(): 1 | 2 | 4
  same_size(): boolean
  current_page(): number
  anchor_left(): boolean
  anchor_top(): boolean
  keep_ratio(): boolean
  set_ratio(r: number): void
  outlier_pages(): number
  invalidate_output(p: number): void
  set_drawn(box: Box | null): void
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
    // A pending hand-drawn window takes precedence over the auto-crop everywhere it's read
    // (overlay, commit, export) — pressing Auto-detect must drop it immediately, synchronously,
    // not just compute a fresh union that stays invisible behind it (bug: Auto-detect silently a
    // no-op after a manual crop-window draw). Only meaningful at split = 1 (drawn is always null
    // at split > 1 already — CropController.set_split clears it), harmless either way.
    this._ctx.set_drawn(null)
    const n = this._ctx.split_count()
    if (n === 1) return start_batch('Detecting content…', pages.length, job => this._run_detect(job, pages))
    return start_batch('Detecting content…', pages.length * n, job => this._run_detect_split(job, pages, n))
  }

  // Aggregate per-page boxes into the union frame, excluding full-page fallback boxes (spec-web
  // §5) and applying the outlier tolerance (settings.detect_outlier_pages, spec-web §5) — the ONE
  // shared aggregation path for every caller (detect, rotate, delete rebuilds via PageOpsService,
  // split-region detect below). `size_of` defaults to the page's own dims (whole-page detect);
  // split-region detect passes the region's own dims so a box spanning the whole REGION (not the
  // whole page) is what counts as a "full page" fallback to exclude, same relative meaning.
  compute_union(per_page_boxes: ReadonlyMap<number, Box>, size_of?: (p: number) => PageSize): Box | null {
    const sizeOf = size_of ?? ((p: number): PageSize => this._ctx.page_dims(p))
    const valid: Box[] = []
    for (const [p, box] of per_page_boxes) {
      const sz = sizeOf(p)
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

  // `region_of`, if given (split-region detect below), scopes each page's detection to that
  // page's own region sub-rectangle instead of the whole page — same detection call either way,
  // just with a Box passed through to the adapter (spec §5a).
  private async _detect_each_page(
    ctrl: BatchController, pages: readonly number[], region_of?: (p: number) => Box,
  ): Promise<Map<number, Box> | null> {
    const per_page_boxes = new Map<number, Box>()
    const yield_to_paint = make_paint_yielder()
    for (const p of pages) {
      if (ctrl.is_cancelled) { ctrl.complete(new Cancelled()); return null }
      try {
        const size = this._ctx.page_dims(p)
        const orig = this._page_index.orig(p)
        const region = region_of?.(p)
        let box: Box | null
        if (this._ctx.mode() === Mode.NORMAL) {
          // NORMAL: text-layer box ONLY — no rasterisation, no OpenCV, ever (spec-web §5). A page
          // with no extractable text (rare: vector-art/no-text page, still classified NORMAL by
          // is_native_page's vector-op check) simply gets no detected box — every downstream
          // consumer (AppModel's _compute_crop_boxes_for_page/_live_auto_crop_for) already
          // null-checks `detected` and degrades to "no auto-crop for this page" correctly.
          box = this._adapter.detect_text_box ? await this._adapter.detect_text_box(orig, region) : null
        } else {
          // SCANNED: raster/Sauvola on the RAW source, never the processed work image — running
          // dewarp+filter first would be pure waste (detect_content_box downscales to
          // DETECT_MAX_PX and re-binarizes anyway). This is what makes Auto-detect meet its
          // <0.1 s/page budget (spec-web §16).
          const img = await this._raster.get_source(p)
          box = await this._adapter.detect_content_box(img, size.width, size.height, this._ctx.mode(), region)
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

  // Re-detect refreshes committed crops without dropping them (spec-web §4.5). A page with no
  // detected content of its own still refreshes to the centered fallback (bug #8/#9), not skipped.
  private _refresh_committed_crops_after_detect(pages: readonly number[], union: Box | null): void {
    if (!union) return
    const doc = this._ctx.document()
    const det = this._ctx.detection()
    if (!this._ctx.anchor_left() && !this._ctx.anchor_top()) return
    for (const p of pages) {
      if (!doc.applied.has(p)) continue
      const detected = det.cache.get(p)
      const sz = this._ctx.page_dims(p)
      const rect = detected
        ? auto_crop_rect(detected, union, doc.offsets,
            sz.width, sz.height, this._ctx.anchor_left(), this._ctx.anchor_top())
        : centered_crop_rect(union, sz.width, sz.height)
      doc.applied.set(p, [rect])
      this._ctx.invalidate_output(p)
    }
  }

  // Auto-detect at split = 2/4 (spec §4.5/§5a): detection runs independently within each of the N
  // split regions (the same even grid split_rects_grid seeds, §7.4) — a page's left half doesn't
  // influence its right half's detected box. Each region aggregates its own cross-page union
  // (same FULL_PAGE_FRAC-excluding compute_union as whole-page detect, judged against the
  // region's own size), and the N resulting boxes replace `crop_rects` wholesale — the same
  // "one shared template applied to every page" model split mode already uses (set_split's grid
  // seed, a split drag), not a per-page-varying result: crop_rects has no per-page dimension to
  // vary into.
  private async _run_detect_split(job: PageBatchJob, pages: readonly number[], n: 2 | 4): Promise<void> {
    const ctrl = job.controller
    if (!this._ctx.has_document()) { ctrl.complete(new Cancelled()); return }

    const unions: (Box | null)[] = []
    for (let r = 0; r < n; r++) {
      const region_of = (p: number): Box => {
        const sz = this._ctx.page_dims(p)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- r < n by construction
        return split_rects_grid(n, sz.width, sz.height)[r]!
      }
      const per_region = await this._detect_each_page(ctrl, pages, region_of)
      if (!per_region) return   // cancelled or failed; ctrl already completed
      unions.push(this.compute_union(per_region, (p) => {
        const sz = this._ctx.page_dims(p)
        const region = split_rects_grid(n, sz.width, sz.height)[r]
        return region ? { width: box_width(region), height: box_height(region) } : sz
      }))
    }

    this._history.push(this._ctx.document())
    this._ctx.set_region_detection({ unions })
    this._write_split_crop_rects(pages, n, unions)

    ctrl.complete(new Ok())
  }

  // Resolves the N region unions into a fresh `crop_rects` — the auto-detected equivalent of
  // split_rects_grid's blind seed. Each region's window is exactly that region's own union
  // (clamped to the region) — NOT anchored to any single page's own detected box: crop_rects is
  // one template shared by every page (§5a), so anchoring it to "whichever page happens to be
  // current" would make the result depend on incidental navigation state instead of the detected
  // content — confirmed as a real bug (window position/size changing between identical re-detects
  // depending on which page was open, and a gap between adjacent regions' windows on pages whose
  // own content didn't happen to reach the region boundary) and fixed by using the union directly,
  // which is already the deterministic, tightest box enclosing every selected page's content in
  // that region. `Anchor Left`/`Anchor Top` keep their existing gate — at least one must be on for
  // a crop to exist — but no longer affect split-mode positioning; there is no per-page anchor
  // point to nudge away from once the result is a single shared template (unlike split=1, spec
  // §6.2, where each page resolves its own crop from its own cached box at apply time).
  // Same-size ON: every region's window grows to the LARGEST union size across all N regions,
  // still anchored at its own union's own top-left corner (clamp_box_shift's own overhang rule
  // handles a region too small to fit it).
  private _write_split_crop_rects(pages: readonly number[], n: 2 | 4, unions: (Box | null)[]): void {
    if (!this._ctx.anchor_left() && !this._ctx.anchor_top()) return
    const sz = this._ctx.page_dims(this._ctx.current_page())
    const regions = split_rects_grid(n, sz.width, sz.height)
    const same_size = this._ctx.same_size()
    const max_w = same_size ? Math.max(0, ...unions.map(u => u ? box_width(u) : 0)) : 0
    const max_h = same_size ? Math.max(0, ...unions.map(u => u ? box_height(u) : 0)) : 0

    const rects: Box[] = regions.map((region, r) => {
      const union = unions[r]
      if (!union) return region   // nothing detected in this region on any page -> full region
      const region_w = box_width(region), region_h = box_height(region)
      const union_local = translate_box(union, -region.x0, -region.y0)
      const effective_union = same_size
        ? { x0: union_local.x0, y0: union_local.y0, x1: union_local.x0 + max_w, y1: union_local.y0 + max_h }
        : union_local
      return translate_box(clamp_box_shift(effective_union, region_w, region_h), region.x0, region.y0)
    })

    const doc = this._ctx.document()
    doc.crop_rects = rects
    // Re-detect refreshes already-committed split pages instead of dropping them (mirrors
    // _refresh_committed_crops_after_detect's split=1 behaviour, spec §4.5).
    for (const p of pages) {
      if (!doc.applied.has(p)) continue
      doc.applied.set(p, [...rects])
      this._ctx.invalidate_output(p)
    }
  }
}
