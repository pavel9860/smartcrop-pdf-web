// Page-selection parsing tests (spec §11). Ported from desktop tests/test_parsing.py.
import { describe, it, expect } from 'vitest'
import { resolve_pages } from '@core/parsing'
import { PagesMode } from '@core/enums'

describe('resolve_pages: All / Odd / Even', () => {
  it('All returns every 0-based index', () => {
    expect(resolve_pages(PagesMode.ALL, 5, '')).toEqual([0, 1, 2, 3, 4])
  })
  it('Odd (1-indexed 1,3,5) -> 0-based 0,2,4', () => {
    expect(resolve_pages(PagesMode.ODD, 6, '')).toEqual([0, 2, 4])
  })
  it('Even (1-indexed 2,4,6) -> 0-based 1,3,5', () => {
    expect(resolve_pages(PagesMode.EVEN, 6, '')).toEqual([1, 3, 5])
  })
  it('empty document returns empty arrays', () => {
    expect(resolve_pages(PagesMode.ALL, 0, '')).toEqual([])
    expect(resolve_pages(PagesMode.ODD, 0, '')).toEqual([])
  })
})

describe('resolve_pages: Selected / pattern parsing', () => {
  const sel = (pattern: string, total = 20): number[] => resolve_pages(PagesMode.SELECT, total, pattern)

  it('single page numbers (1-indexed in, 0-indexed out)', () => {
    expect(sel('1,3,5')).toEqual([0, 2, 4])
  })
  it('inclusive a-b range', () => {
    expect(sel('2-5')).toEqual([1, 2, 3, 4])
  })
  it('colon slice start:stop (inclusive)', () => {
    expect(sel('1:4')).toEqual([0, 1, 2, 3])
  })
  it('colon slice with step: 1:100:5 == 1,6,11,...', () => {
    expect(sel('1:20:5')).toEqual([0, 5, 10, 15])
  })
  it('open-ended ::2 == every odd page', () => {
    expect(sel('::2', 10)).toEqual([0, 2, 4, 6, 8])
  })
  it('open-ended 10: == page 10 to the end', () => {
    expect(sel('10:', 12)).toEqual([9, 10, 11])
  })
  it('mixes ranges, slices, and singles freely', () => {
    expect(sel('1:4, 10:12, 15')).toEqual([0, 1, 2, 3, 9, 10, 11, 14])
  })
  it('out-of-range values are dropped, not errored', () => {
    expect(sel('1,999,3', 5)).toEqual([0, 2])
  })
  it('duplicates collapse', () => {
    expect(sel('1,1,2,1-2')).toEqual([0, 1])
  })
  it('whitespace around commas is tolerated', () => {
    expect(sel(' 1 , 3 , 5 ')).toEqual([0, 2, 4])
  })
  it('malformed tokens are ignored rather than throwing', () => {
    expect(() => sel('abc,1,')).not.toThrow()
    expect(sel('abc,1,')).toEqual([0])
  })
})
