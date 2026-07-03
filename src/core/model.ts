// AppModel — single facade; owns all domain state (ARCHITECTURE §5, CLAUDE.md).
// ui/ calls only public methods and reads only the frozen value objects they return.
// core/ never imports DOM, Worker, pdf-lib, or pdfjs-dist.

import {
  type DocumentState, type Offsets, type PageProcessIntent,
  default_document_state, DEFAULT_OFFSETS,
} from './document_state'
import { History } from './history'
import { type Settings, default_settings } from './settings'
import { type DragState, type AutoDrag, type SplitDrag, type DrawDrag, type CropEditDrag } from './drag'
import {
  type Box,
  hit_handle, apply_handle_drag, auto_crop_rect,
  offsets_from_rect, keep_ratio_normalise, clamp_box_drag,
  split_rects_grid, rotate_box_cw, reindex_map, detection_union,
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

export interface RendererAdapter {
  load_files(files: File[]): Promise<DocInfo>
  get_source_image(page_idx: number, dpi: number, rotation: number): Promise<ImageBitmap>
  get_work_image(page_idx: number, intent: PageProcessIntent, supersample: number,
                 rotation: number): Promise<ImageBitmap>
  render_output_image(src: ImageBitmap, box: Box, page_w: number, page_h: number,
                      target_dpi: number | null, greyscale: boolean): Promise<ImageBitmap>
  detect_content_box(img: ImageBitmap, page_w: number, page_h: number, mode: Mode): Promise<Box>
  export_pdf(pages: OutputPage[]): Promise<Uint8Array>
  export_images(pages: OutputPage[], format: 'JPG' | 'PNG'): Promise<Blob[]>
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

  // Interaction settings (not undoable)
  private _anchor_left  = true
  private _anchor_top   = true
  private _keep_ratio   = false
  private _ratio        = 1.0
  private _split_count: 1 | 2 | 4 = 1
  private _same_size    = false
  private _pages_mode   = PagesMode.ALL
  private _select_pattern = ''
  private _current_follow = false

  // Transient drag state (not snapshotted)
  private _drag:         DragState | null = null
  private _draw_rect:    Box | null = null
  private _prev_applied: Box[] | null = null   // stash on drag start for cancel

  // History and settings
  readonly history = new History(DEFAULT_UNDO_DEPTH)
  readonly settings: Settings = default_settings()

  // Raster caches (source = raw page; work = after scan processing)
  private _source_cache = new LRUCache<number, ImageBitmap>(CACHE_WINDOW,
    (_, b) => { b.close() })
  private _work_cache = new LRUCache<number, ImageBitmap>(CACHE_WINDOW,
    (_, b) => { b.close() })

  // Pre-rendered output bitmaps for committed pages (keyed "page:split_idx")
  private _output_cache = new LRUCache<string, ImageBitmap>(CACHE_WINDOW * 2,
    (_, b) => { b.close() })

  // Currently displayed bitmap (synchronously available for view_snapshot)
  private _current_bitmap: ImageBitmap | null = null
  private _is_loading = false

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
    this._ratio = 1.0
    this._same_size = false
    this._pages_mode = PagesMode.ALL
    this._select_pattern = ''
    this._current_follow = false
    this._drag = null
    this._draw_rect = null
    this._prev_applied = null
    this._source_cache.clear()
    this._work_cache.clear()
    this._output_cache.clear()
    this._current_bitmap = null
    this._page_map = this._doc ? Array.from({ length: this._doc.page_count }, (_, i) => i) : []
  }

  get has_document(): boolean { return this._doc !== null }
  page_count(): number { return this._page_map.length }

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

    this.history.push(this.document)
    for (const [p, box] of per_page_boxes) this.document.detect_cache.set(p, box)
    this.document.union = union
    this.document.auto_active = true

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
        const img  = await this._get_work(p)
        const box  = await this._adapter.detect_content_box(img, size.width, size.height, this._mode)
        per_page_boxes.set(p, box)
      } catch (e) {
        ctrl.complete(new Failed(new ImagingError(String(e))))
        return null
      }
      ctrl.advance()
    }
    return per_page_boxes
  }

  // Aggregate per-page boxes into the union frame, excluding full-page fallback boxes (spec §8)
  private _compute_detection_union(per_page_boxes: Map<number, Box>): Box | null {
    const valid: Box[] = []
    for (const [p, box] of per_page_boxes) {
      const sz = this._page_dims(p)
      if (box_width(box) / sz.width < FULL_PAGE_FRAC || box_height(box) / sz.height < FULL_PAGE_FRAC) {
        valid.push(box)
      }
    }
    return valid.length > 0 ? detection_union(valid) : null
  }

  // Re-detect refreshes committed crops without dropping them (spec §7.4)
  private _refresh_committed_crops_after_detect(pages: number[], union: Box | null): void {
    if (!union) return
    for (const p of pages) {
      if (!this.document.applied.has(p)) continue
      const detected = this.document.detect_cache.get(p)
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
    this.document.drawn = null   // the drawn window became the crop across all pages (§12.2)
  }

  private _compute_crop_boxes_for_page(p: number): Box[] | null {
    const doc = this._doc
    if (!doc) return null
    const sz = this._page_dims(p)

    // Hand-drawn window takes precedence — clamp the global window to this page (§12.2).
    const drawn = this.document.drawn
    if (drawn) {
      return [{
        x0: Math.max(0, Math.min(drawn.x0, sz.width)),
        y0: Math.max(0, Math.min(drawn.y0, sz.height)),
        x1: Math.max(0, Math.min(drawn.x1, sz.width)),
        y1: Math.max(0, Math.min(drawn.y1, sz.height)),
      }]
    }

    const detected  = this.document.detect_cache.get(p)
    const union     = this.document.union

    if (detected && union && this.document.auto_active
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
    const detected = this.document.detect_cache.get(this._current_page)
    const union    = this.document.union
    if (!detected || !union) return

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
    else if (on && was_off) {
      // Pre-populate from the detection union's aspect ratio when detection has run; otherwise
      // default to the current PAGE's aspect ratio, not a bare 1.0 (bug E — "keep ratio set by
      // default 1 not page w/h"). keep-ratio then locks to the content shape, or the page.
      const u = this.document.union
      if (u && box_height(u) > 0) {
        this._ratio = box_width(u) / box_height(u)
      } else if (this._doc) {
        const sz = this._current_page_size()
        if (sz.height > 0) this._ratio = sz.width / sz.height
      }
    }
  }

  set_split(n: 1 | 2 | 4): void {
    if (n === this._split_count) return
    // Committed crops belong to the previous layout — drop them when the split changes
    // (desktop model.py:417-418). Prevents stale single-crop pages surviving into split mode.
    this.document.applied.clear()
    this.document.drawn = null
    this._split_count = n
    if (this._doc) {
      const sz = this._page_dims(this._current_page)
      // n === 1 has no split rectangles (desktop clears crop_rects); 2/4 auto-lay the grid.
      this.document.crop_rects = n === 1 ? [] : split_rects_grid(n, sz.width, sz.height)
    }
  }

  set_same_size(on: boolean): void { this._same_size = on }

  // ---------------------------------------------------------------------------
  // Gestures — delegated to per-kind helpers so each is ≤30 lines
  // ---------------------------------------------------------------------------

  begin_drag(px: number, py: number, tol: number): void {
    if (!this._doc) return
    const sz = this._current_page_size()
    const pt: readonly [number, number] = [px, py]

    if (this._split_count > 1) { this._begin_split_drag(pt, tol, sz); return }
    // A pending drawn window overrides auto/committed gestures — a fresh drag redraws it.
    if (this.document.drawn) { this._begin_draw_drag(pt, sz); return }
    if (this._begin_auto_drag(pt, tol, sz)) return
    if (this._begin_crop_edit_drag(pt, tol, sz)) return
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
        this._drag = {
          kind: 'split', idx: i, handle: h, rect0: rect,
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
    const detected = this.document.detect_cache.get(this._current_page)
    const union    = this.document.union
    if (!this.document.auto_active || !detected || !union
        || !(this._anchor_left || this._anchor_top)) return false

    let live = auto_crop_rect(detected, union, this.document.offsets,
      sz.width, sz.height, this._anchor_left, this._anchor_top)
    if (this._keep_ratio) live = keep_ratio_normalise(live, this._ratio, sz.width, sz.height)
    const h = hit_handle(live, px, py, tol)
    if (!h) return false

    const committed = this.document.applied.get(this._current_page)
    this._prev_applied = committed ? [...committed] : null
    this._drag = {
      kind: 'auto', handle: h, rect0: live, start: pt,
      page_w: sz.width, page_h: sz.height,
      offsets0: this.document.offsets,
      left_base: this._anchor_left ? detected.x0 : union.x0,
      top_base:  this._anchor_top  ? detected.y0 : union.y0,
    } satisfies AutoDrag
    return true
  }

  private _begin_crop_edit_drag(
    pt: readonly [number, number], tol: number, sz: PageSize,
  ): boolean {
    const [px, py] = pt
    const committed = this.document.applied.get(this._current_page)
    if (!committed?.[0]) return false
    const h = hit_handle(committed[0], px, py, tol)
    if (!h) return false

    this._prev_applied = [...committed]
    this.history.push(this.document)
    this._drag = {
      kind: 'crop_edit', handle: h, rect0: committed[0],
      start: pt, page_w: sz.width, page_h: sz.height,
    } satisfies CropEditDrag
    return true
  }

  private _begin_draw_drag(pt: readonly [number, number], sz: PageSize): void {
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
    this._update_crop_edit_drag(drag, px, py, sz)
  }

  private _update_draw_drag(drag: DrawDrag, px: number, py: number, sz: PageSize): void {
    const [sx, sy] = drag.start
    this._draw_rect = clamp_box_drag({
      x0: Math.min(sx, px), y0: Math.min(sy, py),
      x1: Math.max(sx, px), y1: Math.max(sy, py),
    }, sz.width, sz.height)
  }

  private _update_auto_drag(drag: AutoDrag, px: number, py: number, sz: PageSize): void {
    let updated = apply_handle_drag(drag.handle ?? 'move', drag.rect0,
      drag.start, [px, py], drag.page_w, drag.page_h)
    if (this._keep_ratio) updated = keep_ratio_normalise(updated, this._ratio, sz.width, sz.height)
    const detected = this.document.detect_cache.get(this._current_page)
    const union    = this.document.union
    if (detected && union) {
      this.document.offsets = offsets_from_rect(updated, detected, union,
        sz.width, sz.height, this._anchor_left, this._anchor_top)
    }
  }

  private _update_split_drag(drag: SplitDrag, px: number, py: number): void {
    const updated = apply_handle_drag(drag.handle, drag.rect0,
      drag.start, [px, py], drag.page_w, drag.page_h)
    const rects = [...this.document.crop_rects]
    rects[drag.idx] = updated
    if (this._same_size) {
      const w = box_width(updated), h = box_height(updated)
      for (let i = 0; i < rects.length; i++) {
        if (i === drag.idx) continue
        const r = rects[i]
        if (r) rects[i] = clamp_box_drag({ x0: r.x0, y0: r.y0, x1: r.x0 + w, y1: r.y0 + h },
          drag.page_w, drag.page_h)
      }
    }
    this.document.crop_rects = rects
  }

  private _update_crop_edit_drag(drag: CropEditDrag, px: number, py: number, sz: PageSize): void {
    let updated = apply_handle_drag(drag.handle, drag.rect0,
      drag.start, [px, py], drag.page_w, drag.page_h)
    if (this._keep_ratio) updated = keep_ratio_normalise(updated, this._ratio, sz.width, sz.height)
    this.document.applied.set(this._current_page, [updated])
    this._invalidate_output_cache(this._current_page)
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
      // on mouse-up (was the "magnification" bug).
      this.history.push(this.document)
      this.document.drawn = drawn
      return
    }

    if (drag.kind === 'split' && this._keep_ratio) {
      // Keep-ratio snap on release (spec §9.7)
      const rects = this.document.crop_rects.map(r =>
        keep_ratio_normalise(r, this._ratio, drag.page_w, drag.page_h))
      this.document.crop_rects = rects
    }
    // auto and crop_edit: already committed live during update_drag
  }

  cancel_drag(): void {
    const drag = this._drag
    this._drag = null
    this._draw_rect = null

    if (!drag) return

    if (drag.kind === 'auto') {
      this.document.offsets = drag.offsets0
    }
    if (drag.kind === 'crop_edit' && this._prev_applied !== null) {
      // Restore the committed crop exactly as it was before (spec §9.5)
      if (this._prev_applied.length > 0) {
        this.document.applied.set(this._current_page, this._prev_applied)
      } else {
        this.document.applied.delete(this._current_page)
      }
      this._invalidate_output_cache(this._current_page)
      this.history.undo(this.document)   // discard the snapshot taken in begin_drag
    }
    this._prev_applied = null
  }

  // ---------------------------------------------------------------------------
  // Scan processing
  // ---------------------------------------------------------------------------

  run_dewarp(): BatchJob {
    if (!this.has_document) throw new NoDocumentError('No document loaded')
    const pages = this.resolve_pages()
    if (pages.length === 0) throw new EmptySelectionError('No pages in selection')

    const job = new PageBatchJob('Dewarping…', pages.length)
    void this._run_scan_process(job, pages, { kind: 'dewarp' })
    return job
  }

  set_filter_mode(mode: FilterMode): BatchJob {
    if (!this.has_document) throw new NoDocumentError('No document loaded')
    const pages = this.resolve_pages()
    if (pages.length === 0) throw new EmptySelectionError('No pages in selection')

    // Toggle: pressing the active filter turns it off (spec §7.2)
    const effective = (mode === this.document.filter_mode) ? FilterMode.NONE : mode
    const job = new PageBatchJob(
      effective === FilterMode.NONE ? 'Removing filter…' : 'Applying filter…',
      pages.length)
    void this._run_scan_process(job, pages, { kind: 'filter', mode: effective })
    return job
  }

  set_filter_strength(n: number): BatchJob {
    if (!this.has_document) throw new NoDocumentError('No document loaded')
    const pages = this.resolve_pages()
    const strength = Math.max(FILTER_STRENGTH_MIN, Math.min(FILTER_STRENGTH_MAX, n)) as 1 | 2 | 3
    const job = new PageBatchJob('Applying filter…', Math.max(1, pages.length))
    void this._run_scan_process(job, pages, { kind: 'strength', strength })
    return job
  }

  private async _run_scan_process(
    job: PageBatchJob,
    pages: number[],
    op: { kind: 'dewarp' }
      | { kind: 'filter'; mode: FilterMode }
      | { kind: 'strength'; strength: number },
  ): Promise<void> {
    const ctrl = job.controller
    this.history.push(this.document)
    this._apply_scan_op(op)

    for (const p of pages) {
      if (ctrl.is_cancelled) { ctrl.complete(new Cancelled()); return }
      try {
        await this._reprocess_page(p)
      } catch (e) {
        ctrl.complete(new Failed(new ImagingError(String(e))))
        return
      }
      ctrl.advance()
    }
    ctrl.complete(new Ok())
  }

  private _apply_scan_op(
    op: { kind: 'dewarp' }
      | { kind: 'filter'; mode: FilterMode }
      | { kind: 'strength'; strength: number },
  ): void {
    if (op.kind === 'dewarp') {
      this.document.dewarp_on = !this.document.dewarp_on
    } else if (op.kind === 'filter') {
      this.document.filter_mode = op.mode
    } else {
      this.document.filter_strength = op.strength
    }
  }

  private async _reprocess_page(p: number): Promise<void> {
    const intent = this._page_process_intent(p)
    this.document.processed.set(p, intent)
    this._work_cache.delete(p)   // force re-render
    this._invalidate_output_cache(p)
    await this._get_work(p)     // pre-warm new work raster
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
    if (name in DPI_PRESETS) this.settings.compress_preset = name
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
  set_output_folder(folder: string): void { this.settings.output_folder = folder }
  set_output_postfix(postfix: string): void { this.settings.output_postfix = postfix }
  set_dewarp_supersample(factor: number): void {
    this.settings.dewarp_supersample = Math.max(1.0, Math.min(4.0, factor))
  }

  get output_folder(): string { return this.settings.output_folder }
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
    const det = this.document.detect_cache.get(p)
    if (det) this.document.detect_cache.set(p, rotate_box_cw(det, sz.height))

    this._source_cache.delete(p)
    this._work_cache.delete(p)
    this._invalidate_output_cache(p)

    this.document.offsets = DEFAULT_OFFSETS
    if (this.document.union) {
      const boxes = [...this.document.detect_cache.values()]
      this.document.union = boxes.length > 0 ? detection_union(boxes) : null
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

    // Delete is destructive, not undoable (model.py:596 clears history rather than snapshotting;
    // spec §13 states Rotate is "Fully undoable" in explicit contrast). It can't be made undoable
    // here regardless: _page_map (below) lives outside DocumentState, so a restored
    // applied/rotation map could reference original page indices the map no longer has — the same
    // class of desync bug as the set_keep_ratio fix above, just for a field History can't reach.
    this.history.clear()

    // Reindex per-page maps (spec §13)
    this.document.applied      = reindex_map(this.document.applied,      sorted)
    this.document.rotation     = reindex_map(this.document.rotation,     sorted)
    this.document.processed    = reindex_map(this.document.processed,    sorted)
    this.document.detect_cache = reindex_map(this.document.detect_cache, sorted)
    if (this.document.auto_active && this.document.detect_cache.size > 0) {
      this.document.union = detection_union([...this.document.detect_cache.values()])
    } else {
      this.document.union = null
      this.document.auto_active = false
    }

    // Rebuild the logical->original page index map (model.py:581-583's `doc.delete_pages` +
    // page_sizes rebuild, adapted since pdf.js has no equivalent in-place deletion primitive).
    this._page_map = this._page_map.filter((_, i) => !removed.has(i))

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

  suggested_export_name(): [string, string] {
    const doc = this._doc
    const base = doc?.file_names[0]?.replace(/\.[^.]+$/, '') ?? 'document'
    const name = base + this.settings.output_postfix
    const ext  = this.settings.export_format === 'PDF' ? '.pdf'
               : this.settings.export_format === 'JPG' ? '.jpg' : '.png'
    return [name + ext, this.settings.output_folder]
  }

  export(filename: string): BatchJob {
    if (!this.has_document) throw new NoDocumentError('No document loaded')
    const doc = this._doc
    if (!doc) throw new NoDocumentError('No document loaded')

    const total_views = this.view_total
    const job = new PageBatchJob(`Exporting ${this.settings.export_format}…`, total_views)
    void this._run_export(job, filename)
    return job
  }

  private async _run_export(job: PageBatchJob, filename: string): Promise<void> {
    const ctrl = job.controller
    const target_dpi = DPI_PRESETS[this.settings.compress_preset] ?? null
    const greyscale  = this.settings.output_colours === 'Grayscale'

    const pages_out = await this._render_export_pages(ctrl, target_dpi, greyscale)
    if (!pages_out) return

    try {
      if (this.settings.export_format === 'PDF') {
        const bytes = await this._adapter.export_pdf(pages_out)
        this._download_pdf(bytes, filename)
      } else {
        const blobs = await this._adapter.export_images(pages_out, this.settings.export_format)
        this._download_images(blobs, filename)
      }
    } catch (e) {
      ctrl.complete(new Failed(new ImagingError(String(e))))
      return
    }

    ctrl.complete(new Ok())
  }

  private async _render_export_pages(
    ctrl: BatchController,
    target_dpi: number | null, greyscale: boolean,
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
            src, box, sz.width, sz.height, target_dpi, greyscale)
          pages_out.push({ bitmap, width: bitmap.width, height: bitmap.height })
          ctrl.advance()
        }
      } catch (e) {
        ctrl.complete(new Failed(new ImagingError(String(e))))
        return null
      }
    }
    return pages_out
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
  private _download_images: (blobs: Blob[], base: string) => void = () => { return }

  set_download_handlers(
    pdf: (bytes: Uint8Array, name: string) => void,
    images: (blobs: Blob[], base: string) => void,
  ): void {
    this._download_pdf   = pdf
    this._download_images = images
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

    // A committed page (and no pending drawn window) paints the cropped output at the CROP box's
    // OWN dimensions with no outline over it — desktop canvas_view.py returns
    // ViewSnapshot(image, box.width, box.height, …). Returning full-page dims + the crop outline
    // stretched the crop to the page aspect and left a stray frame on it (bug 18).
    if (committed && committed.length > 0 && !this.document.drawn) {
      const box = committed[Math.min(split_idx, committed.length - 1)] ?? committed[0]
      return {
        image:  this._output_cache.get(`${p}:${split_idx}`) ?? null,
        page_w: box ? box_width(box)  : sz.width,
        page_h: box ? box_height(box) : sz.height,
        overlay: [],
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
      overlay: this._build_overlay(p),
      draw_rect:  this._draw_rect,
      position:   this._view_pos,
      total:      this.view_total,
      status:     this._status_string(p, sz),
      is_loading: this._is_loading,
    }
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
  }

  // Pre-render every split view's output bitmap for a committed page (so jumping
  // between split views via view_snapshot() never blocks on a render call).
  private async _prerender_output_views(p: number, committed: Box[], work: ImageBitmap): Promise<void> {
    const sz = this._current_page_size()
    const target_dpi = DPI_PRESETS[this.settings.compress_preset] ?? null
    const greyscale  = this.settings.output_colours === 'Grayscale'
    for (let i = 0; i < committed.length; i++) {
      const key = `${p}:${i}`
      if (this._output_cache.has(key)) continue
      const box = committed[i]
      if (!box) continue
      const out = await this._adapter.render_output_image(
        work, box, sz.width, sz.height, target_dpi, greyscale)
      this._output_cache.set(key, out)
    }
  }

  // ---------------------------------------------------------------------------
  // Queries / properties
  // ---------------------------------------------------------------------------

  get mode(): Mode { return this._mode }
  get auto_active(): boolean { return this.document.auto_active }
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
  get output_colours(): string { return this.settings.output_colours }
  get export_format(): ExportFormat { return this.settings.export_format }
  get undo_depth(): number { return this.settings.undo_depth }

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

  private async _get_work(p: number): Promise<ImageBitmap> {
    const cached = this._work_cache.get(p)
    if (cached) return cached

    const doc = this._doc
    const dpi = this._mode === Mode.SCANNED ? SRC_DPI : NORMAL_DPI
    const rotation = this.document.rotation.get(p) ?? 0
    // p is logical (post-delete); the adapter only knows original pdf.js page indices.
    const orig = this._page_map[p] ?? p
    const src = this._source_cache.get(p)
      ?? await (async (): Promise<ImageBitmap> => {
        const b = doc && !doc.synthetic
          ? await this._adapter.get_source_image(orig, dpi, rotation)
          : await this._adapter.make_synth_page(orig, SYNTH_W, SYNTH_H)
        this._source_cache.set(p, b)
        return b
      })()

    if (this._mode !== Mode.SCANNED) {
      this._work_cache.set(p, src)
      return src
    }

    const intent = this._page_process_intent(p)
    const work = await this._adapter.get_work_image(
      orig, intent, this.settings.dewarp_supersample, rotation)
    this._work_cache.set(p, work)
    return work
  }

  private _page_process_intent(p: number): PageProcessIntent {
    return {
      dewarp: this.document.processed.get(p)?.dewarp ?? this.document.dewarp_on,
      filter: this.document.filter_mode === FilterMode.NONE ? null
        : [this.document.filter_mode, this.document.filter_strength],
    }
  }

  private _live_auto_crop_for(p: number): Box | null {
    const detected = this.document.detect_cache.get(p)
    const union    = this.document.union
    if (!detected || !union || !this.document.auto_active
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
    const drawn = this.document.drawn
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
      image: null, page_w: SYNTH_W, page_h: SYNTH_H,
      overlay: [], draw_rect: null, position: 1, total: 0,
      status: '', is_loading: false,
    }
  }
}
