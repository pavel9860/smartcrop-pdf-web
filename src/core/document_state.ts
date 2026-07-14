// DocumentState — exactly the 8 undoable fields (spec §13/§W9.2, ARCHITECTURE §5.1).
// Nothing outside this list is snapshotted. (Previously 12 fields, mislabeled "11" here; drawn,
// detect_cache, union, auto_active moved to non-undoable AppModel state 2026-07 — spec-web §W9.2 —
// since they are detection/drag scaffolding used to arrive at a committed operation, not an
// operation themselves. See model.ts's _drawn/_detect_cache/_union/_auto_active.)

import type { Box } from './geometry'
import { FilterMode } from './enums'

export interface Offsets {
  readonly left:   number   // % of page width
  readonly top:    number   // % of page height
  readonly right:  number
  readonly bottom: number
}

export const DEFAULT_OFFSETS: Offsets = { left: 0, top: 0, right: 0, bottom: 0 }

export interface PageProcessIntent {
  readonly dewarp: boolean
  readonly filter: readonly [FilterMode, number] | null   // [mode, strength]
}

export interface DocumentState {
  applied:       Map<number, Box[]>               // committed crop(s) per source page
  crop_rects:    Box[]                             // live split rectangles (split=2/4)
  rotation:      Map<number, number>               // page → degrees CW (0/90/180/270)
  processed:     Map<number, PageProcessIntent>    // scan-processing intent per page
  offsets:       Offsets
  dewarp_on:     boolean
  filter_mode:   FilterMode
  filter_strength: number                          // 1 | 2 | 3
}

export function default_document_state(): DocumentState {
  return {
    applied:        new Map(),
    crop_rects:     [],
    rotation:       new Map(),
    processed:      new Map(),
    offsets:        DEFAULT_OFFSETS,
    dewarp_on:      false,
    filter_mode:    FilterMode.NONE,
    filter_strength: 1,
  }
}

// Deep-copy the per-page maps/lists; share frozen scalars.
// Box is replaced, never mutated in place, so shallow list copies are safe.
export function snapshot(state: DocumentState): DocumentState {
  return {
    applied:        new Map([...state.applied].map(([k, v]) => [k, [...v]])),
    crop_rects:     [...state.crop_rects],
    rotation:       new Map(state.rotation),
    processed:      new Map(state.processed),
    offsets:        state.offsets,        // immutable Offsets object
    dewarp_on:      state.dewarp_on,
    filter_mode:    state.filter_mode,
    filter_strength: state.filter_strength,
  }
}
