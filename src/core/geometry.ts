// Pure geometry — no I/O, no DOM, no imports from this project except constants.
// Spec §5, §9, §13. MIN_RECT lives here per spec §18.

import { OFFSET_LIMIT } from './constants'
import type { Offsets } from './document_state'

export const MIN_RECT = 5.0   // spec §18 note: lives in geometry

export interface Box {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

// Which part of a crop rectangle was hit
export type HandleId = 'TL' | 'TR' | 'BL' | 'BR' | 'T' | 'B' | 'L' | 'R' | 'move'

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by)
}

// Hit-test a point against a box's handles and interior.
// Returns handle id, 'move' for interior click (drag whole box), null for exterior.
// Priority: corners → midpoints → interior → null.
// `tol` is caller-supplied (scale-adjusted) hit radius in the same unit as px/py.
export function hit_handle(box: Box, px: number, py: number, tol: number): HandleId | null {
  const { x0, y0, x1, y1 } = box
  const mx = (x0 + x1) / 2
  const my = (y0 + y1) / 2

  if (dist(px, py, x0, y0) <= tol) return 'TL'
  if (dist(px, py, x1, y0) <= tol) return 'TR'
  if (dist(px, py, x0, y1) <= tol) return 'BL'
  if (dist(px, py, x1, y1) <= tol) return 'BR'
  if (dist(px, py, mx, y0) <= tol) return 'T'
  if (dist(px, py, mx, y1) <= tol) return 'B'
  if (dist(px, py, x0, my) <= tol) return 'L'
  if (dist(px, py, x1, my) <= tol) return 'R'
  if (px >= x0 && px <= x1 && py >= y0 && py <= y1) return 'move'

  return null
}

export function point_in_box(box: Box, px: number, py: number): boolean {
  return px >= box.x0 && px <= box.x1 && py >= box.y0 && py <= box.y1
}

// Shift a box so it lies within [0, page_w] × [0, page_h], preserving W×H.
// Only shrinks a dimension when W or H itself exceeds the page (spec §9.2).
export function clamp_box_shift(box: Box, page_w: number, page_h: number): Box {
  const w = box.x1 - box.x0
  const h = box.y1 - box.y0
  let { x0, y0, x1, y1 } = box

  if (x0 < 0)       { x0 = 0;      x1 = Math.min(w, page_w) }
  if (x1 > page_w)  { x1 = page_w; x0 = Math.max(0, page_w - w) }
  if (y0 < 0)       { y0 = 0;      y1 = Math.min(h, page_h) }
  if (y1 > page_h)  { y1 = page_h; y0 = Math.max(0, page_h - h) }

  return { x0, y0, x1, y1 }
}

// Clamp each edge independently to page bounds (used when dragging handles).
// Enforces MIN_RECT so the box never inverts or collapses.
export function clamp_box_drag(box: Box, page_w: number, page_h: number): Box {
  const x0 = Math.max(0, Math.min(box.x0, page_w - MIN_RECT))
  const y0 = Math.max(0, Math.min(box.y0, page_h - MIN_RECT))
  const x1 = Math.max(x0 + MIN_RECT, Math.min(box.x1, page_w))
  const y1 = Math.max(y0 + MIN_RECT, Math.min(box.y1, page_h))
  return { x0, y0, x1, y1 }
}

// Update a box during a handle drag.
// Only the handle's own edges move; all non-dragged edges are pixel-stable (§22.2).
export function apply_handle_drag(
  handle: HandleId,
  rect0: Box,
  start: readonly [number, number],
  current: readonly [number, number],
  page_w: number,
  page_h: number,
): Box {
  const dx = current[0] - start[0]
  const dy = current[1] - start[1]
  let { x0, y0, x1, y1 } = rect0

  switch (handle) {
    case 'TL':   x0 += dx; y0 += dy; break
    case 'TR':   x1 += dx; y0 += dy; break
    case 'BL':   x0 += dx; y1 += dy; break
    case 'BR':   x1 += dx; y1 += dy; break
    case 'T':    y0 += dy; break
    case 'B':    y1 += dy; break
    case 'L':    x0 += dx; break
    case 'R':    x1 += dx; break
    case 'move': x0 += dx; y0 += dy; x1 += dx; y1 += dy; break
  }

  // A MOVE preserves W×H and just stops at the page edge (clamp_box_shift); resize handles clamp
  // each edge independently. Using edge-clamp for a move shrank the box at the border (deform bug).
  return handle === 'move'
    ? clamp_box_shift({ x0, y0, x1, y1 }, page_w, page_h)
    : clamp_box_drag({ x0, y0, x1, y1 }, page_w, page_h)
}

// Compute the live auto-crop rectangle from detection results and offsets (spec §9.2).
export function auto_crop_rect(
  detected: Box,       // B_p: this page's content box
  union: Box,          // {x0:gL, y0:gT, x1:gL+W, y1:gT+H}
  offsets: Offsets,
  page_w: number,
  page_h: number,
  anchor_left: boolean,
  anchor_top: boolean,
): Box {
  const W = union.x1 - union.x0
  const H = union.y1 - union.y0
  const left_base = anchor_left ? detected.x0 : union.x0
  const top_base  = anchor_top  ? detected.y0 : union.y0

  const left   = left_base - (offsets.left   / 100) * page_w
  const top    = top_base  - (offsets.top    / 100) * page_h
  const right  = left_base + W + (offsets.right  / 100) * page_w
  const bottom = top_base  + H + (offsets.bottom / 100) * page_h

  return clamp_box_shift({ x0: left, y0: top, x1: right, y1: bottom }, page_w, page_h)
}

// Back-compute offsets from a dragged/drawn rectangle (spec §9.3 offset formula).
export function offsets_from_rect(
  rect: Box,
  detected: Box,
  union: Box,
  page_w: number,
  page_h: number,
  anchor_left: boolean,
  anchor_top: boolean,
): Offsets {
  const W = union.x1 - union.x0
  const H = union.y1 - union.y0
  const left_base = anchor_left ? detected.x0 : union.x0
  const top_base  = anchor_top  ? detected.y0 : union.y0

  const clamp = (v: number): number => Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, v))
  return {
    left:   clamp((left_base - rect.x0) / page_w * 100),
    right:  clamp((rect.x1 - (left_base + W)) / page_w * 100),
    top:    clamp((top_base - rect.y0) / page_h * 100),
    bottom: clamp((rect.y1 - (top_base + H)) / page_h * 100),
  }
}

// Spec-web §5: aggregate detection boxes into the union frame.
// gL=min(x0), gT=min(y0) — the min corner, always. W/H are the outlier-th LARGEST per-page
// width/height (independently), not always the max: `outlier` (default 0) is how many of the
// largest pages to ignore when sizing the shared crop, so a handful of oversized pages don't
// inflate every page's crop. outlier=0 reproduces the plain max (every prior caller's behavior).
// NOT a standard bounding box.
export function detection_union(boxes: Box[], outlier = 0): Box {
  if (boxes.length === 0) throw new RangeError('detection_union: empty array')
  let gL = Infinity, gT = Infinity
  const widths: number[] = [], heights: number[] = []
  for (const b of boxes) {
    if (b.x0 < gL) gL = b.x0
    if (b.y0 < gT) gT = b.y0
    widths.push(b.x1 - b.x0)
    heights.push(b.y1 - b.y0)
  }
  widths.sort((a, b) => b - a)
  heights.sort((a, b) => b - a)
  const idx = Math.min(Math.max(0, outlier), boxes.length - 1)
  // idx is always a valid index (0 <= idx <= boxes.length-1 === widths.length-1); the ?? 0
  // fallback only satisfies noUncheckedIndexedAccess, never actually taken.
  const W = widths[idx] ?? 0, H = heights[idx] ?? 0
  return { x0: gL, y0: gT, x1: gL + W, y1: gT + H }
}

// Standard bounding box union (for non-detection uses)
export function union_box(boxes: Box[]): Box {
  if (boxes.length === 0) throw new RangeError('union_box: empty array')
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const b of boxes) {
    if (b.x0 < x0) x0 = b.x0
    if (b.y0 < y0) y0 = b.y0
    if (b.x1 > x1) x1 = b.x1
    if (b.y1 > y1) y1 = b.y1
  }
  return { x0, y0, x1, y1 }
}

// Enforce keep-ratio (spec §9.7): height = width / ratio, anchored at top-left.
// If the ratio-constrained dimension would leave the page, clamp and follow opposite.
export function keep_ratio_normalise(
  box: Box,
  ratio: number,
  page_w: number,
  page_h: number,
): Box {
  const w = box.x1 - box.x0
  let h = w / ratio
  let x1 = box.x1
  let y1 = box.y0 + h

  if (y1 > page_h) {
    y1 = page_h
    h = y1 - box.y0
    const new_w = h * ratio
    x1 = box.x0 + new_w
    if (x1 > page_w) x1 = page_w
  }

  return { x0: box.x0, y0: box.y0, x1, y1 }
}

// Keep-ratio for a LIVE resize, anchored on the corner/edge OPPOSITE the dragged handle so only
// the dragged side moves (never the whole window). Width is authoritative for corner + vertical-edge
// drags, height for horizontal-edge drags; an edge drag grows the perpendicular axis symmetrically
// about the box centre. A 'move' preserves the ratio already. Deviates from frozen §9.7's
// on-release/top-left rule — see spec-web §W2 row 9.
// Why one long function: 4 corners + 2 symmetric-edge pairs each need their OWN page-wall clamp
// (frozen §9.7: "a ratio-constrained edge that would leave the page is clamped ... and the
// opposite dimension follows"), each re-deriving a DIFFERENT one of x0/x1/y0/y1 depending which
// point is anchored — splitting per-case would just move the same branching into smaller,
// harder-to-compare functions.
export function keep_ratio_anchored(
  box: Box,
  ratio: number,
  handle: HandleId,
  page_w: number,
  page_h: number,
): Box {
  const w = box.x1 - box.x0
  const h = box.y1 - box.y0
  let { x0, y0, x1, y1 } = box

  switch (handle) {
    case 'BR':                                                  // anchor TL
      y1 = y0 + w / ratio
      if (y1 > page_h) { y1 = page_h; x1 = x0 + (y1 - y0) * ratio }
      break
    case 'BL':                                                  // anchor TR
      y1 = y0 + w / ratio
      if (y1 > page_h) { y1 = page_h; x0 = x1 - (y1 - y0) * ratio }
      break
    case 'TR':                                                  // anchor BL
      y0 = y1 - w / ratio
      if (y0 < 0) { y0 = 0; x1 = x0 + (y1 - y0) * ratio }
      break
    case 'TL':                                                  // anchor BR
      y0 = y1 - w / ratio
      if (y0 < 0) { y0 = 0; x0 = x1 - (y1 - y0) * ratio }
      break
    case 'L':
    case 'R': {
      const cy = (y0 + y1) / 2
      const nh = Math.min(w / ratio, 2 * Math.min(cy, page_h - cy))   // room to grow symmetrically
      y0 = cy - nh / 2; y1 = cy + nh / 2
      const nw = nh * ratio                                          // width follows the (possibly
      if (handle === 'R') x1 = x0 + nw; else x0 = x1 - nw            // clamped) height; anchor side fixed
      break
    }
    case 'T':
    case 'B': {
      const cx = (x0 + x1) / 2
      const nw = Math.min(h * ratio, 2 * Math.min(cx, page_w - cx))
      x0 = cx - nw / 2; x1 = cx + nw / 2
      const nh = nw / ratio
      if (handle === 'B') y1 = y0 + nh; else y0 = y1 - nh
      break
    }
    case 'move': break                                          // translation preserves the ratio
  }
  return clamp_box_drag({ x0, y0, x1, y1 }, page_w, page_h)
}

// Rotate a box 90° CW within a page (spec §13).
// After rotation the page dimensions swap: new page is (page_h × page_w).
export function rotate_box_cw(box: Box, page_h: number): Box {
  return {
    x0: page_h - box.y1,
    y0: box.x0,
    x1: page_h - box.y0,
    y1: box.x1,
  }
}

// Inverse of rotate_box_cw — undoes exactly one CW step. `page_w` is the CURRENT box's page
// width (i.e. the page rotate_box_cw produced), not the original pre-rotation width; after this
// step the page dimensions swap back. Verified by composition: rotate_box_ccw(rotate_box_cw(box,
// h), h) === box for any box/h (rotate_box_cw's output page has width h).
export function rotate_box_ccw(box: Box, page_w: number): Box {
  return {
    x0: box.y0,
    y0: page_w - box.x1,
    x1: box.y1,
    y1: page_w - box.x0,
  }
}

// Convert a box from the CURRENT (rotation-applied) display frame back to its source's NATIVE
// (rotation=0) frame — needed wherever an operation must address the original, unrotated content
// directly (spec-web §W9.3: vector PDF export via pdf-lib embedPage, which clips the source page's
// OWN coordinate system and has no notion of this app's rotation state). Applies rotate_box_ccw
// once per 90° of current rotation, tracking width at each step (mirrors AppModel._rotate_page's
// forward walk, in reverse). `rotation` is normalised into [0,360) before stepping.
export function to_native_frame(
  box: Box, page_w: number, page_h: number, rotation: number,
): Box {
  let b = box, w = page_w, h = page_h
  for (let r = ((rotation % 360) + 360) % 360; r > 0; r -= 90) {
    b = rotate_box_ccw(b, w)
    ;[w, h] = [h, w]
  }
  return b
}

// Per-edge deltas of a resize (updated − rect0) — the unit that same-size RESIZE propagates to
// the partner windows (spec-web §W2 row 10). Never used for a 'move' drag — same-size does not
// propagate translation, only a resize's edge deltas.
export interface EdgeDeltas { dl: number; dt: number; dr: number; db: number }

export function edge_deltas(rect0: Box, updated: Box): EdgeDeltas {
  return {
    dl: updated.x0 - rect0.x0, dt: updated.y0 - rect0.y0,
    dr: updated.x1 - rect0.x1, db: updated.y1 - rect0.y1,
  }
}

// Apply mirrored edge deltas to a partner window's own drag-start rectangle (same-size resize,
// spec-web §W2 row 10): a partner in the other column swaps+negates the x pair (ΔL′=−ΔR,
// ΔR′=−ΔL), the other row the y pair (ΔT′=−ΔB, ΔB′=−ΔT); unmirrored axes copy unchanged.
// The window keeps its own placement — only its sides move, in mirrored or copied directions.
// Deltas should already be bounded by clamp_edge_deltas() before reaching here — clamp_box_drag
// below is a safety net, not the primary limiter (bug #2: a per-window post-hoc clamp here alone
// could deform one partner independently of the others and break the equal-size invariant).
export function apply_edge_deltas(
  base: Box, d: EdgeDeltas, mirror_cols: boolean, mirror_rows: boolean,
  page_w: number, page_h: number,
): Box {
  const dl = mirror_cols ? -d.dr : d.dl
  const dr = mirror_cols ? -d.dl : d.dr
  const dt = mirror_rows ? -d.db : d.dt
  const db = mirror_rows ? -d.dt : d.db
  return clamp_box_drag(
    { x0: base.x0 + dl, y0: base.y0 + dt, x1: base.x1 + dr, y1: base.y1 + db },
    page_w, page_h)
}

// Bound one axis pair (lo=dl|dt, hi=dr|db) so every window's OWN edge (direct or mirrored) stays
// on the page — used by clamp_edge_deltas below, split out because X and Y are otherwise
// identical math applied to different fields.
function clamp_axis_deltas(
  lo_raw: number, hi_raw: number,
  starts: readonly number[], ends: readonly number[], mirrored: readonly boolean[],
  page_len: number,
): { lo: number; hi: number } {
  let lo = lo_raw, hi = hi_raw
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i] ?? 0, e = ends[i] ?? 0
    if (mirrored[i]) { hi = Math.min(hi, s); lo = Math.max(lo, e - page_len) }
    else             { lo = Math.max(lo, -s); hi = Math.min(hi, page_len - e) }
  }
  return { lo, hi }
}

// Cap a same-size resize's raw edge deltas so applying them (direct or mirrored, per window) via
// apply_edge_deltas keeps EVERY window's own drag-start rectangle on the page — growth simply
// stops at the tightest window's headroom instead of a partner needing to be repositioned/
// deformed afterward (bug #2). `mirror_cols`/`mirror_rows` are per-window, same indexing as
// `rects0` (the dragged window's own entry is always unmirrored: false, false).
export function clamp_edge_deltas(
  d: EdgeDeltas, rects0: readonly Box[],
  mirror_cols: readonly boolean[], mirror_rows: readonly boolean[],
  page_w: number, page_h: number,
): EdgeDeltas {
  const x = clamp_axis_deltas(d.dl, d.dr, rects0.map(r => r.x0), rects0.map(r => r.x1), mirror_cols, page_w)
  const y = clamp_axis_deltas(d.dt, d.db, rects0.map(r => r.y0), rects0.map(r => r.y1), mirror_rows, page_h)
  return { dl: x.lo, dt: y.lo, dr: x.hi, db: y.hi }
}

// Initial split rectangles as an even grid (spec §7.3, §9.6).
// Order: 1=top-left, 2=bottom-left, 3=top-right, 4=bottom-right (spec TODO §17).
export function split_rects_grid(n: 1 | 2 | 4, page_w: number, page_h: number): Box[] {
  if (n === 1) return [{ x0: 0, y0: 0, x1: page_w, y1: page_h }]
  if (n === 2) {
    const hw = page_w / 2
    return [
      { x0: 0,  y0: 0, x1: hw,     y1: page_h },
      { x0: hw, y0: 0, x1: page_w, y1: page_h },
    ]
  }
  const hw = page_w / 2, hh = page_h / 2
  return [
    { x0: 0,  y0: 0,  x1: hw,     y1: hh      }, // 1 TL
    { x0: 0,  y0: hh, x1: hw,     y1: page_h  }, // 2 BL
    { x0: hw, y0: 0,  x1: page_w, y1: hh      }, // 3 TR
    { x0: hw, y0: hh, x1: page_w, y1: page_h  }, // 4 BR
  ]
}

// Reindex a per-page map after page deletion.
// `deleted` is a sorted array of 0-based source indices that were removed.
export function reindex_map<V>(map: Map<number, V>, deleted: readonly number[]): Map<number, V> {
  const result = new Map<number, V>()
  for (const [k, v] of map) {
    const removed_before = deleted.filter(d => d < k).length
    if (!deleted.includes(k)) {
      result.set(k - removed_before, v)
    }
  }
  return result
}

export function box_width(b: Box): number { return b.x1 - b.x0 }
export function box_height(b: Box): number { return b.y1 - b.y0 }
export function box_area(b: Box): number { return box_width(b) * box_height(b) }
