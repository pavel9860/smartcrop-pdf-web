// CropController (§18 AppModel decomposition, step 3/7) — anchors/offsets/keep-ratio/split/
// same-size (spec-web §6.5) and the full drag gesture state machine (spec-web §6.6). Owns every
// field that describes "what crop shape is currently being edited or configured", separate from
// DocumentState's committed/undoable crop (`applied`) and from detection state (detect_cache/
// union/auto_active), which stay on AppModel — several methods here still need to READ that
// detection state and the pending hand-drawn window (`drawn`), so both are threaded through via
// CropContext rather than duplicated here.
import type { Box } from './geometry'
import {
  hit_handle, apply_handle_drag, auto_crop_rect, centered_crop_rect,
  offsets_from_rect, keep_ratio_normalise, keep_ratio_anchored, clamp_box_drag,
  split_rects_grid, edge_deltas, apply_edge_deltas, clamp_edge_deltas,
  manual_offset_rect, offsets_from_manual_rect,
  MIN_RECT, box_width, box_height,
} from './geometry'
import type { DocumentState, Offsets } from './document_state'
import type { History } from './history'
import { OFFSET_LIMIT, MANUAL_OFFSET_DEFAULT } from './constants'
import type { PageSize } from './model'
import { type DragState, type AutoDrag, type SplitDrag, type DrawDrag, type DrawnDrag } from './drag'

// Live reads/writes into AppModel state that CropController doesn't own: `document` is reassigned
// wholesale on undo/redo, so it must be read through a function, never captured; `drawn` (the
// pending hand-drawn window) and detected/union/auto_active are detection-domain state that
// outlives a single drag (read by view-snapshot overlay building and apply_crop too), so they stay
// on AppModel and are exposed here as a live get/set pair rather than duplicated.
export interface CropContext {
  document(): DocumentState
  has_document(): boolean
  current_page(): number
  page_dims(p: number): PageSize
  detected(p: number): Box | null
  union(): Box | null
  auto_active(): boolean
  set_auto_active(on: boolean): void
  drawn(): Box | null
  set_drawn(box: Box | null): void
}

export class CropController {
  private _anchor_left  = true
  private _anchor_top   = true
  private _keep_ratio   = false
  private _ratio        = 1.0
  private _split_count: 1 | 2 | 4 = 1
  private _same_size    = false
  private _drag:      DragState | null = null
  private _draw_rect: Box | null = null
  // Manual-offsets mode (spec-web §4.6) — same tier as the anchor flags above (non-undoable
  // CropController state), not a DocumentState field. The window itself is the existing `drawn`
  // window (CropContext), not separate stored state: compute_crop_boxes_for_page() already gives
  // `drawn` top priority over auto-crop, so nothing else needs to change to make it authoritative.
  private _manual_offsets_on = false

  constructor(
    private readonly _history: History,
    private readonly _ctx: CropContext,
  ) {}

  get anchor_left():  boolean       { return this._anchor_left }
  get anchor_top():   boolean       { return this._anchor_top }
  get keep_ratio():   boolean       { return this._keep_ratio }
  get ratio():        number        { return this._ratio }
  get split_count():  1 | 2 | 4     { return this._split_count }
  get same_size():    boolean       { return this._same_size }
  get draw_rect():    Box | null    { return this._draw_rect }
  get manual_offsets_on(): boolean  { return this._manual_offsets_on }

  reset(initial_ratio: number): void {
    this._split_count = 1
    this._anchor_left = true
    this._anchor_top = true
    this._keep_ratio = false
    this._ratio = initial_ratio
    this._same_size = false
    this._drag = null
    this._draw_rect = null
    this._manual_offsets_on = false
  }

  // Turning on seeds the predefined MANUAL_OFFSET_DEFAULT% margin as the current page's `drawn`
  // window; turning off drops it (falls back to auto-crop/nothing, matching "auto-detect is
  // disabled only while manual mode is on").
  set_manual_offsets_on(on: boolean): void {
    this._manual_offsets_on = on
    if (!this._ctx.has_document()) return
    const sz = this._ctx.page_dims(this._ctx.current_page())
    this._ctx.set_drawn(on
      ? manual_offset_rect(
          { left: MANUAL_OFFSET_DEFAULT, top: MANUAL_OFFSET_DEFAULT,
            right: MANUAL_OFFSET_DEFAULT, bottom: MANUAL_OFFSET_DEFAULT },
          sz.width, sz.height)
      : null)
  }

  // Live view onto the current `drawn` window as edge percentages — not separately stored, so a
  // drag-resize and a field edit can never disagree about the window's position.
  manual_offsets(): Offsets {
    const drawn = this._ctx.drawn()
    if (!drawn || !this._ctx.has_document()) {
      return { left: MANUAL_OFFSET_DEFAULT, top: MANUAL_OFFSET_DEFAULT,
        right: MANUAL_OFFSET_DEFAULT, bottom: MANUAL_OFFSET_DEFAULT }
    }
    const sz = this._ctx.page_dims(this._ctx.current_page())
    return offsets_from_manual_rect(drawn, sz.width, sz.height)
  }

  set_manual_offset(edge: 'L' | 'T' | 'R' | 'B', value: number): void {
    if (!this._ctx.has_document() || !this._manual_offsets_on) return
    const o = this.manual_offsets()
    const clamped = Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, value))
    const next: Offsets = {
      left:   edge === 'L' ? clamped : o.left,
      top:    edge === 'T' ? clamped : o.top,
      right:  edge === 'R' ? clamped : o.right,
      bottom: edge === 'B' ? clamped : o.bottom,
    }
    const sz = this._ctx.page_dims(this._ctx.current_page())
    this._ctx.set_drawn(manual_offset_rect(next, sz.width, sz.height))
  }

  // Ratio source after a fresh detect is the detection UNION's aspect ratio, not the page's
  // (model.py:375-376 _finish_detect) — keep-ratio locks the crop to the shape of the detected
  // content, not the whole page. Caller (DetectionService._run_detect) already guards `!keep_ratio`.
  set_ratio(r: number): void { this._ratio = r }

  // Resolves the crop box(es) to commit for page `p` on Crop (spec-web §4.5, §12.2): a hand-drawn
  // window takes precedence, clamped to the page; otherwise the live auto-crop from the last
  // detect, if anchored — a page with no detected content of its own still gets the shared union's
  // W×H, centered on the page rather than left uncropped (bug #8/#9); null only if auto-detect
  // itself isn't active/anchored.
  compute_crop_boxes_for_page(p: number): Box[] | null {
    if (!this._ctx.has_document()) return null
    const sz = this._ctx.page_dims(p)

    const drawn = this._ctx.drawn()
    if (drawn) {
      return [{
        x0: Math.max(0, Math.min(drawn.x0, sz.width)),
        y0: Math.max(0, Math.min(drawn.y0, sz.height)),
        x1: Math.max(0, Math.min(drawn.x1, sz.width)),
        y1: Math.max(0, Math.min(drawn.y1, sz.height)),
      }]
    }

    const detected = this._ctx.detected(p)
    const union    = this._ctx.union()
    if (union && this._ctx.auto_active() && (this._anchor_left || this._anchor_top)) {
      let rect = detected
        ? auto_crop_rect(detected, union, this._ctx.document().offsets,
            sz.width, sz.height, this._anchor_left, this._anchor_top)
        : centered_crop_rect(union, sz.width, sz.height)
      if (this._keep_ratio) rect = keep_ratio_normalise(rect, this._ratio, sz.width, sz.height)
      return [rect]
    }
    return null
  }

  // Whether Crop has anything to commit at split = 1: a drawn/manual window, or an active,
  // anchored auto-crop — same condition compute_crop_boxes_for_page falls back to null on, without
  // needing a page (both sources are global, not per-page).
  has_crop_source(): boolean {
    if (this._ctx.drawn()) return true
    return this._ctx.union() !== null && this._ctx.auto_active()
      && (this._anchor_left || this._anchor_top)
  }

  set_anchor(left: boolean | null, top: boolean | null): void {
    if (left !== null) this._anchor_left = left
    if (top  !== null) this._anchor_top  = top
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
      const r = this._ctx.document().crop_rects[0]
      if (r && box_height(r) > 0) return box_width(r) / box_height(r)
    } else {
      const d = this._ctx.drawn()
      if (d && box_height(d) > 0) return box_width(d) / box_height(d)
    }
    const u = this._ctx.union()
    if (u && box_height(u) > 0) return box_width(u) / box_height(u)
    if (this._ctx.has_document()) {
      const sz = this._ctx.page_dims(this._ctx.current_page())
      if (sz.height > 0) return sz.width / sz.height
    }
    return 1.0
  }

  set_split(n: 1 | 2 | 4): void {
    if (n === this._split_count) return
    this._history.push(this._ctx.document())
    // Committed crops belong to the previous layout — drop them when the split changes
    // (desktop model.py:417-418). Prevents stale single-crop pages surviving into split mode.
    const doc = this._ctx.document()
    doc.applied.clear()
    this._ctx.set_drawn(null)
    this._manual_offsets_on = false   // the manual window belongs to split=1, same as `drawn` above
    this._split_count = n
    if (this._ctx.has_document()) {
      const sz = this._ctx.page_dims(this._ctx.current_page())
      // n === 1 has no split rectangles (desktop clears crop_rects); 2/4 auto-lay the grid.
      doc.crop_rects = n === 1 ? [] : split_rects_grid(n, sz.width, sz.height)
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
    const doc = this._ctx.document()
    const rects = doc.crop_rects
    const first = rects[0]
    if (!this._ctx.has_document() || !first) return
    const sz = this._ctx.page_dims(this._ctx.current_page())
    const max_w = Math.min(...rects.map(r => sz.width - r.x0))
    const max_h = Math.min(...rects.map(r => sz.height - r.y0))
    const w = Math.max(MIN_RECT, Math.min(box_width(first), max_w))
    const h = Math.max(MIN_RECT, Math.min(box_height(first), max_h))
    this._history.push(doc)
    doc.crop_rects = rects.map(r => ({ x0: r.x0, y0: r.y0, x1: r.x0 + w, y1: r.y0 + h }))
  }

  // ---------------------------------------------------------------------------
  // Gestures — delegated to per-kind helpers so each is ≤30 lines
  // ---------------------------------------------------------------------------

  begin_drag(px: number, py: number, tol: number): void {
    if (!this._ctx.has_document()) return
    const p = this._ctx.current_page()
    const sz = this._ctx.page_dims(p)
    const pt: readonly [number, number] = [px, py]

    if (this._split_count > 1) { this._begin_split_drag(pt, tol, sz); return }
    // A pending manual window (drawn): grab a handle to resize, press INSIDE to move it,
    // press OUTSIDE to drop it and rubber-band a new one (desktop WindowDrag / DrawDrag, §9.3/§9.4).
    // hit_handle() itself returns 'move' for any interior point, so a hit here is never null.
    const drawn = this._ctx.drawn()
    if (drawn) {
      const h = hit_handle(drawn, px, py, tol)
      if (h) {
        this._drag = {
          kind: 'drawn', handle: h, rect0: drawn, start: pt,
          page_w: sz.width, page_h: sz.height,
        } satisfies DrawnDrag
        return
      }
      // Manual-offsets mode (spec-web §4.6): the window can be resized/moved but never dropped —
      // no free-draw replacement, no auto-detect fallback (both explicitly disabled while it's on).
      if (this._manual_offsets_on) return
      this._begin_draw_drag(pt, sz)   // outside the window → drop it, start a fresh draw
      return
    }
    // A committed page (split = 1) is not itself a drag target — the crop is fixed until Undo or
    // a new Crop. Any drag rubber-bands a NEW window over the cropped view (frozen spec §9.3),
    // which commits only via the Crop button. So skip auto/crop-edit and draw directly.
    const committed = this._ctx.document().applied.get(p)
    if (committed && committed.length > 0) { this._begin_draw_drag(pt, sz); return }
    if (this._begin_auto_drag(pt, tol, sz)) return
    this._begin_draw_drag(pt, sz)
  }

  private _begin_split_drag(
    pt: readonly [number, number], tol: number, sz: PageSize,
  ): void {
    const [px, py] = pt
    const doc = this._ctx.document()
    for (let i = 0; i < doc.crop_rects.length; i++) {
      const rect = doc.crop_rects[i]
      if (!rect) continue
      const h = hit_handle(rect, px, py, tol)
      if (h) {
        this._history.push(doc)   // snapshot BEFORE the drag mutates crop_rects live
        this._drag = {
          kind: 'split', idx: i, handle: h, rect0: rect,
          rects0: [...doc.crop_rects],   // same-size v2 bases + §9.6 cancel restore
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
    const p = this._ctx.current_page()
    const detected = this._ctx.detected(p)
    const union    = this._ctx.union()
    if (!this._ctx.auto_active() || !detected || !union
        || !(this._anchor_left || this._anchor_top)) return false

    let live = auto_crop_rect(detected, union, this._ctx.document().offsets,
      sz.width, sz.height, this._anchor_left, this._anchor_top)
    if (this._keep_ratio) live = keep_ratio_normalise(live, this._ratio, sz.width, sz.height)
    const h = hit_handle(live, px, py, tol)
    if (!h) return false

    this._history.push(this._ctx.document())   // snapshot BEFORE the drag mutates offsets live
    this._drag = {
      kind: 'auto', handle: h, rect0: live, start: pt,
      page_w: sz.width, page_h: sz.height,
      offsets0: this._ctx.document().offsets,
      left_base: this._anchor_left ? detected.x0 : union.x0,
      top_base:  this._anchor_top  ? detected.y0 : union.y0,
    } satisfies AutoDrag
    return true
  }

  private _begin_draw_drag(pt: readonly [number, number], sz: PageSize): void {
    this._ctx.set_drawn(null)   // a fresh press drops the previous drawn window at once (bug 6)
    this._drag = { kind: 'draw', start: pt, page_w: sz.width, page_h: sz.height } satisfies DrawDrag
    this._draw_rect = null
  }

  update_drag(px: number, py: number): void {
    const drag = this._drag
    if (!drag) return
    const sz = this._ctx.page_dims(this._ctx.current_page())

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
    const committed = this._ctx.document().applied.get(this._ctx.current_page())?.[0]
    if (committed) {
      rect = {
        x0: Math.max(rect.x0, committed.x0), y0: Math.max(rect.y0, committed.y0),
        x1: Math.min(rect.x1, committed.x1), y1: Math.min(rect.y1, committed.y1),
      }
    }
    this._draw_rect = rect
  }

  private _update_auto_drag(drag: AutoDrag, px: number, py: number, sz: PageSize): void {
    let updated = apply_handle_drag(drag.handle, drag.rect0,
      drag.start, [px, py], drag.page_w, drag.page_h)
    if (this._keep_ratio) updated = keep_ratio_normalise(updated, this._ratio, sz.width, sz.height)
    const detected = this._ctx.detected(this._ctx.current_page())
    const union    = this._ctx.union()
    if (detected && union) {
      this._ctx.document().offsets = offsets_from_rect(updated, detected, union,
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
    const doc = this._ctx.document()
    const rects = [...doc.crop_rects]
    rects[drag.idx] = updated
    // Same-size propagates ONLY on a resize (spec-web §W2 row 10) — `move` (dragging a window's
    // interior to translate it) NEVER syncs partners, in any state; this is a deliberate,
    // permanent exclusion (a prior design mirrored move deltas too, and that was wrong).
    if (this._same_size && drag.handle !== 'move') this._propagate_same_size(drag, updated, rects)
    doc.crop_rects = rects
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
    const box = apply_handle_drag(drag.handle, drag.rect0,
      drag.start, [px, py], drag.page_w, drag.page_h)
    // Keep-ratio holds LIVE during a resize, anchored opposite the dragged handle so only the
    // dragged side moves (spec-web §W2 row 9). A move ('move' handle) preserves the ratio.
    this._ctx.set_drawn((this._keep_ratio && drag.handle !== 'move')
      ? keep_ratio_anchored(box, this._ratio, drag.handle, drag.page_w, drag.page_h)
      : box)
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
        const sz = this._ctx.page_dims(this._ctx.current_page())
        drawn = keep_ratio_normalise(rect, this._ratio, sz.width, sz.height)
      }
      // The drawn window is a GLOBAL pending crop shown as an outline on every page — it is NOT
      // committed here. Clicking Crop maps it onto each selected page then clears it, so a hand-
      // drawn window crops ALL pages (desktop §9.3/§12.2), and the page never zooms to the crop
      // on mouse-up (was the "magnification" bug). drawn is non-undoable working state (§W9.2) —
      // no history.push here (removed): finishing a rubber-band draw must not clear the redo
      // stack, since nothing undo-tracked changes until Crop commits it into `applied`.
      this._ctx.set_drawn(drawn)
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
      // Manual-offsets mode disables dropping/redrawing the window entirely (spec-web §4.6) —
      // same guard as begin_drag's click-outside case.
      if (this._manual_offsets_on) return
      // Esc / right-click drops the drawn window if one exists (bug 5); else deactivates the
      // auto-detect frame instead (spec-web §6.2) — its cached result survives and re-activates
      // on the next Auto-detect press.
      if (this._ctx.drawn() !== null) { this._ctx.set_drawn(null); return }
      if (this._ctx.auto_active()) this._ctx.set_auto_active(false)
      return
    }

    if (drag.kind === 'auto') {
      this._ctx.document().offsets = drag.offsets0
    } else if (drag.kind === 'split') {
      // §9.6: Esc/right-click during a drag leaves the windows unchanged — restore EVERY window
      // (same-size v2 moves partners live, so the dragged rect alone is not enough).
      this._ctx.document().crop_rects = [...drag.rects0]
    } else if (drag.kind === 'drawn') {
      // Cancelling a move/resize of an EXISTING window restores it, not drops it (help_view §5:
      // cancel changes nothing) — distinct from the no-drag Esc above, which intentionally drops
      // a pending window that was never being edited.
      this._ctx.set_drawn(drag.rect0)
    }
    // 'draw': nothing to restore — _begin_draw_drag already cleared any prior drawn window at
    // press time (bug 6), and no window was committed yet.
  }
}
