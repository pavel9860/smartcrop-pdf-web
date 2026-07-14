// PageIndexMap tests (§18 AppModel decomposition): logical page index -> original adapter
// page index, rebuilt by delete_pages() since pdf.js has no in-place page-deletion primitive.
import { describe, it, expect } from 'vitest'
import { PageIndexMap } from '@core/page_index_map'

describe('PageIndexMap', () => {
  it('reset(n) builds the identity map 0..n-1', () => {
    const m = new PageIndexMap()
    m.reset(3)
    expect(m.length).toBe(3)
    expect([0, 1, 2].map(p => m.orig(p))).toEqual([0, 1, 2])
  })

  it('remove() drops the given logical indices and shifts the rest down', () => {
    const m = new PageIndexMap()
    m.reset(5)                 // orig indices 0,1,2,3,4
    m.remove(new Set([1, 3]))  // delete logical pages 1 and 3
    expect(m.length).toBe(3)
    expect([0, 1, 2].map(p => m.orig(p))).toEqual([0, 2, 4])
  })

  it('orig() falls back to p itself for an index outside the map', () => {
    const m = new PageIndexMap()
    expect(m.orig(0)).toBe(0)   // never reset — empty map, defensive fallback
  })
})
