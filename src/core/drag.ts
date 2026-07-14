// DragState tagged union — transient gesture state (ARCHITECTURE §5.4).
// Lives on AppModel, never snapshotted. Replaces the old _drag: dict antipattern.

import type { Box, HandleId } from './geometry'
import type { Offsets } from './document_state'

// Resizing or moving the live auto-crop rectangle. hit_handle() itself returns 'move' for any
// interior point (never null once a hit is confirmed), so handle is never actually null here.
export interface AutoDrag {
  readonly kind:      'auto'
  readonly handle:    HandleId
  readonly rect0:     Box                // rectangle at drag start
  readonly start:     readonly [number, number]
  readonly page_w:    number
  readonly page_h:    number
  readonly offsets0:  Offsets            // offsets at drag start (to restore on cancel)
  readonly left_base: number             // left_base at drag start (anchor-dependent)
  readonly top_base:  number
}

// Resizing or moving one split rectangle
export interface SplitDrag {
  readonly kind:   'split'
  readonly idx:    number                // which rect in crop_rects
  readonly handle: HandleId
  readonly rect0:  Box
  // ALL windows at drag start: same-size v2 applies mirrored edge deltas to each partner's own
  // drag-start rectangle, and cancel restores every window (§9.6; spec-web §W2 row 10).
  readonly rects0: readonly Box[]
  readonly start:  readonly [number, number]
  readonly page_w: number
  readonly page_h: number
}

// Rubber-banding a new crop rectangle on an empty/committed page. On a committed page it draws a
// new window over the cropped view (frozen spec §9.3) — the committed crop is not itself a drag
// target, so there is no separate "edit the committed box" gesture.
export interface DrawDrag {
  readonly kind:  'draw'
  readonly start: readonly [number, number]
  readonly page_w: number
  readonly page_h: number
}

// Moving or resizing the global hand-drawn window (document.drawn). Same as AutoDrag, hit_handle()
// returns 'move' for any interior point, so handle is never actually null here either.
export interface DrawnDrag {
  readonly kind:   'drawn'
  readonly handle: HandleId
  readonly rect0:  Box
  readonly start:  readonly [number, number]
  readonly page_w: number
  readonly page_h: number
}

export type DragState = AutoDrag | SplitDrag | DrawDrag | DrawnDrag
