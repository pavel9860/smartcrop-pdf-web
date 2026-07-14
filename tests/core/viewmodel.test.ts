// Output-page navigation math tests (spec §12.3). Ported from desktop tests/test_viewmodel.py.
import { describe, it, expect } from 'vitest'
import {
  output_page_count, view_to_source, source_to_first_view, source_to_view_range,
} from '@core/viewmodel'
import type { Box } from '@core/geometry'

const b: Box = { x0: 0, y0: 0, x1: 10, y1: 10 }

describe('output_page_count', () => {
  it('uncommitted pages count as 1 view each', () => {
    expect(output_page_count(5, new Map())).toBe(5)
  })
  it('a committed split page counts as N views', () => {
    const applied = new Map<number, Box[]>([[1, [b, b]]])   // page 1 split into 2
    expect(output_page_count(3, applied)).toBe(1 + 2 + 1)
  })
  it('mixed document: some split, some not', () => {
    const applied = new Map<number, Box[]>([[0, [b, b, b, b]], [2, [b, b]]])
    expect(output_page_count(4, applied)).toBe(4 + 1 + 2 + 1)
  })
})

describe('view_to_source', () => {
  it('flat index round-trips through an all-uncommitted document', () => {
    for (let v = 1; v <= 5; v++) {
      expect(view_to_source(v, 5, new Map())).toEqual({ src_page: v - 1, split_idx: 0 })
    }
  })
  it('walks every split window of a committed page before the next source page', () => {
    const applied = new Map<number, Box[]>([[1, [b, b, b]]])   // page 1 -> 3 output pages
    // page0(view1) page1win1(view2) page1win2(view3) page1win3(view4) page2(view5)
    expect(view_to_source(1, 3, applied)).toEqual({ src_page: 0, split_idx: 0 })
    expect(view_to_source(2, 3, applied)).toEqual({ src_page: 1, split_idx: 0 })
    expect(view_to_source(3, 3, applied)).toEqual({ src_page: 1, split_idx: 1 })
    expect(view_to_source(4, 3, applied)).toEqual({ src_page: 1, split_idx: 2 })
    expect(view_to_source(5, 3, applied)).toEqual({ src_page: 2, split_idx: 0 })
  })
  it('clamps a stale/out-of-range view position to the last page', () => {
    expect(view_to_source(999, 3, new Map())).toEqual({ src_page: 2, split_idx: 0 })
  })
  it('throws RangeError for a zero/negative source_count (no document loaded)', () => {
    expect(() => view_to_source(1, 0, new Map())).toThrow(RangeError)
  })
})

describe('source_to_first_view / source_to_view_range', () => {
  it('first view of page 0 is always 1', () => {
    expect(source_to_first_view(0, new Map())).toBe(1)
  })
  it('accounts for split pages before the target page', () => {
    const applied = new Map<number, Box[]>([[0, [b, b]]])   // page 0 -> 2 views
    expect(source_to_first_view(1, applied)).toBe(3)
  })
  it('view range lists every window for a split page', () => {
    const applied = new Map<number, Box[]>([[1, [b, b, b]]])
    expect(source_to_view_range(1, applied)).toEqual([2, 3, 4])
  })
  it('view range for an uncommitted page is a single index', () => {
    expect(source_to_view_range(2, new Map())).toEqual([3])
  })
})
