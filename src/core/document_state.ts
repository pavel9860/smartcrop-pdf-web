// DocumentState — exactly the 11 undoable fields (spec §13, ARCHITECTURE §5.1).
// Nothing outside this list is snapshotted.

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
  detect_cache:  Map<number, Box>                  // per-page content box from last detect
  union:         Box | null                        // aggregate detection union (§8)
  auto_active:   boolean                           // auto-detect was run at least once
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
    detect_cache:   new Map(),
    union:          null,
    auto_active:    false,
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
    detect_cache:   new Map(state.detect_cache),
    union:          state.union,          // immutable, safe to share
    auto_active:    state.auto_active,
    offsets:        state.offsets,        // immutable Offsets object
    dewarp_on:      state.dewarp_on,
    filter_mode:    state.filter_mode,
    filter_strength: state.filter_strength,
  }
}
