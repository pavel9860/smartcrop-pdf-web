// AppModel — single facade; owns all domain state (ARCHITECTURE §5, CLAUDE.md).
// ui/ calls only public methods and reads only the frozen value objects they return.
// core/ never imports DOM, Worker, pdf-lib, or pdfjs-dist.

import {
  type DocumentState, type Offsets, type PageProcessIntent,
  default_document_state,
} from './document_state'
import { History } from './history'
import { type Settings, default_settings } from './settings'
import { PageIndexMap } from './page_index_map'
import { PageRasterPipeline } from './page_raster_pipeline'
import { CropController } from './crop_controller'
import { PageOpsService, type DetectionState } from './page_ops_service'
import { DetectionService } from './detection_service'
import { ScanProcessingService } from './scan_processing_service'
import { ExportService } from './export_service'
import { ViewSnapshotBuilder } from './view_snapshot_builder'
import { type Box } from './geometry'
import { type BatchJob } from './batch'
import { Mode, FilterMode, PagesMode } from './enums'
import { NoDocumentError, EmptySelectionError, InvalidSplitError } from './errors'
import {
  NORMAL_DPI, NORMAL_DISPLAY_DPI_MAX, DPI_PRESETS, EXPORT_FORMATS,
  DEFAULT_UNDO_DEPTH,
  UNDO_DEPTH_MIN, UNDO_DEPTH_MAX,
  SYNTH_W, SYNTH_H, type ExportFormat,
  CUSTOM_DPI_PRESET, CUSTOM_DPI_MIN, CUSTOM_DPI_MAX,
  PAPER_SIZES, CUSTOM_PAPER_PRESET, CUSTOM_PAPER_MIN, CUSTOM_PAPER_MAX,
  DEWARP_SUPERSAMPLE_MIN, DEWARP_SUPERSAMPLE_MAX,
} from './constants'
import { resolve_pages } from './parsing'
import {
  output_page_count, view_to_source,
} from './viewmodel'

// Public contract types (RendererAdapter, DocInfo, OutputPage, VectorExportPage, ViewSnapshot,
// OverlayBox, OverlayKind, PageSize) live in model_types.ts — re-exported here so every existing
// import of these types via this module keeps working unchanged.
export type {
  PageSize, DocInfo, OutputPage, VectorExportPage, RendererAdapter,
  OverlayKind, OverlayBox, ViewSnapshot,
} from './model_types'
import type { PageSize, DocInfo, RendererAdapter, ViewSnapshot } from './model_types'

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

  // Rotate/delete (§18 PageOpsService). Shares the same detection-result state
  // (detect_cache/union/auto_active) as CropController, exposed the same way — live, not captured.
  private readonly _page_ops: PageOpsService

  // Auto-detect algorithm (§18 DetectionService, step 5/7) — reads/writes the same
  // detect_cache/union/auto_active state as CropController/PageOpsService above.
  private readonly _detection: DetectionService

  // Dewarp/filter toggles (§18 ScanProcessingService, step 6/7).
  private readonly _scan: ScanProcessingService

  // PDF/image export (§18 ExportService, step 7/7).
  private readonly _export: ExportService

  // ViewSnapshot computation (§18, extra step) — reads _raster/_crop directly (both already
  // public-surfaced on AppModel itself) plus the same detection state as the services above.
  private readonly _view: ViewSnapshotBuilder

  constructor(private readonly _adapter: RendererAdapter) {
    this._raster = new PageRasterPipeline(_adapter, this._page_index, {
      mode: (): Mode => this._mode,
      display_dpi: (): number => this._display_dpi,
      is_synthetic: (): boolean => this._doc === null || !!this._doc.synthetic,
      rotation: (p): number => this.document.rotation.get(p) ?? 0,
      process_intent: (p): PageProcessIntent => this._page_process_intent(p),
      dewarp_supersample: (): number => this.settings.dewarp_supersample,
      undo_depth: (): number => this.settings.undo_depth,
    })

    // Shared context pieces below are read LIVE (never captured: `document` is reassigned
    // wholesale on undo/redo) — each was previously re-declared verbatim per collaborator.
    const page_ctx = {
      document: (): DocumentState => this.document,
      page_dims: (p: number): PageSize => this._page_dims(p),
      current_page: (): number => this._current_page,
    }
    const detection_state = (): DetectionState =>
      ({ cache: this._detect_cache, union: this._union, auto_active: this._auto_active })
    const set_detection_state = (d: DetectionState): void => {
      this._detect_cache = d.cache; this._union = d.union; this._auto_active = d.auto_active
    }
    const detection_accessors = {   // individual-accessor shape (vs. detection_state's object shape)
      detected: (p: number): Box | null => this._detect_cache.get(p) ?? null,
      union: (): Box | null => this._union,
      auto_active: (): boolean => this._auto_active,
    }
    const set_drawn = (box: Box | null): void => { this._drawn = box }

    this._crop = new CropController(this.history, {
      ...page_ctx,
      ...detection_accessors,
      has_document: (): boolean => this._doc !== null,
      set_auto_active: (on: boolean): void => { this._auto_active = on },
      drawn: (): Box | null => this._drawn,
      set_drawn,
    })
    this._page_ops = new PageOpsService(this.history, this._page_index, this._raster, {
      ...page_ctx,
      detection: detection_state,
      set_detection: set_detection_state,
      recompute_union: (cache): Box | null => this._detection.compute_union(cache),
      set_current_page: (p): void => { this._current_page = p },
      view_pos: (): number => this._view_pos,
      set_view_pos: (pos): void => { this._view_pos = pos },
      view_total: (): number => this.view_total,
      page_count: (): number => this.page_count(),
      split_count: (): 1 | 2 | 4 => this._crop.split_count,
    })
    this._detection = new DetectionService(_adapter, this.history, this._raster, this._page_index, {
      ...page_ctx,
      has_document: (): boolean => this._doc !== null,
      mode: (): Mode => this._mode,
      detection: detection_state,
      set_detection: set_detection_state,
      anchor_left: (): boolean => this._crop.anchor_left,
      anchor_top: (): boolean => this._crop.anchor_top,
      keep_ratio: (): boolean => this._crop.keep_ratio,
      set_ratio: (r): void => { this._crop.set_ratio(r) },
      outlier_pages: (): number => this.settings.detect_outlier_pages,
      invalidate_output: (p): void => { this._invalidate_output_cache(p) },
      set_drawn,
    })
    this._scan = new ScanProcessingService(this.history, this._raster, {
      document: (): DocumentState => this.document,
      invalidate_output: (p): void => { this._invalidate_output_cache(p) },
      invalidate_current: (): void => { this._invalidate_current_bitmap() },
    })
    this._export = new ExportService(_adapter, this._raster, this._page_index, {
      ...page_ctx,
      page_count: (): number => this.page_count(),
      mode: (): Mode => this._mode,
      view_total: (): number => this.view_total,
      file_names: (): string[] => this._doc?.file_names ?? [],
      output_postfix: (): string => this.settings.output_postfix,
      export_format: (): ExportFormat => this.settings.export_format,
      output_colours: (): string => this.settings.output_colours,
      compress_preset: (): string => this.settings.compress_preset,
      custom_dpi: (): number => this.settings.custom_dpi,
      paper_size: (): string => this.settings.paper_size,
      custom_paper_in: (): number => this.settings.custom_paper_in,
    })
    this._view = new ViewSnapshotBuilder(this._raster, this._crop, {
      ...page_ctx,
      ...detection_accessors,
      view_pos: (): number => this._view_pos,
      view_total: (): number => this.view_total,
      page_count: (): number => this.page_count(),
      drawn: (): Box | null => this._drawn,
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
    if (this._crop.split_count === 1) return this._crop.has_crop_source()
    return this.document.crop_rects.length === this._crop.split_count
  }

  // Auto-detect algorithm lives in DetectionService (§18) — this stays a 1-line delegation so
  // ui/ keeps calling AppModel's public surface unchanged.
  detect_content(): BatchJob {
    return this._detection.detect(this._require_pages())
  }

  apply_crop(): void {
    const pages = this._require_pages()

    if (this._crop.split_count > 1 && this.document.crop_rects.length !== this._crop.split_count) {
      throw new InvalidSplitError(
        `Need exactly ${this._crop.split_count} split rectangles; have ${this.document.crop_rects.length}`)
    }

    this.history.push(this.document)

    for (const p of pages) {
      if (this._crop.split_count === 1) {
        const boxes = this._crop.compute_crop_boxes_for_page(p)
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

  // Anchors/offsets/keep-ratio/split/same-size, and the full drag gesture state machine
  // (spec-web §6.5/§6.6), are owned by CropController (§18) — these are 1-line delegations so
  // ui/ keeps calling AppModel's public surface unchanged.
  set_anchor(left: boolean | null, top: boolean | null): void { this._crop.set_anchor(left, top) }
  set_drawn_offset(edge: 'L' | 'T' | 'R' | 'B', value: number): void { this._crop.set_drawn_offset(edge, value) }
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
  // selection before touching undoable state.
  private _require_pages(): number[] {
    if (!this.has_document) throw new NoDocumentError('No document loaded')
    const pages = this.resolve_pages()
    if (pages.length === 0) throw new EmptySelectionError('No pages in selection')
    return pages
  }

  // Scan toggles (dewarp/filter mode/filter strength) live in ScanProcessingService (§18) — these
  // stay 1-line delegations so ui/ keeps calling AppModel's public surface unchanged.
  run_dewarp(): BatchJob {
    return this._scan.run_dewarp(this._require_pages())
  }

  set_filter_mode(mode: FilterMode): BatchJob {
    return this._scan.set_filter_mode(this._require_pages(), mode)
  }

  set_filter_strength(n: number): BatchJob {
    return this._scan.set_filter_strength(this._require_pages(), n)
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  undo(): void {
    const prev = this.history.undo(this.document)
    if (prev) {
      this.document = prev
      this._raster.clear_output()
    }
  }

  redo(): void {
    const next = this.history.redo(this.document)
    if (next) {
      this.document = next
      this._raster.clear_output()
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
  set_custom_paper_in(height_in: number): void { this.settings.custom_paper_in = Math.max(CUSTOM_PAPER_MIN, Math.min(CUSTOM_PAPER_MAX, height_in)) }
  set_custom_dpi(dpi: number): void { this.settings.custom_dpi = Math.max(CUSTOM_DPI_MIN, Math.min(CUSTOM_DPI_MAX, Math.round(dpi))) }
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
  set_detect_outlier_pages(n: number): void { this.settings.detect_outlier_pages = Math.max(0, Math.round(n)) }
  set_output_postfix(postfix: string): void { this.settings.output_postfix = postfix }
  set_dewarp_supersample(factor: number): void { this.settings.dewarp_supersample = Math.max(DEWARP_SUPERSAMPLE_MIN, Math.min(DEWARP_SUPERSAMPLE_MAX, factor)) }

  get output_postfix(): string { return this.settings.output_postfix }
  get dewarp_supersample(): number { return this.settings.dewarp_supersample }

  // ---------------------------------------------------------------------------
  // Rotate / delete
  // ---------------------------------------------------------------------------

  // Rotate/delete (spec-web §6.10) are owned by PageOpsService (§18) — 1-line delegations so
  // ui/ keeps calling AppModel's public surface unchanged.
  rotate_pages(): void { this._page_ops.rotate(this._require_pages()) }
  delete_pages(): void { this._page_ops.delete(this._require_pages()) }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  // Export (raster + vector) lives in ExportService (§18) — these stay 1-line delegations so ui/
  // keeps calling AppModel's public surface unchanged.
  suggested_export_name(): string {
    return this._export.suggested_export_name()
  }

  export(filename: string): BatchJob {
    if (!this.has_document) throw new NoDocumentError('No document loaded')
    return this._export.export(filename)
  }

  set_download_handlers(
    pdf: (bytes: Uint8Array, name: string) => void,
    zip: (bytes: Uint8Array, base: string) => void,
  ): void {
    this._export.set_download_handlers(pdf, zip)
  }

  // ---------------------------------------------------------------------------
  // View snapshot (synchronous — reads pre-fetched bitmaps from cache)
  // ---------------------------------------------------------------------------

  // ViewSnapshot computation lives in ViewSnapshotBuilder (§18) — this stays a 1-line delegation
  // so ui/ keeps calling AppModel's public surface unchanged.
  view_snapshot(): ViewSnapshot {
    return this._doc ? this._view.build() : this._view.synth_snapshot()
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
    const rotation = this.document.rotation.get(p) ?? 0   // captured pre-fetch; work reflects it

    try {
      const work = await this._raster.get_work(p)
      // A resolved-late fetch can outrun page nav OR a same-page re-rotate — commit only if both
      // still match (bug: distortion on fast-scroll or rapid re-rotate, page_dims reads live).
      if (p === this._current_page && rotation === (this.document.rotation.get(p) ?? 0)) {
        this._raster.current = work
        const committed = this.document.applied.get(p)
        if (committed) await this._raster.prerender_output_views(p, committed, this._page_dims(p), work)
      }
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
  get drawn_offsets(): Offsets | null { return this._crop.drawn_offsets() }
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

  // Scan intent for a page — read by RasterContext.process_intent to know what to compute/key by.
  private _page_process_intent(p: number): PageProcessIntent {
    return {
      dewarp: this.document.processed.get(p)?.dewarp ?? this.document.dewarp_on,
      filter: this.document.filter_mode === FilterMode.NONE ? null
        : [this.document.filter_mode, this.document.filter_strength],
    }
  }

  private _invalidate_output_cache(p: number): void { this._raster.invalidate_output(p) }

  private _invalidate_current_bitmap(): void { this._raster.invalidate_current() }
}
