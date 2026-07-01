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

  return clamp_box_drag({ x0, y0, x1, y1 }, page_w, page_h)
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

// Spec §8: aggregate detection boxes into the union frame.
// gL=min(x0), gT=min(y0), W=max(width), H=max(height) — NOT a standard bounding box.
export function detection_union(boxes: Box[]): Box {
  if (boxes.length === 0) throw new RangeError('detection_union: empty array')
  let gL = Infinity, gT = Infinity, maxW = 0, maxH = 0
  for (const b of boxes) {
    if (b.x0 < gL) gL = b.x0
    if (b.y0 < gT) gT = b.y0
    const w = b.x1 - b.x0, h = b.y1 - b.y0
    if (w > maxW) maxW = w
    if (h > maxH) maxH = h
  }
  return { x0: gL, y0: gT, x1: gL + maxW, y1: gT + maxH }
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
