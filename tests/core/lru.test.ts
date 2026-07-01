// LRUCache tests (spec §17). Ported from desktop tests/test_lru.py.
import { describe, it, expect, vi } from 'vitest'
import { LRUCache } from '@core/lru'

describe('LRUCache', () => {
  it('evicts the least-recently-used entry once past capacity', () => {
    const c = new LRUCache<number, string>(2)
    c.set(1, 'a'); c.set(2, 'b'); c.set(3, 'c')   // evicts 1
    expect(c.has(1)).toBe(false)
    expect(c.has(2)).toBe(true)
    expect(c.has(3)).toBe(true)
    expect(c.size).toBe(2)
  })

  it('get() refreshes recency, protecting the entry from eviction', () => {
    const c = new LRUCache<number, string>(2)
    c.set(1, 'a'); c.set(2, 'b')
    c.get(1)          // 1 is now most-recently-used
    c.set(3, 'c')      // should evict 2, not 1
    expect(c.has(1)).toBe(true)
    expect(c.has(2)).toBe(false)
    expect(c.has(3)).toBe(true)
  })

  it('re-set() on an existing key refreshes recency too', () => {
    const c = new LRUCache<number, string>(2)
    c.set(1, 'a'); c.set(2, 'b')
    c.set(1, 'a2')     // touches key 1
    c.set(3, 'c')      // should evict 2
    expect(c.has(1)).toBe(true)
    expect(c.has(2)).toBe(false)
  })

  it('calls onEvict with the evicted key/value', () => {
    const evicted: Array<[number, string]> = []
    const c = new LRUCache<number, string>(1, (k, v) => evicted.push([k, v]))
    c.set(1, 'a'); c.set(2, 'b')
    expect(evicted).toEqual([[1, 'a']])
  })

  it('delete() removes an entry and fires onEvict', () => {
    const onEvict = vi.fn()
    const c = new LRUCache<number, string>(5, onEvict)
    c.set(1, 'a')
    c.delete(1)
    expect(c.has(1)).toBe(false)
    expect(onEvict).toHaveBeenCalledWith(1, 'a')
  })

  it('clear() empties the cache and fires onEvict for every entry', () => {
    const evicted: number[] = []
    const c = new LRUCache<number, string>(5, k => evicted.push(k))
    c.set(1, 'a'); c.set(2, 'b')
    c.clear()
    expect(c.size).toBe(0)
    expect(evicted.sort()).toEqual([1, 2])
  })

  it('get() on a missing key returns undefined without side effects', () => {
    const c = new LRUCache<number, string>(2)
    expect(c.get(99)).toBeUndefined()
  })
})
