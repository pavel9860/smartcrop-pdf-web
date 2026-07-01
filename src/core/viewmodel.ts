// Output-page navigation math (spec §12.3).
// Committed splits expand each source page into N output views.
// Everything here is pure math — no model state, no imports beyond types.

import type { Box } from './geometry'

// Total output pages given how many source pages are committed as splits.
// Uncommitted source pages count as 1 view each.
export function output_page_count(
  source_count: number,
  applied: Map<number, Box[]>,
): number {
  let total = 0
  for (let i = 0; i < source_count; i++) {
    total += applied.get(i)?.length ?? 1
  }
  return total
}

// Convert a 1-based output-view index to {source_page: 0-based, split_idx: 0-based}.
export function view_to_source(
  view_pos: number,          // 1-based
  source_count: number,
  applied: Map<number, Box[]>,
): { src_page: number; split_idx: number } {
  let remaining = view_pos
  for (let i = 0; i < source_count; i++) {
    const n = applied.get(i)?.length ?? 1
    if (remaining <= n) return { src_page: i, split_idx: remaining - 1 }
    remaining -= n
  }
  // Clamp to last page if out of range
  return { src_page: source_count - 1, split_idx: 0 }
}

// First 1-based output-view index that corresponds to source_page (useful after navigation).
export function source_to_first_view(
  src_page: number,
  applied: Map<number, Box[]>,
): number {
  let pos = 1
  for (let i = 0; i < src_page; i++) {
    pos += applied.get(i)?.length ?? 1
  }
  return pos
}

// All 1-based view indices for a given source page.
export function source_to_view_range(
  src_page: number,
  applied: Map<number, Box[]>,
): readonly number[] {
  const first = source_to_first_view(src_page, applied)
  const n = applied.get(src_page)?.length ?? 1
  return Array.from({ length: n }, (_, k) => first + k)
}
