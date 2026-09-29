// PageIndexMap tests (§18 AppModel decomposition): logical page index -> original adapter
// page index, rebuilt by delete_pages() since pdf.js has no in-place page-deletion primitive.
import { describe, it, expect } from 'vitest'
import { PageIndexMap, remap_pages } from '@core/page_index_map'

describe('PageIndexMap', () => {
  it('reset(n) builds the identity map 0..n-1', () => {
    const m = new PageIndexMap()
    m.reset(3)
    expect(m.length).toBe(3)
    expect([0, 1, 2].map(p => m.orig(p))).toEqual([0, 1, 2])
  })

  it('set() adopts a page order (e.g. after Delete of logical pages 1 and 3)', () => {
    const m = new PageIndexMap()
    m.set([0, 2, 4])
    expect(m.length).toBe(3)
    expect([0, 1, 2].map(p => m.orig(p))).toEqual([0, 2, 4])
  })

  it('remap_pages moves a per-page map across a Delete and back (Undo)', () => {
    const full = [0, 1, 2, 3, 4], cut = [0, 2, 4]
    const before = new Map([[1, 'b'], [2, 'c'], [4, 'e']])
    const after = remap_pages(before, full, cut)
    expect([...after]).toEqual([[1, 'c'], [2, 'e']])
    expect([...remap_pages(after, cut, full)]).toEqual([[2, 'c'], [4, 'e']])
  })

  it('orig() falls back to p itself for an index outside the map', () => {
    const m = new PageIndexMap()
    expect(m.orig(0)).toBe(0)   // never reset — empty map, defensive fallback
  })
})
