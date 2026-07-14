// AppModel — single facade; owns all domain state (ARCHITECTURE §5, CLAUDE.md).
// ui/ calls only public methods and reads only the frozen value objects they return.
// core/ never imports DOM, Worker, pdf-lib, or pdfjs-dist.

import {
  type DocumentState, type Offsets, type PageProcessIntent,
  default_document_state, DEFAULT_OFFSETS,
} from './document_state'
import { History } from './history'
import { type Settings, default_settings } from './settings'
import { PageIndexMap } from './page_index_map'
import { PageRasterPipeline } from './page_raster_pipeline'
import { CropController } from './crop_controller'
import {
  type Box,
  auto_crop_rect, keep_ratio_normalise,
  rotate_box_cw, reindex_map, detection_union,
  box_width, box_height,
} from './geometry'
import { type BatchJob, type BatchController, PageBatchJob, Ok, Cancelled, Failed } from './batch'
import { Mode, FilterMode, PagesMode } from './enums'
import {
  NoDocumentError, EmptySelectionError, InvalidSplitError,
  DeleteAllPagesError, ImagingError,
} from './errors'
import {
  NORMAL_DPI, NORMAL_DISPLAY_DPI_MAX, DPI_PRESETS, EXPORT_FORMATS,
  DEFAULT_UNDO_DEPTH, FULL_PAGE_FRAC,
  FILTER_STRENGTH_MIN, FILTER_STRENGTH_MAX, UNDO_DEPTH_MIN, UNDO_DEPTH_MAX,
  SYNTH_W, SYNTH_H, type ExportFormat,
  CUSTOM_DPI_PRESET, CUSTOM_DPI_MIN, CUSTOM_DPI_MAX,
  PAPER_SIZES, DEFAULT_PAPER, CUSTOM_PAPER_PRESET, CUSTOM_PAPER_MIN, CUSTOM_PAPER_MAX,
} from './constants'
import { resolve_pages } from './parsing'
import {
  output_page_count, view_to_source,
} from './viewmodel'

// ---------------------------------------------------------------------------
// Injected async adapter (keeps core/ DOM-free, fully unit-testable with mocks)
// ---------------------------------------------------------------------------

export interface PageSize { width: number; height: number }

export interface DocInfo {
  page_count: number
  page_sizes: PageSize[]
  file_names: string[]   // for window title / suggested export name
  mode: Mode
  // True only for the no-file-open placeholder document (spec-web §1). Pages of a
  // synthetic doc have no PageSource; they must render via make_synth_page, not
  // get_source_image. Omitted (falsy) for every real load.
  synthetic?: boolean
}

export interface OutputPage {
  bitmap: ImageBitmap
  width:  number
  height: number
}

// One source page's vector-export instructions (spec-web §W9.3). `boxes` is normally length 1;
// a split page (crop_rects committed as N boxes) becomes N output pages from the SAME source.
// page_w/page_h/rotation are the page's CURRENT (already rotation-adjusted) values, i.e. exactly
// what _page_dims/document.rotation already carry — the adapter converts back to the source's
// native frame itself (geometry.ts::to_native_frame), core/ does not need to know that frame exists.
export interface VectorExportPage {
  readonly orig_page: number
  readonly boxes:     readonly Box[]
  readonly page_w:    number
  readonly page_h:    number
  readonly rotation:  number
}

export interface RendererAdapter {
  load_files(files: File[]): Promise<DocInfo>
  get_source_image(page_idx: number, dpi: number, rotation: number): Promise<ImageBitmap>
  // Scan processing (dewarp/filter) applied to an ALREADY-rendered source bitmap. Taking the
  // source (not a page index) means the model renders each page exactly once and hands that raster
  // straight to processing — no second internal rasterization (spec-web §W2 row 5).
  get_work_image(source: ImageBitmap, intent: PageProcessIntent,
                 supersample: number): Promise<ImageBitmap>
  // target_long_px: export sizing — the crop's long side scales to this many pixels
  // (= dpi × paper height, spec-web §W2 row 8); null = keep source resolution (and preview).
  render_output_image(src: ImageBitmap, box: Box, page_w: number, page_h: number,
                      target_long_px: number | null, greyscale: boolean): Promise<ImageBitmap>
  detect_content_box(img: ImageBitmap, page_w: number, page_h: number, mode: Mode): Promise<Box>
  // Fast NORMAL-mode detection from the PDF text layer (desktop detect.py normal_page_box) — no
  // image processing. Optional: absent/returns null → caller falls back to detect_content_box.
  detect_text_box?(page_idx: number): Promise<Box | null>
  // Disk (IndexedDB) tier of the two-tier processed-raster cache (spec-web §W2 row 5). The model
  // owns the opaque key (page + intent generation). All optional: an adapter without them (test
  // mocks) simply has no disk tier and the model recomputes on a RAM-cache miss.
  load_work?(key: string): Promise<ImageBitmap | null>
  persist_work?(key: string, bitmap: ImageBitmap): Promise<void>
  clear_work_cache?(): Promise<void>
  export_pdf(pages: OutputPage[]): Promise<Uint8Array>
  // Lossless vector PDF export for NORMAL-mode documents (spec-web §W9.3): crops/rotates/splits
  // via the ORIGINAL PDF page content (pdf-lib embedPage), never rasterizes. Optional — an adapter
  // without it (test mocks) simply means AppModel falls back to the raster export path.
  export_pdf_vector?(pages: readonly VectorExportPage[]): Promise<Uint8Array>
  export_images(
    pages: OutputPage[], format: 'JPG' | 'PNG' | 'TIFF', base: string,
    on_progress?: (done: number, total: number) => void,
  ): Promise<Uint8Array>
  make_synth_page(idx: number, w: number, h: number): Promise<ImageBitmap>
  close(): void
}

// ---------------------------------------------------------------------------
// ViewSnapshot — what canvas_view reads (frozen bundle)
// ---------------------------------------------------------------------------

export type OverlayKind = 'auto' | 'split' | 'committed'

export interface OverlayBox {
  readonly kind:  OverlayKind
  readonly box:   Box
  readonly idx?:  number   // 1-based split index (split mode)
}

export interface ViewSnapshot {
  readonly image:      ImageBitmap | null   // null = loading
  readonly page_w:     number
  readonly page_h:     number
  // Top-left of the coordinate space page_w/page_h/overlay/draw_rect live in, in full-page units.
  // {0,0} for a full page; the committed box's origin on a committed (cropped) page so canvas_view
  // can map pointer input and paint overlays into the zoomed cropped view (spec-web §W8).
  readonly crop_origin: { readonly x: number; readonly y: number }
  readonly overlay:    readonly OverlayBox[]
  readonly draw_rect:  Box | null
  readonly position:   number               // 1-based output-page
  readonly total:      number
  readonly status:     string               // drawn on canvas (spec §3.3)
  readonly is_loading: boolean
}

// ---------------------------------------------------------------------------
// AppModel
// ---------------------------------------------------------------------------

export class AppModel {
  // Undoable document state
  document: DocumentState = default_document_state()

  // Non-undoable model state
  private _doc:     DocInfo | null = null
  private _mode:    Mode = Mode.NORMAL
  private _current_page = 0    // 0-based source page
  private _view_pos = 1        // 1-based output-view position

  private _pages_mode   = PagesMode.ALL
  private _select_pattern = ''
  private _current_follow = false

  // Detection working state (not undoable — spec-web §12, moved out of DocumentState). Scaffolding
  // used to ARRIVE at a committed operation (applied/rotation), not an operation itself, so Undo
  // does not revert it: pressing Undo right after Auto-detect, before anything is committed via
  // Crop, is now a no-op. Reset on _reset_state/_run_detect/rotate/delete exactly as document.*
  // used to be. `_drawn` (the pending hand-drawn window) lives here rather than in CropController
  // because apply_crop/_compute_crop_boxes_for_page/_build_overlay all read it too, outside any
  // drag — CropController reaches it live through CropContext.
  private _drawn:        Box | null = null   // global hand-drawn window, page coords (§6.4)
  private _detect_cache = new Map<number, Box>()   // per-page content box from last detect
  private _union:        Box | null = null   // aggregate detection union (§5)
  private _auto_active   = false             // auto-detect was run at least once

  // NORMAL-mode preview render DPI (spec-web §2), resolved from the canvas' actual display size
  // via set_display_scale() — never below NORMAL_DPI, never above NORMAL_DISPLAY_DPI_MAX. Purely
  // a display/viewport concern: SCANNED's SRC_DPI is untouched, and no crop/geometry math reads
  // this (page units for NORMAL are PDF points, independent of render resolution).
  private _display_dpi = NORMAL_DPI

  // History and settings
  readonly history = new History(DEFAULT_UNDO_DEPTH)
  readonly settings: Settings = default_settings()

  // Logical page index -> original adapter page index (§18 PageIndexMap). Every adapter call
  // that takes a page index must translate through it.
  private _page_index = new PageIndexMap()

  // Raster cache/fetch pipeline (§18 PageRasterPipeline) — source/work/output caches, disk-tier
  // bookkeeping, and the currently-displayed bitmap. Wired with live callbacks into this
  // AppModel's own mode/DPI/rotation/scan-intent state, so the pipeline never holds a stale copy.
  private readonly _raster: PageRasterPipeline

  // Anchors/offsets/keep-ratio/split/same-size + the drag gesture state machine (§18
  // CropController). Wired with live callbacks for the detection/drawn-window state above, which
  // it reads but does not own.
  private readonly _crop: CropController

  constructor(private readonly _adapter: RendererAdapter) {
    this._raster = new PageRasterPipeline(_adapter, this._page_index, {
      mode: (): Mode => this._mode,
      display_dpi: (): number => this._display_dpi,
      is_synthetic: (): boolean => this._doc === null || !!this._doc.synthetic,
      rotation: (p): number => this.document.rotation.get(p) ?? 0,
      process_intent: (p): PageProcessIntent => this._page_process_intent(p),
      dewarp_supersample: (): number => this.settings.dewarp_supersample,
    })
    this._crop = new CropController(this.history, {
      document: (): DocumentState => this.document,
      has_document: (): boolean => this._doc !== null,
      current_page: (): number => this._current_page,
      page_dims: (p): PageSize => this._page_dims(p),
      detected: (p): Box | null => this._detect_cache.get(p) ?? null,
      union: (): Box | null => this._union,
      auto_active: (): boolean => this._auto_active,
      drawn: (): Box | null => this._drawn,
      set_drawn: (box): void => { this._drawn = box },
    })
  }

  // ---------------------------------------------------------------------------
  // Document
  // ---------------------------------------------------------------------------

  async load_files(files: File[]): Promise<void> {
    const info = await this._adapter.load_files(files)
    this._doc = info
    this._mode = info.mode
    this._reset_state()
  }

  async reset(): Promise<void> {
    if (!this._doc) return
    const info = await this._adapter.load_files([])   // re-open same files via adapter
    this._doc = info
    this._mode = info.mode
    this._reset_state()
  }

  private _reset_state(): void {
    this.document = default_document_state()
    this.history.clear()
    this._current_page = 0
    this._view_pos = 1
    this._pages_mode = PagesMode.ALL
    this._select_pattern = ''
    this._current_follow = false
    this._drawn = null
    this._detect_cache = new Map()
    this._union = null
    this._auto_active = false
    this._raster.reset()
    this._page_index.reset(this._doc ? this._doc.page_count : 0)
    // Keep-ratio initialises to the first page's real w/h, not a bare 1.0, so the ratio field
    // shows a meaningful default from the moment a document opens.
    const sz0 = this._doc?.page_sizes[0]
    this._crop.reset(sz0 && sz0.height > 0 ? sz0.width / sz0.height : 1.0)
  }

  get has_document(): boolean { return this._doc !== null }
  page_count(): number { return this._page_index.length }

  // Loaded document name for the sidebar's Document & State card. One file → its name; several →
  // "first.pdf +N more". Empty when nothing is loaded.
  get document_name(): string {
    const names = this._doc?.file_names ?? []
    const first = names[0] ?? ''
    return names.length > 1 ? `${first} +${names.length - 1} more` : first
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  get view_total(): number {
    if (!this._doc) return 0
    return output_page_count(this.page_count(), this.document.applied)
  }

  get view_position(): number { return this._view_pos }

  next_page(): void { this._go_to(this._view_pos + 1) }
  prev_page(): void { this._go_to(this._view_pos - 1) }
  jump_to_output_page(n: number): void { this._go_to(n) }

  private _go_to(pos: number): void {
    if (!this._doc) return
    const clamped = Math.max(1, Math.min(this.view_total, pos))
    this._view_pos = clamped
    const { src_page } = view_to_source(clamped, this.page_count(), this.document.applied)
    this._current_page = src_page
    // Follow toggle: keep pattern in sync
    if (this._current_follow && this._pages_mode === PagesMode.SELECT) {
      this._select_pattern = String(src_page + 1)
    }
    this._invalidate_current_bitmap()
  }

  // ---------------------------------------------------------------------------
  // Pages selection
  // ---------------------------------------------------------------------------

  set_pages_mode(mode: PagesMode): void {
    this._pages_mode = mode
    if (mode !== PagesMode.SELECT) this._current_follow = false
  }

  set_select_pattern(pattern: string): void {
    this._select_pattern = pattern
    this._current_follow = false   // editing pattern by hand turns follow off (spec §11)
  }

  set_current_follow(on: boolean): void {
    this._current_follow = on
    if (on) {
      this._pages_mode = PagesMode.SELECT
      this._select_pattern = String(this._current_page + 1)
    }
  }

  resolve_pages(): number[] {
    if (!this._doc) return []
    return resolve_pages(this._pages_mode, this.page_count(), this._select_pattern)
  }

  // ---------------------------------------------------------------------------
  // Crop / detect
  // ---------------------------------------------------------------------------

  get can_detect(): boolean {
    return this.has_document && this._crop.split_count === 1
      && (this._crop.anchor_left || this._crop.anchor_top)
  }

  get can_apply(): boolean {
    if (!this.has_document) return false
    if (this._crop.split_count === 1) return true
    return this.document.crop_rects.length === this._crop.split_count
  }

  detect_content(): BatchJob {
    const pages = this._require_pages()

    const job = new PageBatchJob('Detecting content…', pages.length)
    void this._run_detect(job, pages)
    return job
  }

  private async _run_detect(job: PageBatchJob, pages: number[]): Promise<void> {
    const ctrl = job.controller
    const doc = this._doc
    if (!doc) { ctrl.complete(new Cancelled()); return }

    const per_page_boxes = await this._detect_each_page(ctrl, pages)
    if (!per_page_boxes) return   // cancelled or failed; ctrl already completed

    const union = this._compute_detection_union(per_page_boxes)

    // detect_cache/union/auto_active are non-undoable working state (spec-web §12). history.push
    // still runs here — it protects _refresh_committed_crops_after_detect's `applied` writes
    // below, which remain undoable.
    this.history.push(this.document)
    for (const [p, box] of per_page_boxes) this._detect_cache.set(p, box)
    this._union = union
    this._auto_active = true

    this._refresh_committed_crops_after_detect(pages, union)
    // Ratio source is the detection UNION's aspect ratio, not the page's (model.py:375-376
    // _finish_detect) — keep-ratio locks the crop to the shape of the detected content, not
    // the whole page. A prior version of this port used _page_dims() here, which is wrong.
    if (!this._crop.keep_ratio && union && box_height(union) > 0) {
      this._crop.set_ratio(box_width(union) / box_height(union))
    }

    ctrl.complete(new Ok())
  }

  private async _detect_each_page(
    ctrl: BatchController, pages: number[],
  ): Promise<Map<number, Box> | null> {
    const per_page_boxes = new Map<number, Box>()
    for (const p of pages) {
      if (ctrl.is_cancelled) { ctrl.complete(new Cancelled()); return null }
      try {
        const size = this._page_dims(p)
        const orig = this._page_index.orig(p)
        let box: Box | null
        if (this._mode === Mode.NORMAL) {
          // NORMAL: text-layer box ONLY — no rasterisation, no OpenCV, ever (spec-web §5). A page
          // with no extractable text (rare: vector-art/no-text page, still classified NORMAL by
          // is_native_page's vector-op check) simply gets no detected box — every downstream
          // consumer (_compute_crop_boxes_for_page, _live_auto_crop_for, _begin_auto_drag) already
          // null-checks `detected` and degrades to "no auto-crop for this page" correctly.
          box = this._adapter.detect_text_box ? await this._adapter.detect_text_box(orig) : null
        } else {
          // SCANNED: raster/Sauvola on the RAW source, never the processed work image — running
          // dewarp+filter first would be pure waste (detect_content_box downscales to
          // DETECT_MAX_PX and re-binarizes anyway). This is what makes Auto-detect meet its
          // <0.1 s/page budget (spec-web §16).
          const img = await this._raster.get_source(p)
          box = await this._adapter.detect_content_box(img, size.width, size.height, this._mode)
        }
        if (box) per_page_boxes.set(p, box)
      } catch (e) {
        ctrl.complete(new Failed(new ImagingError(String(e))))
        return null
      }
      ctrl.advance()
      // Yield between pages so the progress overlay repaints (matches _run_warm/
      // _render_export_pages — without this the whole detect pass can run as one
      // paint-less burst: the bar looks frozen, then jumps to done, spec-web §11).
      await this._yield_to_paint()
    }
    return per_page_boxes
  }

  // Aggregate per-page boxes into the union frame, excluding full-page fallback boxes (spec-web
  // §5) and applying the outlier tolerance (settings.detect_outlier_pages, spec-web §5) — the
  // ONE shared aggregation path for every caller (detect, rotate, delete rebuilds).
  private _compute_detection_union(per_page_boxes: Map<number, Box>): Box | null {
    const valid: Box[] = []
    for (const [p, box] of per_page_boxes) {
      const sz = this._page_dims(p)
      if (box_width(box) / sz.width < FULL_PAGE_FRAC || box_height(box) / sz.height < FULL_PAGE_FRAC) {
        valid.push(box)
      }
    }
    return valid.length > 0 ? detection_union(valid, this.settings.detect_outlier_pages) : null
  }

  // Re-detect refreshes committed crops without dropping them (spec-web §4.5)
  private _refresh_committed_crops_after_detect(pages: number[], union: Box | null): void {
    if (!union) return
    for (const p of pages) {
      if (!this.document.applied.has(p)) continue
      const detected = this._detect_cache.get(p)
      if (!detected || !(this._crop.anchor_left || this._crop.anchor_top)) continue
      const sz = this._page_dims(p)
      const rect = auto_crop_rect(detected, union, this.document.offsets,
        sz.width, sz.height, this._crop.anchor_left, this._crop.anchor_top)
      this.document.applied.set(p, [rect])
      this._invalidate_output_cache(p)
    }
  }

  apply_crop(): void {
    const pages = this._require_pages()

    if (this._crop.split_count > 1 && this.document.crop_rects.length !== this._crop.split_count) {
      throw new InvalidSplitError(
        `Need exactly ${this._crop.split_count} split rectangles; have ${this.document.crop_rects.length}`)
    }

    this.history.push(this.document)

    // Export also commits live auto-crop for uncommitted pages (spec-web §10.6)
    for (const p of pages) {
      if (this._crop.split_count === 1) {
        const boxes = this._compute_crop_boxes_for_page(p)
        if (boxes) {
          this.document.applied.set(p, boxes)
          this._invalidate_output_cache(p)
        }
      } else {
        this.document.applied.set(p, [...this.document.crop_rects])
        this._invalidate_output_cache(p)
      }
    }
    this._drawn = null   // the drawn window became the crop across all pages (§12.2)
  }

  private _compute_crop_boxes_for_page(p: number): Box[] | null {
    const doc = this._doc
    if (!doc) return null
    const sz = this._page_dims(p)

    // Hand-drawn window takes precedence — clamp the global window to this page (§12.2).
    const drawn = this._drawn
    if (drawn) {
      return [{
        x0: Math.max(0, Math.min(drawn.x0, sz.width)),
        y0: Math.max(0, Math.min(drawn.y0, sz.height)),
        x1: Math.max(0, Math.min(drawn.x1, sz.width)),
        y1: Math.max(0, Math.min(drawn.y1, sz.height)),
      }]
    }

    const detected  = this._detect_cache.get(p)
    const union     = this._union

    if (detected && union && this._auto_active
        && (this._crop.anchor_left || this._crop.anchor_top)) {
      let rect = auto_crop_rect(detected, union, this.document.offsets,
        sz.width, sz.height, this._crop.anchor_left, this._crop.anchor_top)
      if (this._crop.keep_ratio) rect = keep_ratio_normalise(rect, this._crop.ratio, sz.width, sz.height)
      return [rect]
    }
    return null
  }

  // Anchors/offsets/keep-ratio/split/same-size, and the full drag gesture state machine
  // (spec-web §6.5/§6.6), are owned by CropController (§18) — these are 1-line delegations so
  // ui/ keeps calling AppModel's public surface unchanged.
  set_anchor(left: boolean | null, top: boolean | null): void { this._crop.set_anchor(left, top) }
  set_offset(edge: 'L' | 'T' | 'R' | 'B', value: number): void { this._crop.set_offset(edge, value) }
  commit_offsets(): void { this._crop.commit_offsets() }
  set_keep_ratio(on: boolean, ratio?: number): void { this._crop.set_keep_ratio(on, ratio) }
  set_split(n: 1 | 2 | 4): void { this._crop.set_split(n) }
  set_same_size(on: boolean): void { this._crop.set_same_size(on) }
  begin_drag(px: number, py: number, tol: number): void { this._crop.begin_drag(px, py, tol) }
  update_drag(px: number, py: number): void { this._crop.update_drag(px, py) }
  end_drag(): void { this._crop.end_drag() }
  cancel_drag(): void { this._crop.cancel_drag() }

  // ---------------------------------------------------------------------------
  // Scan processing
  // ---------------------------------------------------------------------------

  // Shared guard: every mutating/batch command requires a document and a non-empty page
  // selection before touching undoable state (99_FOUND_ISSUES 6b — was duplicated as an inline
  // 2-line check across detect_content/apply_crop/rotate_pages/delete_pages, plus a same-shaped
  // helper scoped to only the three scan-processing toggles below; M4 — set_filter_strength was
  // missing it entirely, unlike its two siblings, before that helper existed).
  private _require_pages(): number[] {
    if (!this.has_document) throw new NoDocumentError('No document loaded')
    const pages = this.resolve_pages()
    if (pages.length === 0) throw new EmptySelectionError('No pages in selection')
    return pages
  }

  // Scan toggles: the intent flips SYNCHRONOUSLY (undoable — history pushed first), then the
  // returned BatchJob pre-computes the selection's work rasters under the progress overlay
  // (spec-web §11), yielding to the event loop between pages so the overlay repaints and Cancel
  // works. A cancel keeps the intent: unprocessed pages fall back to on-view lazy compute in
  // _get_work — this avoids the earlier lazy-only design, which deferred ALL processing to view/
  // detect time and made scanned-mode Auto-detect and navigation pay render+OpenCV(+ONNX) per
  // page with no progress UI.
  run_dewarp(): BatchJob {
    const pages = this._require_pages()
    this.history.push(this.document)   // snapshot BEFORE the toggle so undo reverts it
    this.document.dewarp_on = !this.document.dewarp_on
    this._apply_scan_intents(pages)
    return this._warm_work_cache(pages, 'Dewarping…')
  }

  set_filter_mode(mode: FilterMode): BatchJob {
    const pages = this._require_pages()
    this.history.push(this.document)
    // Toggle: pressing the active filter turns it off (spec §7.2)
    this.document.filter_mode = (mode === this.document.filter_mode) ? FilterMode.NONE : mode
    this._apply_scan_intents(pages)
    return this._warm_work_cache(pages, 'Applying filter…')
  }

  set_filter_strength(n: number): BatchJob {
    const pages = this._require_pages()
    this.history.push(this.document)
    this.document.filter_strength =
      Math.max(FILTER_STRENGTH_MIN, Math.min(FILTER_STRENGTH_MAX, n))
    this._apply_scan_intents(pages)
    return this._warm_work_cache(pages, 'Applying filter…')
  }

  private _warm_work_cache(pages: number[], title: string): BatchJob {
    const job = new PageBatchJob(title, pages.length)
    void this._run_warm(job, pages)
    return job
  }

  private async _run_warm(job: PageBatchJob, pages: number[]): Promise<void> {
    const ctrl = job.controller
    for (const p of pages) {
      if (ctrl.is_cancelled) { ctrl.complete(new Cancelled()); return }
      try {
        await this._raster.get_work(p)
      } catch (e) {
        ctrl.complete(new Failed(new ImagingError(String(e))))
        return
      }
      ctrl.advance()
      // Yield between pages so the progress overlay repaints (per-page OpenCV/ONNX blocks the
      // main thread; the yield restores §14's between-page responsiveness).
      await this._yield_to_paint()
    }
    ctrl.complete(new Ok())
  }

  // Record the CURRENT global scan flags as each selected page's intent and drop its cached
  // rasters. No image work here — the next _get_work(p) renders that page. (Callers push history
  // BEFORE mutating the flags, so undo reverts the toggle.)
  private _apply_scan_intents(pages: number[]): void {
    const intent: PageProcessIntent = {
      dewarp: this.document.dewarp_on,
      filter: this.document.filter_mode === FilterMode.NONE
        ? null
        : [this.document.filter_mode, this.document.filter_strength],
    }
    for (const p of pages) {
      this.document.processed.set(p, intent)
      this._raster.drop_work(p)
      this._invalidate_output_cache(p)
    }
    this._invalidate_current_bitmap()
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  undo(): void {
    const prev = this.history.undo(this.document)
    if (prev) {
      this.document = prev
      this._raster.clear_ram()
    }
  }

  redo(): void {
    const next = this.history.redo(this.document)
    if (next) {
      this.document = next
      this._raster.clear_ram()
    }
  }

  get can_undo(): boolean { return this.history.can_undo }
  get can_redo(): boolean { return this.history.can_redo }

  // ---------------------------------------------------------------------------
  // Output settings (outside History — survive Undo, spec §22)
  // ---------------------------------------------------------------------------

  set_compress_preset(name: string): void {
    if (name === CUSTOM_DPI_PRESET || name in DPI_PRESETS) this.settings.compress_preset = name
  }
  set_paper_size(name: string): void {
    if (name in PAPER_SIZES || name === CUSTOM_PAPER_PRESET) this.settings.paper_size = name
  }
  set_custom_paper_in(height_in: number): void {
    this.settings.custom_paper_in = Math.max(CUSTOM_PAPER_MIN, Math.min(CUSTOM_PAPER_MAX, height_in))
  }

  set_custom_dpi(dpi: number): void {
    this.settings.custom_dpi = Math.max(CUSTOM_DPI_MIN, Math.min(CUSTOM_DPI_MAX, Math.round(dpi)))
  }
  set_output_colours(mode: string): void { this.settings.output_colours = mode }
  set_export_format(fmt: string): void {
    if ((EXPORT_FORMATS as readonly string[]).includes(fmt)) {
      this.settings.export_format = fmt as ExportFormat
    }
  }
  set_undo_depth(depth: number): void {
    const d = Math.max(UNDO_DEPTH_MIN, Math.min(UNDO_DEPTH_MAX, depth))
    this.settings.undo_depth = d
    this.history.set_depth(d)
  }
  set_detect_outlier_pages(n: number): void {
    this.settings.detect_outlier_pages = Math.max(0, Math.round(n))
  }
  set_output_postfix(postfix: string): void { this.settings.output_postfix = postfix }
  set_dewarp_supersample(factor: number): void {
    this.settings.dewarp_supersample = Math.max(1.0, Math.min(4.0, factor))
  }

  // Resolve the export target LONG-SIDE pixel count (spec-web §W2 row 8): the output page's long
  // side is assumed to be the paper height, so long side = dpi × paper_height_in. 'Custom' compress
  // preset uses settings.custom_dpi; 'Custom' paper_size uses settings.custom_paper_in; null = keep
  // source resolution. Export-only, never the preview.
  private _resolved_target_long_px(): number | null {
    const dpi = this.settings.compress_preset === CUSTOM_DPI_PRESET
      ? this.settings.custom_dpi
      : (DPI_PRESETS[this.settings.compress_preset] ?? null)
    if (dpi === null) return null
    const papers: Record<string, { width_in: number; height_in: number }> = PAPER_SIZES
    const height_in = this.settings.paper_size === CUSTOM_PAPER_PRESET
      ? this.settings.custom_paper_in
      : (papers[this.settings.paper_size] ?? PAPER_SIZES[DEFAULT_PAPER]).height_in
    return Math.round(dpi * height_in)
  }

  get output_postfix(): string { return this.settings.output_postfix }
  get dewarp_supersample(): number { return this.settings.dewarp_supersample }

  // ---------------------------------------------------------------------------
  // Rotate / delete
  // ---------------------------------------------------------------------------

  rotate_pages(): void {
    const pages = this._require_pages()

    this.history.push(this.document)
    for (const p of pages) this._rotate_page(p)
  }

  private _rotate_page(p: number): void {
    // Effective dims BEFORE this 90° step — box coords being carried through are still in
    // that (pre-step) frame. Must read before mutating rotation.
    const sz = this._page_dims(p)
    const cur_rot = this.document.rotation.get(p) ?? 0
    this.document.rotation.set(p, (cur_rot + 90) % 360)

    const app = this.document.applied.get(p)
    if (app) this.document.applied.set(p, app.map(b => rotate_box_cw(b, sz.height)))
    const det = this._detect_cache.get(p)
    if (det) this._detect_cache.set(p, rotate_box_cw(det, sz.height))

    this._raster.delete_page(p)

    this.document.offsets = DEFAULT_OFFSETS
    if (this._union) {
      // Rebuild with the SAME FULL_PAGE_FRAC exclusion the initial detect applies (bug 2a,
      // 99_FOUND_ISSUES): the old raw detection_union() re-admitted full-page fallback boxes after
      // a rotate, silently inflating every crop. Judged against each page's rotated dims.
      this._union = this._compute_detection_union(this._detect_cache)
    }
  }

  delete_pages(): void {
    const pages = this._require_pages()
    if (pages.length >= this.page_count()) throw new DeleteAllPagesError('Cannot delete all pages')

    const sorted = [...pages].sort((a, b) => a - b)
    const removed = new Set(sorted)

    // Delete is destructive, not undoable (clears history rather than snapshotting — spec-web §12
    // states Rotate is "Fully undoable" in explicit contrast). It can't be made undoable here
    // regardless: _page_index (below) lives outside DocumentState, so a restored applied/rotation
    // map could reference original page indices the map no longer has — the same class of desync
    // bug as the set_keep_ratio fix above, just for a field History can't reach.
    this.history.clear()

    // Reindex per-page maps (spec-web §12)
    this.document.applied   = reindex_map(this.document.applied,   sorted)
    this.document.rotation  = reindex_map(this.document.rotation,  sorted)
    this.document.processed = reindex_map(this.document.processed, sorted)
    this._detect_cache      = reindex_map(this._detect_cache,      sorted)

    // Rebuild the logical->original page index map (pdf.js has no in-place page-deletion
    // primitive, so this is a filter + reindex instead).
    // MUST precede the union rebuild below: _compute_detection_union reads each surviving page's
    // dimensions through _page_index, so it has to be reindexed first (bug 2a — the union was judged
    // against a stale page map).
    this._page_index.remove(removed)

    if (this._auto_active && this._detect_cache.size > 0) {
      // Same FULL_PAGE_FRAC exclusion the initial detect applies (bug 2a): the old raw
      // detection_union() re-admitted full-page fallback boxes, distorting the union after a delete.
      this._union = this._compute_detection_union(this._detect_cache)
      this._auto_active = this._union !== null
    } else {
      this._union = null
      this._auto_active = false
    }

    this._raster.clear_ram()
    this._current_page = Math.min(this._current_page, this.page_count() - 1)
    this._view_pos = Math.min(this._view_pos, this.view_total)
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  suggested_export_name(): string {
    const doc = this._doc
    const base = doc?.file_names[0]?.replace(/\.[^.]+$/, '') ?? 'document'
    const name = base + this.settings.output_postfix
    const ext  = this.settings.export_format === 'PDF' ? '.pdf'
               : this.settings.export_format === 'JPG' ? '.jpg'
               : this.settings.export_format === 'TIFF' ? '.tif' : '.png'
    return name + ext
  }

  export(filename: string): BatchJob {
    if (!this.has_document) throw new NoDocumentError('No document loaded')
    const doc = this._doc
    if (!doc) throw new NoDocumentError('No document loaded')

    // Image formats have a second, equally-long phase (encode + zip) after rendering; double the
    // total so the bar keeps advancing through encoding instead of freezing at 100% (bug: progress
    // bar completes, then a long invisible zip pass). PDF has no separate per-page encode phase —
    // true for both the raster and vector PDF paths, so total sizing is unaffected by which runs.
    const total_views = this.view_total
    const is_image = this.settings.export_format !== 'PDF'
    const job = new PageBatchJob(
      `Exporting ${this.settings.export_format}…`, is_image ? total_views * 2 : total_views)
    // Vector export (§W9.3): NORMAL document, PDF output, adapter supports it. No rasterization —
    // crop/rotate/split go straight through pdf-lib embedPage against the original page content.
    const use_vector = this._mode === Mode.NORMAL && this.settings.export_format === 'PDF'
      && this._adapter.export_pdf_vector !== undefined
    void (use_vector ? this._run_export_vector(job, filename) : this._run_export(job, filename))
    return job
  }

  private async _run_export(job: PageBatchJob, filename: string): Promise<void> {
    const ctrl = job.controller
    const target_long_px = this._resolved_target_long_px()
    const greyscale  = this.settings.output_colours === 'Grayscale'

    const pages_out = await this._render_export_pages(ctrl, target_long_px, greyscale)
    if (!pages_out) return

    try {
      if (this.settings.export_format === 'PDF') {
        const bytes = await this._adapter.export_pdf(pages_out)
        this._download_pdf(bytes, filename)
      } else {
        // Strip any extension off the suggested name — the archive is `<base>.zip` and entries
        // are `<base>_NNN.<ext>`; a name like "doc_cropped.png" would yield "doc_cropped.png.zip".
        const base = filename.replace(/\.[^.]+$/, '')
        const zip = await this._adapter.export_images(
          pages_out, this.settings.export_format, base,
          (done, total) => { if (total > 0) ctrl.advance() })
        this._download_zip(zip, base)
      }
    } catch (e) {
      ctrl.complete(new Failed(new ImagingError(String(e))))
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
    for (let p = 0; p < this.page_count(); p++) {
      if (ctrl.is_cancelled) { ctrl.complete(new Cancelled()); return }
      const sz = this._page_dims(p)
      const boxes = this._export_boxes_for_page(p, sz)
      pages.push({
        orig_page: this._page_index.orig(p),
        boxes,
        page_w: sz.width, page_h: sz.height,
        rotation: this.document.rotation.get(p) ?? 0,
      })
      for (let i = 0; i < boxes.length; i++) ctrl.advance()
    }

    try {
      const bytes = await this._adapter.export_pdf_vector(pages)
      this._download_pdf(bytes, filename)
    } catch (e) {
      ctrl.complete(new Failed(new ImagingError(String(e))))
      return
    }
    ctrl.complete(new Ok())
  }

  private async _render_export_pages(
    ctrl: BatchController,
    target_long_px: number | null, greyscale: boolean,
  ): Promise<OutputPage[] | null> {
    const pages_out: OutputPage[] = []
    for (let p = 0; p < this.page_count(); p++) {
      if (ctrl.is_cancelled) { ctrl.complete(new Cancelled()); return null }
      const sz = this._page_dims(p)
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
        ctrl.complete(new Failed(new ImagingError(String(e))))
        return null
      }
      // Yield to the event loop between pages so the progress overlay repaints. render_output_image
      // runs on the main thread (OpenCV/canvas); without this the tab visibly freezes for the whole
      // export (bug: ~20 s stall with a static bar before the save/download appears).
      await this._yield_to_paint()
    }
    return pages_out
  }

  // setTimeout(0) — not window/document, so core/ stays platform-agnostic (architecture.test.ts).
  private _yield_to_paint(): Promise<void> {
    return new Promise<void>(resolve => { setTimeout(resolve, 0) })
  }

  private _export_boxes_for_page(p: number, sz: PageSize): Box[] {
    const committed = this.document.applied.get(p)
    if (committed) return committed
    const live = this._live_auto_crop_for(p)
    if (live) return [live]
    return [{ x0: 0, y0: 0, x1: sz.width, y1: sz.height }]
  }

  // These are set by AppController after construction to wire up download handling
  private _download_pdf: (bytes: Uint8Array, name: string) => void = () => { return }
  private _download_zip: (bytes: Uint8Array, base: string) => void = () => { return }

  set_download_handlers(
    pdf: (bytes: Uint8Array, name: string) => void,
    zip: (bytes: Uint8Array, base: string) => void,
  ): void {
    this._download_pdf = pdf
    this._download_zip = zip
  }

  // ---------------------------------------------------------------------------
  // View snapshot (synchronous — reads pre-fetched bitmaps from cache)
  // ---------------------------------------------------------------------------

  view_snapshot(): ViewSnapshot {
    if (!this._doc) return this._synth_snapshot()

    const sz = this._current_page_size()
    const p  = this._current_page
    const { split_idx } = view_to_source(this._view_pos, this.page_count(), this.document.applied)

    const committed = this.document.applied.get(p)

    // A committed page STAYS shown cropped — at the CROP box's own dimensions, origin at the box's
    // top-left (crop_origin, so canvas_view maps pointer/overlay into the cropped view) — even while
    // a drawn window exists: the new window is an outline OVER the cropped view with no zoom change
    // (frozen spec §9.3). A plain committed page carries no outline (bug 18); it only appears once a
    // window is being drawn. The crop unzooms only on Undo or a split-mode switch.
    if (committed && committed.length > 0) {
      const box = committed[Math.min(split_idx, committed.length - 1)] ?? committed[0]
      return {
        image:  this._raster.output_at(p, split_idx),
        page_w: box ? box_width(box)  : sz.width,
        page_h: box ? box_height(box) : sz.height,
        crop_origin: box ? { x: box.x0, y: box.y0 } : { x: 0, y: 0 },
        overlay: this._committed_overlay(box),
        draw_rect:  this._crop.draw_rect,
        position:   this._view_pos,
        total:      this.view_total,
        status:     this._status_string(p, sz),
        is_loading: this._raster.is_loading,
      }
    }

    return {
      image:   this._raster.current,
      page_w:  sz.width,
      page_h:  sz.height,
      crop_origin: { x: 0, y: 0 },
      overlay: this._build_overlay(p),
      draw_rect:  this._crop.draw_rect,
      position:   this._view_pos,
      total:      this.view_total,
      status:     this._status_string(p, sz),
      is_loading: this._raster.is_loading,
    }
  }

  // The outline shown over a committed (cropped) page: only the drawn window, clamped to the crop
  // box so it can never paint outside the cropped view (spec-web §6.3). Empty when no window is
  // being drawn (a plain committed crop shows no frame — bug 18).
  private _committed_overlay(box: Box | undefined): OverlayBox[] {
    const drawn = this._drawn
    if (!drawn || !box) return []
    return [{ kind: 'committed', box: {
      x0: Math.max(box.x0, Math.min(drawn.x0, box.x1)),
      y0: Math.max(box.y0, Math.min(drawn.y0, box.y1)),
      x1: Math.max(box.x0, Math.min(drawn.x1, box.x1)),
      y1: Math.max(box.y0, Math.min(drawn.y1, box.y1)),
    } }]
  }

  // Reports the canvas' current physical-pixels-per-page-unit ratio (fit-to-canvas scale ×
  // devicePixelRatio) so NORMAL-mode preview can render sharp instead of upscaling a fixed-DPI
  // bitmap on a large window or a HiDPI display (spec-web §2). ui/ owns canvas sizing — core/
  // stays DOM-free by only ever receiving this one number, never reading canvas/window itself.
  // No-op for SCANNED: SRC_DPI stays fixed, the scan pipeline's perf budgets are tuned against it
  // (spec-web §16), and page units there are already raster px, not points.
  // Only re-renders when a MEANINGFULLY sharper bitmap is needed (>10%) — avoids re-rendering on
  // every pixel of a live window resize — and never downgrades back to a blurrier cached bitmap
  // once bumped up in this session.
  set_display_scale(px_per_page_unit: number): void {
    if (this._mode !== Mode.NORMAL || !(px_per_page_unit > 0)) return
    const needed = px_per_page_unit * 72   // page unit = PDF point = 1/72 inch; DPI = px/inch
    const resolved = Math.max(NORMAL_DPI, Math.min(NORMAL_DISPLAY_DPI_MAX, needed))
    if (resolved > this._display_dpi * 1.1) {
      this._display_dpi = resolved
      this._raster.clear_source()
      this._invalidate_current_bitmap()
    }
  }

  // Call this before reading view_snapshot() to ensure bitmaps are ready.
  async prepare_current_view(): Promise<void> {
    if (!this._doc) return
    this._raster.is_loading = true
    const p = this._current_page

    try {
      const work = await this._raster.load_current(p)
      const committed = this.document.applied.get(p)
      if (committed) await this._raster.prerender_output_views(p, committed, this._current_page_size(), work)
    } finally {
      this._raster.is_loading = false
    }

    // Warm the adjacent pages in the background so next/prev is a cache hit instead of a blank
    // "Loading…" flash while the (potentially heavy, scanned-mode) work raster renders on demand.
    this._raster.prefetch(p + 1)
    this._raster.prefetch(p - 1)
  }

  // ---------------------------------------------------------------------------
  // Queries / properties
  // ---------------------------------------------------------------------------

  get mode(): Mode { return this._mode }
  get auto_active(): boolean { return this._auto_active }
  get union(): Box | null { return this._union }
  get offsets(): Offsets { return this.document.offsets }
  get dewarp_on(): boolean { return this.document.dewarp_on }
  get filter_mode(): FilterMode { return this.document.filter_mode }
  get filter_strength(): number { return this.document.filter_strength }
  get split_count(): 1 | 2 | 4 { return this._crop.split_count }
  get same_size(): boolean { return this._crop.same_size }
  get anchor_left(): boolean { return this._crop.anchor_left }
  get anchor_top(): boolean { return this._crop.anchor_top }
  get keep_ratio(): boolean { return this._crop.keep_ratio }
  get ratio(): number { return this._crop.ratio }
  get pages_mode(): PagesMode { return this._pages_mode }
  get select_pattern(): string { return this._select_pattern }
  get current_follow(): boolean { return this._current_follow }
  get compress_preset(): string { return this.settings.compress_preset }
  get custom_dpi(): number { return this.settings.custom_dpi }
  get paper_size(): string { return this.settings.paper_size }
  get custom_paper_in(): number { return this.settings.custom_paper_in }
  get output_colours(): string { return this.settings.output_colours }
  get export_format(): ExportFormat { return this.settings.export_format }
  get undo_depth(): number { return this.settings.undo_depth }
  get detect_outlier_pages(): number { return this.settings.detect_outlier_pages }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  // Effective page size accounting for the page's current rotation (spec §13: a 90°/270°
  // rotation swaps the reported page dimensions; mirrors desktop model.py's _page_dims).
  // `p` is a logical (post-delete) index — translate through _page_index to reach the
  // original-indexed page_sizes array, same boundary _get_work() crosses for the adapter.
  private _page_dims(p: number): PageSize {
    const orig = this._page_index.orig(p)
    const sz = this._doc?.page_sizes[orig] ?? { width: SYNTH_W, height: SYNTH_H }
    const rot = this.document.rotation.get(p) ?? 0
    return rot % 180 === 90 ? { width: sz.height, height: sz.width } : sz
  }

  private _current_page_size(): PageSize {
    return this._page_dims(this._current_page)
  }

  // Scan intent for a page (dewarp on/off, filter mode+strength) — read by the raster pipeline's
  // RasterContext (get_work/_work_disk_key) to know what to compute/key a page's work raster by.
  private _page_process_intent(p: number): PageProcessIntent {
    return {
      dewarp: this.document.processed.get(p)?.dewarp ?? this.document.dewarp_on,
      filter: this.document.filter_mode === FilterMode.NONE ? null
        : [this.document.filter_mode, this.document.filter_strength],
    }
  }

  private _live_auto_crop_for(p: number): Box | null {
    const detected = this._detect_cache.get(p)
    const union    = this._union
    if (!detected || !union || !this._auto_active
        || !(this._crop.anchor_left || this._crop.anchor_top)) return null
    const sz = this._page_dims(p)
    let rect = auto_crop_rect(detected, union, this.document.offsets,
      sz.width, sz.height, this._crop.anchor_left, this._crop.anchor_top)
    if (this._crop.keep_ratio) rect = keep_ratio_normalise(rect, this._crop.ratio, sz.width, sz.height)
    return rect
  }

  private _build_overlay(p: number): OverlayBox[] {
    const out: OverlayBox[] = []

    if (this._crop.split_count > 1) {
      for (let i = 0; i < this.document.crop_rects.length; i++) {
        const box = this.document.crop_rects[i]
        if (box) out.push({ kind: 'split', box, idx: i + 1 })
      }
      return out
    }

    // Global drawn window (pending crop) — outline on every page, clamped to it; overrides the
    // auto/committed display until Crop maps it in.
    const drawn = this._drawn
    if (drawn) {
      const sz = this._page_dims(p)
      out.push({ kind: 'committed', box: {
        x0: Math.max(0, Math.min(drawn.x0, sz.width)),
        y0: Math.max(0, Math.min(drawn.y0, sz.height)),
        x1: Math.max(0, Math.min(drawn.x1, sz.width)),
        y1: Math.max(0, Math.min(drawn.y1, sz.height)),
      } })
      return out
    }

    const committed = this.document.applied.get(p)
    if (committed) {
      for (const box of committed) out.push({ kind: 'committed', box })
      return out
    }

    const live = this._live_auto_crop_for(p)
    if (live) {
      out.push({ kind: 'auto', box: live })
      return out
    }

    return out
  }

  private _invalidate_output_cache(p: number): void { this._raster.invalidate_output(p) }

  private _invalidate_current_bitmap(): void { this._raster.invalidate_current() }

  private _status_string(p: number, sz: PageSize): string {
    return `${sz.width.toFixed(0)} × ${sz.height.toFixed(0)}  page ${p + 1} / ${this.page_count()}`
  }

  private _synth_snapshot(): ViewSnapshot {
    return {
      image: null, page_w: SYNTH_W, page_h: SYNTH_H, crop_origin: { x: 0, y: 0 },
      overlay: [], draw_rect: null, position: 1, total: 0,
      status: '', is_loading: false,
    }
  }
}
