// LRU cache bounded to `capacity` entries.
// Evicted entries (by capacity, delete(), or clear()) are passed to an optional onEvict callback
// (for ImageBitmap.close()) — one callback for every eviction reason, no distinct capacity-only
// variant. (An earlier revision had a second onCapacityEvict callback for a disk write-back tier;
// removed with that tier — every raster cache is RAM-only now, spec-web §7.)

export class LRUCache<K, V> {
  private readonly _map = new Map<K, V>()
  private readonly _capacity: number
  private readonly _onEvict: ((key: K, value: V) => void) | undefined

  constructor(capacity: number, onEvict?: (key: K, value: V) => void) {
    this._capacity = capacity
    this._onEvict  = onEvict
  }

  get(key: K): V | undefined {
    const value = this._map.get(key)
    if (value === undefined) return undefined
    // Re-insert to mark as most-recently-used
    this._map.delete(key)
    this._map.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    if (this._map.has(key)) this._map.delete(key)
    this._map.set(key, value)
    if (this._map.size > this._capacity) this._evict_lru()
  }

  delete(key: K): void {
    const value = this._map.get(key)
    if (value !== undefined) {
      this._map.delete(key)
      this._onEvict?.(key, value)
    }
  }

  has(key: K): boolean { return this._map.has(key) }

  clear(): void {
    if (this._onEvict) {
      for (const [k, v] of this._map) this._onEvict(k, v)
    }
    this._map.clear()
  }

  get size(): number { return this._map.size }

  private _evict_lru(): void {
    const first = this._map.entries().next()
    if (!first.done) {
      const [k, v] = first.value
      this._map.delete(k)
      this._onEvict?.(k, v)
    }
  }
}
