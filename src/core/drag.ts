// DragState tagged union — transient gesture state (ARCHITECTURE §5.4).
// Lives on AppModel, never snapshotted. Replaces the old _drag: dict antipattern.

import type { Box, HandleId } from './geometry'
import type { Offsets } from './document_state'

// Resizing or moving the live auto-crop rectangle
export interface AutoDrag {
  readonly kind:      'auto'
  readonly handle:    HandleId | null    // null = draw new (only DrawDrag uses null now)
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
  readonly start:  readonly [number, number]
  readonly page_w: number
  readonly page_h: number
}

// Rubber-banding a new crop rectangle on an empty/committed page
export interface DrawDrag {
  readonly kind:  'draw'
  readonly start: readonly [number, number]
  readonly page_w: number
  readonly page_h: number
}

// Editing a committed single-crop (drag from committed-page handle)
export interface CropEditDrag {
  readonly kind:   'crop_edit'
  readonly handle: HandleId
  readonly rect0:  Box
  readonly start:  readonly [number, number]
  readonly page_w: number
  readonly page_h: number
}

export type DragState = AutoDrag | SplitDrag | DrawDrag | CropEditDrag
