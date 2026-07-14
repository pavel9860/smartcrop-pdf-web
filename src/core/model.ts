// AppModel — single facade; owns all domain state (ARCHITECTURE §5, CLAUDE.md).
// ui/ calls only public methods and reads only the frozen value objects they return.
// core/ never imports DOM, Worker, pdf-lib, or pdfjs-dist.

import {
  type DocumentState, type Offsets, type PageProcessIntent,
  default_document_state, DEFAULT_OFFSETS,
} from './document_state'
import { History } from './history'
import { type Settings, default_settings } from './settings'
import { type DragState, type AutoDrag, type SplitDrag, type DrawDrag, type DrawnDrag } from './drag'
import {
  type Box,
  hit_handle, point_in_box, apply_handle_drag, auto_crop_rect,
  offsets_from_rect, keep_ratio_normalise, keep_ratio_anchored, clamp_box_drag,
  split_rects_grid, rotate_box_cw, reindex_map, detection_union,
  edge_deltas, apply_edge_deltas, clamp_edge_deltas,
  MIN_RECT, box_width, box_height,
} from './geometry'
import { LRUCache } from './lru'
import { type BatchJob, type BatchController, PageBatchJob, Ok, Cancelled, Failed } from './batch'
import { Mode, FilterMode, PagesMode } from './enums'
import {
  NoDocumentError, EmptySelectionError, InvalidSplitError,
  DeleteAllPagesError, ImagingError,
} from './errors'
import {
  CACHE_WINDOW, SRC_DPI, NORMAL_DPI, DPI_PRESETS, EXPORT_FORMATS,
  DEFAULT_UNDO_DEPTH, FULL_PAGE_FRAC, OFFSET_LIMIT,
  FILTER_STRENGTH_MIN, FILTER_STRENGTH_MAX, UNDO_DEPTH_MIN, UNDO_DEPTH_MAX,
  MAX_SPLIT, SYNTH_W, SYNTH_H, type ExportFormat,
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
  // True only for the no-file-open placeholder document (frozen spec §1). Pages of a
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

  // Interaction settings (not undoable). anchor_left/anchor_top jointly determine the crop
  // together with document.offsets (which IS undoable) but are deliberately excluded here, same
  // as keep_ratio/ratio/split_count below: DocumentState's undo boundary is exactly the frozen
  // 8-field list (document_state.ts, spec §13/§W9.2) — anchors are a persistent interaction mode,
  // not a per-edit value, so Undo leaves them untouched (L5; see model.test.ts for the locking test).
  private _anchor_left  = true
  private _anchor_top   = true
  private _keep_ratio   = false
  private _ratio        = 1.0
  private _split_count: 1 | 2 | 4 = 1
  private _same_size    = false
  private _pages_mode   = PagesMode.ALL
  private _select_pattern = ''
  private _current_follow = false

  // Detection/drawn-window working state (not undoable — spec-web §W9.2, moved out of
  // DocumentState 2026-07). These are scaffolding used to ARRIVE at a committed operation
  // (applied/rotation), not an operation themselves, so Undo does not revert them: pressing Undo
  // right after Auto-detect, before anything is committed via Crop, is now a no-op. Same lifecycle
  // both modes; SCANNED's committed crop/rotate/filter/dewarp are unaffected (those stay in
  // DocumentState). Reset on _reset_state/_run_detect/rotate/delete exactly as document.* used to be.
  private _drawn:        Box | null = null   // global hand-drawn window, page coords (§9.3)
  private _detect_cache = new Map<number, Box>()   // per-page content box from last detect
  private _union:        Box | null = null   // aggregate detection union (§8)
  private _auto_active   = false             // auto-detect was run at least once

  // Transient drag state (not snapshotted)
  private _drag:         DragState | null = null
  private _draw_rect:    Box | null = null

  // History and settings
  readonly history = new History(DEFAULT_UNDO_DEPTH)
  readonly settings: Settings = default_settings()

  // Raster caches (source = raw page; work = after scan processing). Eviction closes the bitmap
  // to free memory eagerly — EXCEPT the one currently on screen (_current_bitmap): closing a
  // displayed/in-flight bitmap detaches it and the next drawImage throws InvalidStateError
  // ("image source is detached"). This hit hardest during Auto-detect on long books, which walks
  // every page through _get_work and would otherwise evict+close the live page (bug: site dead).
  private _source_cache = new LRUCache<number, ImageBitmap>(CACHE_WINDOW,
    (_, b) => { if (b !== this._current_bitmap) b.close() })
  // Processed-raster RAM tier. WRITE-BACK to the disk tier: a raster is persisted to IndexedDB only
  // when the RAM cache is full and it is genuinely evicted (onCapacityEvict) — NOT eagerly on every
  // compute. Eager persist made a warm pass fire N concurrent PNG-encode+IDB-write jobs that piled
  // up (hundreds of ms each) and contended with the next page's OpenCV work; for a document that
  // fits in RAM (≤ CACHE_WINDOW pages) the disk tier is never even read, so that work was pure
  // overhead. Delete/clear (intent change, reset) close without a disk write. `_work_disk_keys`
  // carries each cached page's disk key (the intent it was computed under) so eviction persists it
  // under the right key even if the document's current intent has since changed.
  private _work_disk_keys = new Map<number, string>()
  // Keys actually written to the disk tier (on capacity eviction). _get_work only reads disk for a
  // key in this set — so a document that fits in RAM does ZERO disk reads and never touches
  // IndexedDB on the hot path (a stray read would serialize behind the load-time clear transaction
  // for ~300 ms; this set makes that read never happen). In-memory, cleared on load/reset.
  private _persisted_keys = new Set<string>()
  private _work_cache = new LRUCache<number, ImageBitmap>(CACHE_WINDOW,
    (p, b) => { this._work_disk_keys.delete(p); if (b !== this._current_bitmap) b.close() },
    (p, b) => {
      const key = this._work_disk_keys.get(p)
      // persist_work snapshots pixels synchronously (drawImage before any await), so closing right
      // after is safe; a capacity eviction only happens deep into processing, long after any
      // load-time clear. Record the key so _get_work knows this raster is retrievable from disk.
      if (key && this._adapter.persist_work) { void this._adapter.persist_work(key, b); this._persisted_keys.add(key) }
      this._work_disk_keys.delete(p)
      if (b !== this._current_bitmap) b.close()
    })

  // Pre-rendered output bitmaps for committed pages (keyed "page:split_idx")
  private _output_cache = new LRUCache<string, ImageBitmap>(CACHE_WINDOW * 2,
    (_, b) => { if (b !== this._current_bitmap) b.close() })

  // Currently displayed bitmap (synchronously available for view_snapshot)
  private _current_bitmap: ImageBitmap | null = null
  private _is_loading = false

  // Monotonic document generation, bumped on every load/reset and baked into each disk-cache key.
  // This namespaces a document's processed rasters so a disk read can never return a PREVIOUS
  // document's raster (key collision), which means reads/persists do NOT have to wait for the
  // load-time IndexedDB clear to finish — that wait added ~300 ms to the first pages of a scan pass.
  // The clear still runs (fire-and-forget) to bound storage; correctness no longer depends on it.
  private _doc_gen = 0

  // Logical page index -> original adapter page index. The adapter (pdf.js) has no page-deletion
  // primitive — unlike desktop's PyMuPDF `doc.delete_pages()`, which physically shrinks the
  // document so indices simply renumber — so delete_pages() here removes entries from this map
  // instead. Every adapter call that takes a page index must translate through it (_get_work).
  private _page_map: number[] = []

  constructor(private readonly _adapter: RendererAdapter) {}

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
    this._split_count = 1
    this._anchor_left = true
    this._anchor_top = true
    this._keep_ratio = false
    this._ratio = 1.0        // replaced below with the first page's aspect ratio once _doc is set
    this._same_size = false
    this._pages_mode = PagesMode.ALL
    this._select_pattern = ''
    this._current_follow = false
    this._drag = null
    this._draw_rect = null
    this._drawn = null
    this._detect_cache = new Map()
    this._union = null
    this._auto_active = false
    this._source_cache.clear()
    this._work_cache.clear()
    this._work_disk_keys.clear()
    this._persisted_keys.clear()
    this._output_cache.clear()
    // New generation → new disk-key namespace (see _doc_gen). Drop the old generation's rasters
    // from disk to bound storage, but fire-and-forget: correctness no longer waits on it.
    this._doc_gen += 1
    void this._adapter.clear_work_cache?.()
    this._current_bitmap = null
    this._page_map = this._doc ? Array.from({ length: this._doc.page_count }, (_, i) => i) : []
    // Keep-ratio initialises to the first page's real w/h, not a bare 1.0, so the ratio field
    // shows a meaningful default from the moment a document opens.
    const sz0 = this._doc?.page_sizes[0]
    if (sz0 && sz0.height > 0) this._ratio = sz0.width / sz0.height
  }

  get has_document(): boolean { return this._doc !== null }
  page_count(): number { return this._page_map.length }

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
    return this.has_document && this._split_count === 1
      && (this._anchor_left || this._anchor_top)
  }

  get can_apply(): boolean {
    if (!this.has_document) return false
    if (this._split_count === 1) return true
    return this.document.crop_rects.length === this._split_count
  }

  detect_content(): BatchJob {
    if (!this.has_document) throw new NoDocumentError('No document loaded')
    const pages = this.resolve_pages()
    if (pages.length === 0) throw new EmptySelectionError('No pages in selection')

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
    if (!this._keep_ratio && union && box_height(union) > 0) {
      this._ratio = box_width(union) / box_height(union)
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
        const orig = this._page_map[p] ?? p
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
          const img = await this._get_source(p)
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
      if (!detected || !(this._anchor_left || this._anchor_top)) continue
      const sz = this._page_dims(p)
      const rect = auto_crop_rect(detected, union, this.document.offsets,
        sz.width, sz.height, this._anchor_left, this._anchor_top)
      this.document.applied.set(p, [rect])
      this._invalidate_output_cache(p)
    }
  }

  apply_crop(): void {
    if (!this.has_document) throw new NoDocumentError('No document loaded')
    const pages = this.resolve_pages()
    if (pages.length === 0) throw new EmptySelectionError('No pages in selection')

    if (this._split_count > 1 && this.document.crop_rects.length !== this._split_count) {
      throw new InvalidSplitError(
        `Need exactly ${this._split_count} split rectangles; have ${this.document.crop_rects.length}`)
    }

    this.history.push(this.document)

    // Export also commits live auto-crop for uncommitted pages (spec §12.4)
    for (const p of pages) {
      if (this._split_count === 1) {
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
        && (this._anchor_left || this._anchor_top)) {
      let rect = auto_crop_rect(detected, union, this.document.offsets,
        sz.width, sz.height, this._anchor_left, this._anchor_top)
      if (this._keep_ratio) rect = keep_ratio_normalise(rect, this._ratio, sz.width, sz.height)
      return [rect]
    }
    return null
  }

  set_anchor(left: boolean | null, top: boolean | null): void {
    if (left !== null) this._anchor_left = left
    if (top  !== null) this._anchor_top  = top
  }

  set_offset(edge: 'L' | 'T' | 'R' | 'B', value: number): void {
    this.history.push(this.document)
    const o = this.document.offsets
    const clamped = Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, value))
    this.document.offsets = {
      left:   edge === 'L' ? clamped : o.left,
      top:    edge === 'T' ? clamped : o.top,
      right:  edge === 'R' ? clamped : o.right,
      bottom: edge === 'B' ? clamped : o.bottom,
    }
  }

  // Snap out-of-range offsets to page-limit (spec §7.4a)
  commit_offsets(): void {
    const doc = this._doc
    if (!doc) return
    const sz = this._page_dims(this._current_page)
    const detected = this._detect_cache.get(this._current_page)
    const union    = this._union
    if (!detected || !union) return

    this.history.push(this.document)
    const rect = auto_crop_rect(detected, union, this.document.offsets,
      sz.width, sz.height, this._anchor_left, this._anchor_top)

    const base_left = this._anchor_left ? detected.x0 : union.x0
    const base_top  = this._anchor_top  ? detected.y0 : union.y0
    const W = box_width(union), H = box_height(union)
    this.document.offsets = {
      left:   (base_left - rect.x0) / sz.width  * 100,
      top:    (base_top  - rect.y0) / sz.height * 100,
      right:  (rect.x1 - (base_left + W)) / sz.width  * 100,
      bottom: (rect.y1 - (base_top  + H)) / sz.height * 100,
    }
  }

  set_keep_ratio(on: boolean, ratio?: number): void {
    // Capture BEFORE mutating _keep_ratio below — `on && !this._keep_ratio` checked against
    // the just-assigned value always evaluated false when turning ratio on, so the
    // pre-populate branch below was dead code (confirmed via test; real regression, not a
    // hypothetical). Mirrors model.py:435-438's off->on edge, adapted for the fact this port
    // has no "unset" sentinel for _ratio (always a float, default 1.0).
    const was_off = !this._keep_ratio
    this._keep_ratio = on
    if (ratio !== undefined && ratio > 0) this._ratio = ratio
    else if (on && was_off) this._ratio = this._default_ratio()
  }

  // Ratio pre-populate source, shared by set_keep_ratio's off->on toggle and set_split() (bug #3/
  // #4, spec-web §W2 row 9): prefer whatever crop shape is ALREADY on screen — crop_rects[0] at
  // split 2/4, the hand-drawn window at split 1 — over a page/union-derived formula, so an edit
  // made before Keep-ratio is pressed is not silently discarded. Falls back to the detection
  // union, then the page aspect, only when no concrete crop shape exists yet (bug E).
  private _default_ratio(): number {
    if (this._split_count > 1) {
      const r = this.document.crop_rects[0]
      if (r && box_height(r) > 0) return box_width(r) / box_height(r)
    } else if (this._drawn) {
      const d = this._drawn
      if (box_height(d) > 0) return box_width(d) / box_height(d)
    }
    const u = this._union
    if (u && box_height(u) > 0) return box_width(u) / box_height(u)
    if (this._doc) {
      const sz = this._current_page_size()
      if (sz.height > 0) return sz.width / sz.height
    }
    return 1.0
  }

  set_split(n: 1 | 2 | 4): void {
    if (n === this._split_count) return
    this.history.push(this.document)
    // Committed crops belong to the previous layout — drop them when the split changes
    // (desktop model.py:417-418). Prevents stale single-crop pages surviving into split mode.
    this.document.applied.clear()
    this._drawn = null
    this._split_count = n
    if (this._doc) {
      const sz = this._page_dims(this._current_page)
      // n === 1 has no split rectangles (desktop clears crop_rects); 2/4 auto-lay the grid.
      this.document.crop_rects = n === 1 ? [] : split_rects_grid(n, sz.width, sz.height)
    }
    // A split-count change always re-derives the ratio fresh from the newly-reseeded grid — it
    // does not carry the previous ratio forward proportionally (bug #3; explicit user decision:
    // "drop the previous ratio if the split changes"). Reuses the same source set_keep_ratio's
    // off->on toggle uses, so 1->2 with keep-ratio already on lands on half the prior page-aspect
    // ratio only as a side effect of split 2's cell being half as wide, not a dedicated rule.
    if (this._keep_ratio) this._ratio = this._default_ratio()
  }

  // Turning Same-size ON immediately normalizes every window to the FIRST window's width/height
  // (bug #2: "all crop windows should be the same size all the time", not just after the next
  // drag) — capped to whatever fits every window's own, unmoved origin so nothing needs to shift
  // position to fit (same "stop growth at the tightest headroom" principle _propagate_same_size
  // uses live during a drag). Deliberate deviation from frozen §7.3's literal "dragging one
  // resizes all of them" (which only describes the on-drag case) — spec-web §W2 row 10.
  set_same_size(on: boolean): void {
    const turning_on = on && !this._same_size
    this._same_size = on
    if (!turning_on) return
    const rects = this.document.crop_rects
    const first = rects[0]
    if (!this._doc || !first) return
    const sz = this._current_page_size()
    const max_w = Math.min(...rects.map(r => sz.width - r.x0))
    const max_h = Math.min(...rects.map(r => sz.height - r.y0))
    const w = Math.max(MIN_RECT, Math.min(box_width(first), max_w))
    const h = Math.max(MIN_RECT, Math.min(box_height(first), max_h))
    this.history.push(this.document)
    this.document.crop_rects = rects.map(r => ({ x0: r.x0, y0: r.y0, x1: r.x0 + w, y1: r.y0 + h }))
  }

  // ---------------------------------------------------------------------------
  // Gestures — delegated to per-kind helpers so each is ≤30 lines
  // ---------------------------------------------------------------------------

  begin_drag(px: number, py: number, tol: number): void {
    if (!this._doc) return
    const sz = this._current_page_size()
    const pt: readonly [number, number] = [px, py]

    if (this._split_count > 1) { this._begin_split_drag(pt, tol, sz); return }
    // A pending manual window (_drawn): grab a handle to resize, press INSIDE to move it,
    // press OUTSIDE to drop it and rubber-band a new one (desktop WindowDrag / DrawDrag, §9.3/§9.4).
    const drawn = this._drawn
    if (drawn) {
      const h = hit_handle(drawn, px, py, tol)
      if (h || point_in_box(drawn, px, py)) {
        this._drag = {
          kind: 'drawn', handle: h, rect0: drawn, start: pt,
          page_w: sz.width, page_h: sz.height,
        } satisfies DrawnDrag
        return
      }
      this._begin_draw_drag(pt, sz)   // outside the window → drop it, start a fresh draw
      return
    }
    // A committed page (split = 1) is not itself a drag target — the crop is fixed until Undo or
    // a new Crop. Any drag rubber-bands a NEW window over the cropped view (frozen spec §9.3),
    // which commits only via the Crop button. So skip auto/crop-edit and draw directly.
    const committed = this.document.applied.get(this._current_page)
    if (committed && committed.length > 0) { this._begin_draw_drag(pt, sz); return }
    if (this._begin_auto_drag(pt, tol, sz)) return
    this._begin_draw_drag(pt, sz)
  }

  private _begin_split_drag(
    pt: readonly [number, number], tol: number, sz: PageSize,
  ): void {
    const [px, py] = pt
    for (let i = 0; i < this.document.crop_rects.length; i++) {
      const rect = this.document.crop_rects[i]
      if (!rect) continue
      const h = hit_handle(rect, px, py, tol)
      if (h) {
        this.history.push(this.document)   // snapshot BEFORE the drag mutates crop_rects live
        this._drag = {
          kind: 'split', idx: i, handle: h, rect0: rect,
          rects0: [...this.document.crop_rects],   // same-size v2 bases + §9.6 cancel restore
          start: pt, page_w: sz.width, page_h: sz.height,
        } satisfies SplitDrag
        return
      }
    }
  }

  private _begin_auto_drag(
    pt: readonly [number, number], tol: number, sz: PageSize,
  ): boolean {
    const [px, py] = pt
    const detected = this._detect_cache.get(this._current_page)
    const union    = this._union
    if (!this._auto_active || !detected || !union
        || !(this._anchor_left || this._anchor_top)) return false

    let live = auto_crop_rect(detected, union, this.document.offsets,
      sz.width, sz.height, this._anchor_left, this._anchor_top)
    if (this._keep_ratio) live = keep_ratio_normalise(live, this._ratio, sz.width, sz.height)
    const h = hit_handle(live, px, py, tol)
    if (!h) return false

    this.history.push(this.document)   // snapshot BEFORE the drag mutates offsets live
    this._drag = {
      kind: 'auto', handle: h, rect0: live, start: pt,
      page_w: sz.width, page_h: sz.height,
      offsets0: this.document.offsets,
      left_base: this._anchor_left ? detected.x0 : union.x0,
      top_base:  this._anchor_top  ? detected.y0 : union.y0,
    } satisfies AutoDrag
    return true
  }

  private _begin_draw_drag(pt: readonly [number, number], sz: PageSize): void {
    this._drawn = null   // a fresh press drops the previous drawn window at once (bug 6)
    this._drag = { kind: 'draw', start: pt, page_w: sz.width, page_h: sz.height } satisfies DrawDrag
    this._draw_rect = null
  }

  update_drag(px: number, py: number): void {
    const drag = this._drag
    if (!drag) return
    const sz = this._current_page_size()

    if (drag.kind === 'draw')      { this._update_draw_drag(drag, px, py, sz); return }
    if (drag.kind === 'auto')      { this._update_auto_drag(drag, px, py, sz); return }
    if (drag.kind === 'split')     { this._update_split_drag(drag, px, py); return }
    this._update_drawn_drag(drag, px, py)
  }

  private _update_draw_drag(drag: DrawDrag, px: number, py: number, sz: PageSize): void {
    const [sx, sy] = drag.start
    let rect = clamp_box_drag({
      x0: Math.min(sx, px), y0: Math.min(sy, py),
      x1: Math.max(sx, px), y1: Math.max(sy, py),
    }, sz.width, sz.height)
    // On a committed page the rubber-band lives in the cropped view's coordinates: keep it inside
    // the committed box so a new window can only tighten, never spill past the crop (§9.3).
    const committed = this.document.applied.get(this._current_page)?.[0]
    if (committed) {
      rect = {
        x0: Math.max(rect.x0, committed.x0), y0: Math.max(rect.y0, committed.y0),
        x1: Math.min(rect.x1, committed.x1), y1: Math.min(rect.y1, committed.y1),
      }
    }
    this._draw_rect = rect
  }

  private _update_auto_drag(drag: AutoDrag, px: number, py: number, sz: PageSize): void {
    let updated = apply_handle_drag(drag.handle ?? 'move', drag.rect0,
      drag.start, [px, py], drag.page_w, drag.page_h)
    if (this._keep_ratio) updated = keep_ratio_normalise(updated, this._ratio, sz.width, sz.height)
    const detected = this._detect_cache.get(this._current_page)
    const union    = this._union
    if (detected && union) {
      this.document.offsets = offsets_from_rect(updated, detected, union,
        sz.width, sz.height, this._anchor_left, this._anchor_top)
    }
  }

  private _update_split_drag(drag: SplitDrag, px: number, py: number): void {
    let updated = apply_handle_drag(drag.handle, drag.rect0,
      drag.start, [px, py], drag.page_w, drag.page_h)
    // Keep-ratio holds LIVE during a split resize (spec-web §W2 row 9), anchored opposite the
    // dragged handle so the window never deforms then jumps on release. A 'move' preserves it.
    if (this._keep_ratio && drag.handle !== 'move') {
      updated = keep_ratio_anchored(updated, this._ratio, drag.handle, drag.page_w, drag.page_h)
    }
    const rects = [...this.document.crop_rects]
    rects[drag.idx] = updated
    // Same-size propagates ONLY on a resize (spec-web §W2 row 10) — `move` (dragging a window's
    // interior to translate it) NEVER syncs partners, in any state; this is a deliberate,
    // permanent exclusion (a prior design mirrored move deltas too, and that was wrong).
    if (this._same_size && drag.handle !== 'move') this._propagate_same_size(drag, updated, rects)
    this.document.crop_rects = rects
  }

  // Same-size RESIZE (spec-web §W2 row 10): the dragged window's raw edge deltas mirror by grid
  // parity onto every OTHER window's own drag-start rect — column mirror (opposite column) swaps+
  // negates the x pair, row mirror (opposite row) the y pair; same column/row copies that axis
  // unchanged (n=2 [left,right] shares one row always; n=4 [TL,BL,TR,BR]: col=idx>>1, row=idx&1).
  // Deltas are capped up front to every window's own headroom (bug #2) so growth simply stops at
  // the tightest window's page-edge limit instead of a partner needing to jump/deform afterward.
  private _propagate_same_size(drag: SplitDrag, updated: Box, rects: Box[]): void {
    const n = rects.length
    const col = (i: number): number => (n === 2 ? i : i >> 1)
    const row = (i: number): number => (n === 2 ? 0 : i & 1)
    const mirror_cols = rects.map((_, i) => col(i) !== col(drag.idx))
    const mirror_rows = rects.map((_, i) => row(i) !== row(drag.idx))
    const raw = edge_deltas(drag.rect0, updated)
    const d = clamp_edge_deltas(raw, drag.rects0, mirror_cols, mirror_rows, drag.page_w, drag.page_h)
    for (let i = 0; i < n; i++) {
      const base = drag.rects0[i]
      if (base) rects[i] = apply_edge_deltas(base, d, mirror_cols[i] ?? false, mirror_rows[i] ?? false, drag.page_w, drag.page_h)
    }
  }

  private _update_drawn_drag(drag: DrawnDrag, px: number, py: number): void {
    const box = apply_handle_drag(drag.handle ?? 'move', drag.rect0,
      drag.start, [px, py], drag.page_w, drag.page_h)
    // Keep-ratio holds LIVE during a resize, anchored opposite the dragged handle so only the
    // dragged side moves (spec-web §W2 row 9). A move (null/'move' handle) preserves the ratio.
    this._drawn = (this._keep_ratio && drag.handle && drag.handle !== 'move')
      ? keep_ratio_anchored(box, this._ratio, drag.handle, drag.page_w, drag.page_h)
      : box
  }

  end_drag(): void {
    const drag = this._drag
    this._drag = null

    if (!drag) return

    if (drag.kind === 'draw') {
      const rect = this._draw_rect
      this._draw_rect = null
      if (!rect || box_width(rect) < 2 * MIN_RECT || box_height(rect) < 2 * MIN_RECT) return
      let drawn = rect
      if (this._keep_ratio) {
        const sz = this._current_page_size()
        drawn = keep_ratio_normalise(rect, this._ratio, sz.width, sz.height)
      }
      // The drawn window is a GLOBAL pending crop shown as an outline on every page — it is NOT
      // committed here. Clicking Crop maps it onto each selected page then clears it, so a hand-
      // drawn window crops ALL pages (desktop §9.3/§12.2), and the page never zooms to the crop
      // on mouse-up (was the "magnification" bug). _drawn is non-undoable working state (§W9.2) —
      // no history.push here (removed): finishing a rubber-band draw must not clear the redo
      // stack, since nothing undo-tracked changes until Crop commits it into `applied`.
      this._drawn = drawn
      return
    }

    // split & drawn: keep-ratio is now held LIVE during the drag (spec-web §W2 row 9), so there is
    // no release-time re-snap — that used a top-left anchor and would shift the window on mouse-up.
    // auto: already committed live during update_drag.
  }

  cancel_drag(): void {
    const drag = this._drag
    this._drag = null
    this._draw_rect = null

    if (!drag) {
      this._drawn = null   // Esc / right-click drops the pending drawn window (bug 5)
      return
    }

    if (drag.kind === 'auto') {
      this.document.offsets = drag.offsets0
    } else if (drag.kind === 'split') {
      // §9.6: Esc/right-click during a drag leaves the windows unchanged — restore EVERY window
      // (same-size v2 moves partners live, so the dragged rect alone is not enough).
      this.document.crop_rects = [...drag.rects0]
    } else if (drag.kind === 'drawn') {
      // Cancelling a move/resize of an EXISTING window restores it, not drops it (help_view §5:
      // cancel changes nothing) — distinct from the no-drag Esc above, which intentionally drops
      // a pending window that was never being edited.
      this._drawn = drag.rect0
    }
    // 'draw': nothing to restore — _begin_draw_drag already cleared any prior drawn window at
    // press time (bug 6), and no window was committed yet.
  }

  // ---------------------------------------------------------------------------
  // Scan processing
  // ---------------------------------------------------------------------------

  // Shared guard for the three scan-processing toggles below: all require a document and a
  // non-empty page selection before touching undoable state (M4 — set_filter_strength was
  // missing this, unlike its two siblings).
  private _require_scan_pages(): number[] {
    if (!this.has_document) throw new NoDocumentError('No document loaded')
    const pages = this.resolve_pages()
    if (pages.length === 0) throw new EmptySelectionError('No pages in selection')
    return pages
  }

  // Scan toggles: the intent flips SYNCHRONOUSLY (undoable — history pushed first), then the
  // returned BatchJob pre-computes the selection's work rasters under the §14 progress overlay,
  // yielding to the event loop between pages so the overlay repaints and Cancel works. A cancel
  // keeps the intent: unprocessed pages fall back to on-view lazy compute in _get_work. This is
  // desktop §14 parity — the lazy-only design (16c1b6d) deferred ALL processing to view/detect
  // time, which made scanned-mode Auto-detect and navigation pay render+OpenCV(+ONNX) per page
  // with no progress UI (spec-web §W2 row 5).
  run_dewarp(): BatchJob {
    const pages = this._require_scan_pages()
    this.history.push(this.document)   // snapshot BEFORE the toggle so undo reverts it
    this.document.dewarp_on = !this.document.dewarp_on
    this._apply_scan_intents(pages)
    return this._warm_work_cache(pages, 'Dewarping…')
  }

  set_filter_mode(mode: FilterMode): BatchJob {
    const pages = this._require_scan_pages()
    this.history.push(this.document)
    // Toggle: pressing the active filter turns it off (spec §7.2)
    this.document.filter_mode = (mode === this.document.filter_mode) ? FilterMode.NONE : mode
    this._apply_scan_intents(pages)
    return this._warm_work_cache(pages, 'Applying filter…')
  }

  set_filter_strength(n: number): BatchJob {
    const pages = this._require_scan_pages()
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
        await this._get_work(p)
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
      this._work_cache.delete(p)
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
      this._source_cache.clear()
      this._work_cache.clear()
      this._output_cache.clear()
      this._invalidate_current_bitmap()
    }
  }

  redo(): void {
    const next = this.history.redo(this.document)
    if (next) {
      this.document = next
      this._source_cache.clear()
      this._work_cache.clear()
      this._output_cache.clear()
      this._invalidate_current_bitmap()
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
    if (!this.has_document) throw new NoDocumentError('No document loaded')
    const pages = this.resolve_pages()
    if (pages.length === 0) throw new EmptySelectionError('No pages in selection')
    if (!this._doc) return

    this.history.push(this.document)
    for (const p of pages) this._rotate_page(p)
  }

  private _rotate_page(p: number): void {
    // Effective dims BEFORE this 90° step — box coords being carried through are still in
    // that (pre-step) frame. Must read before mutating rotation (mirrors model.py:558-566).
    const sz = this._page_dims(p)
    const cur_rot = this.document.rotation.get(p) ?? 0
    this.document.rotation.set(p, (cur_rot + 90) % 360)

    const app = this.document.applied.get(p)
    if (app) this.document.applied.set(p, app.map(b => rotate_box_cw(b, sz.height)))
    const det = this._detect_cache.get(p)
    if (det) this._detect_cache.set(p, rotate_box_cw(det, sz.height))

    this._source_cache.delete(p)
    this._work_cache.delete(p)
    this._invalidate_output_cache(p)

    this.document.offsets = DEFAULT_OFFSETS
    if (this._union) {
      // Rebuild with the SAME FULL_PAGE_FRAC exclusion the initial detect applies (bug 2a,
      // 99_FOUND_ISSUES): the old raw detection_union() re-admitted full-page fallback boxes after
      // a rotate, silently inflating every crop. Judged against each page's rotated dims.
      this._union = this._compute_detection_union(this._detect_cache)
    }
  }

  delete_pages(): void {
    if (!this.has_document) throw new NoDocumentError('No document loaded')
    const doc = this._doc
    if (!doc) return
    const pages = this.resolve_pages()
    if (pages.length === 0) throw new EmptySelectionError('No pages in selection')
    if (pages.length >= this.page_count()) throw new DeleteAllPagesError('Cannot delete all pages')

    const sorted = [...pages].sort((a, b) => a - b)
    const removed = new Set(sorted)

    // Delete is destructive, not undoable (clears history rather than snapshotting — spec-web §12
    // states Rotate is "Fully undoable" in explicit contrast). It can't be made undoable here
    // regardless: _page_map (below) lives outside DocumentState, so a restored applied/rotation
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
    // dimensions through _page_map, so it has to be reindexed first (bug 2a — the union was judged
    // against a stale page map).
    this._page_map = this._page_map.filter((_, i) => !removed.has(i))

    if (this._auto_active && this._detect_cache.size > 0) {
      // Same FULL_PAGE_FRAC exclusion the initial detect applies (bug 2a): the old raw
      // detection_union() re-admitted full-page fallback boxes, distorting the union after a delete.
      this._union = this._compute_detection_union(this._detect_cache)
      this._auto_active = this._union !== null
    } else {
      this._union = null
      this._auto_active = false
    }

    this._source_cache.clear()
    this._work_cache.clear()
    this._output_cache.clear()
    this._current_page = Math.min(this._current_page, this.page_count() - 1)
    this._view_pos = Math.min(this._view_pos, this.view_total)
    this._invalidate_current_bitmap()
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
        orig_page: this._page_map[p] ?? p,
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
        const src   = await this._get_work(p)
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
        image:  this._output_cache.get(`${p}:${split_idx}`) ?? null,
        page_w: box ? box_width(box)  : sz.width,
        page_h: box ? box_height(box) : sz.height,
        crop_origin: box ? { x: box.x0, y: box.y0 } : { x: 0, y: 0 },
        overlay: this._committed_overlay(box),
        draw_rect:  this._draw_rect,
        position:   this._view_pos,
        total:      this.view_total,
        status:     this._status_string(p, sz),
        is_loading: this._is_loading,
      }
    }

    return {
      image:   this._current_bitmap ?? null,
      page_w:  sz.width,
      page_h:  sz.height,
      crop_origin: { x: 0, y: 0 },
      overlay: this._build_overlay(p),
      draw_rect:  this._draw_rect,
      position:   this._view_pos,
      total:      this.view_total,
      status:     this._status_string(p, sz),
      is_loading: this._is_loading,
    }
  }

  // The outline shown over a committed (cropped) page: only the drawn window, clamped to the crop
  // box so it can never paint outside the cropped view (frozen spec §9.3). Empty when no window is
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

  // Call this before reading view_snapshot() to ensure bitmaps are ready.
  async prepare_current_view(): Promise<void> {
    if (!this._doc) return
    this._is_loading = true
    const p = this._current_page

    try {
      const work = await this._get_work(p)
      this._current_bitmap = work
      const committed = this.document.applied.get(p)
      if (committed) await this._prerender_output_views(p, committed, work)
    } finally {
      this._is_loading = false
    }

    // Warm the adjacent pages in the background so next/prev is a cache hit instead of a blank
    // "Loading…" flash while the (potentially heavy, scanned-mode) work raster renders on demand.
    this._prefetch(p + 1)
    this._prefetch(p - 1)
  }

  private readonly _prefetching = new Set<number>()

  private _prefetch(p: number): void {
    if (p < 0 || p >= this.page_count() || this._prefetching.has(p)) return
    const warm = this._mode === Mode.SCANNED ? this._work_cache.has(p) : this._source_cache.has(p)
    if (warm) return
    this._prefetching.add(p)
    void this._get_work(p).catch(() => { /* best-effort warm */ })
      .finally(() => { this._prefetching.delete(p) })
  }

  // Pre-render every split view's output bitmap for a committed page (so jumping
  // between split views via view_snapshot() never blocks on a render call).
  private async _prerender_output_views(p: number, committed: Box[], work: ImageBitmap): Promise<void> {
    const sz = this._current_page_size()
    // Preview must NOT bake in output quality: compress DPI + grayscale are EXPORT-only
    // (spec-web §W2 row 8). Rendering the working preview at the export DPI made a committed
    // crop show at e.g. 75 dpi (395×505) and in grayscale; the editing view stays full-res and
    // true-colour. render_output_image is still the single path — only the DPI/colour args differ.
    for (let i = 0; i < committed.length; i++) {
      const key = `${p}:${i}`
      if (this._output_cache.has(key)) continue
      const box = committed[i]
      if (!box) continue
      const out = await this._adapter.render_output_image(
        work, box, sz.width, sz.height, null, false)
      this._output_cache.set(key, out)
    }
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
  get split_count(): 1 | 2 | 4 { return this._split_count }
  get same_size(): boolean { return this._same_size }
  get anchor_left(): boolean { return this._anchor_left }
  get anchor_top(): boolean { return this._anchor_top }
  get keep_ratio(): boolean { return this._keep_ratio }
  get ratio(): number { return this._ratio }
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
  // `p` is a logical (post-delete) index — translate through _page_map to reach the
  // original-indexed page_sizes array, same boundary _get_work() crosses for the adapter.
  private _page_dims(p: number): PageSize {
    const orig = this._page_map[p] ?? p
    const sz = this._doc?.page_sizes[orig] ?? { width: SYNTH_W, height: SYNTH_H }
    const rot = this.document.rotation.get(p) ?? 0
    return rot % 180 === 90 ? { width: sz.height, height: sz.width } : sz
  }

  private _current_page_size(): PageSize {
    return this._page_dims(this._current_page)
  }

  // Raw page raster (before scan processing), rendered once per page and cached. Every consumer
  // that needs pixels — the NORMAL view, the SCANNED work pipeline, and Auto-detect — goes through
  // here, so the PDF is rasterized exactly once per (page, rotation), never twice (§W2 row 5).
  private async _get_source(p: number): Promise<ImageBitmap> {
    const cached = this._source_cache.get(p)
    if (cached) return cached
    const doc = this._doc
    const dpi = this._mode === Mode.SCANNED ? SRC_DPI : NORMAL_DPI
    const rotation = this.document.rotation.get(p) ?? 0
    // p is logical (post-delete); the adapter only knows original pdf.js page indices.
    const orig = this._page_map[p] ?? p
    const b = doc && !doc.synthetic
      ? await this._adapter.get_source_image(orig, dpi, rotation)
      : await this._adapter.make_synth_page(orig, SYNTH_W, SYNTH_H)
    this._source_cache.set(p, b)
    return b
  }

  private async _get_work(p: number): Promise<ImageBitmap> {
    const cached = this._work_cache.get(p)
    if (cached) return cached

    const src = await this._get_source(p)
    if (this._mode !== Mode.SCANNED) {
      // NORMAL: the work raster IS the source raster. Do NOT also store it in _work_cache — the
      // same bitmap in two close-on-evict caches gets double-closed, detaching a bitmap the other
      // cache still serves (root of the "image source is detached" crash). It stays in _source_cache.
      return src
    }

    // A no-op intent (no dewarp, no filter) has no work raster distinct from the source — return
    // src directly rather than caching a duplicate (same double-close hazard as NORMAL).
    const intent = this._page_process_intent(p)
    if (!intent.dewarp && !intent.filter) return src

    const key = this._work_disk_key(p, intent)
    // Only hit the disk tier for a key we actually persisted (see _persisted_keys) — a page that
    // never left RAM was never written, so skip the IndexedDB round-trip (and its clear-serialized
    // stall) entirely.
    const disk = this._persisted_keys.has(key) ? await this._load_work_from_disk(key) : null
    if (disk) { this._cache_work(p, key, disk); return disk }

    const work = await this._adapter.get_work_image(src, intent, this.settings.dewarp_supersample)
    // Write-back cache: don't persist here — the disk write happens only if/when this raster is
    // evicted from RAM (see _work_cache's onCapacityEvict). Small documents never evict, so they
    // never pay for a disk write they'd never read back.
    this._cache_work(p, key, work)
    return work
  }

  private _cache_work(p: number, key: string, work: ImageBitmap): void {
    this._work_disk_keys.set(p, key)
    this._work_cache.set(p, work)
  }

  private _page_process_intent(p: number): PageProcessIntent {
    return {
      dewarp: this.document.processed.get(p)?.dewarp ?? this.document.dewarp_on,
      filter: this.document.filter_mode === FilterMode.NONE ? null
        : [this.document.filter_mode, this.document.filter_strength],
    }
  }

  // Two-tier work cache — disk (IndexedDB) tier. Key = document generation + original page index +
  // full intent (dewarp, filter mode/strength), rotation and supersample: any change yields a
  // different key, so a settings change never returns a stale raster (it re-processes into a new
  // key instead) and a new document (new _doc_gen) never collides with a prior one's rasters.
  private _work_disk_key(p: number, intent: PageProcessIntent): string {
    const orig = this._page_map[p] ?? p
    const filt = intent.filter ? `${intent.filter[0]}-${intent.filter[1]}` : 'none'
    const rot = this.document.rotation.get(p) ?? 0
    return `g${this._doc_gen}|${orig}|d${intent.dewarp ? 1 : 0}|f${filt}|r${rot}|s${this.settings.dewarp_supersample}`
  }

  private _load_work_from_disk(key: string): Promise<ImageBitmap | null> {
    // No wait on the load-time clear: _doc_gen namespaces the key, so there is no cross-document
    // collision to guard against, and the read just misses (fast) for a never-persisted page.
    return this._adapter.load_work?.(key) ?? Promise.resolve(null)
  }

  private _live_auto_crop_for(p: number): Box | null {
    const detected = this._detect_cache.get(p)
    const union    = this._union
    if (!detected || !union || !this._auto_active
        || !(this._anchor_left || this._anchor_top)) return null
    const sz = this._page_dims(p)
    let rect = auto_crop_rect(detected, union, this.document.offsets,
      sz.width, sz.height, this._anchor_left, this._anchor_top)
    if (this._keep_ratio) rect = keep_ratio_normalise(rect, this._ratio, sz.width, sz.height)
    return rect
  }

  private _build_overlay(p: number): OverlayBox[] {
    const out: OverlayBox[] = []

    if (this._split_count > 1) {
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

  private _invalidate_output_cache(p: number): void {
    for (let i = 0; i < MAX_SPLIT; i++) this._output_cache.delete(`${p}:${i}`)
  }

  private _invalidate_current_bitmap(): void { this._current_bitmap = null }

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
