// LRU cache bounded to `capacity` entries.
// Evicted entries are passed to an optional onEvict callback (for ImageBitmap.close()).
// `onCapacityEvict`, if given, is called INSTEAD of onEvict for the one case that matters for a
// write-back cache: an entry pushed out because the cache is full (not an explicit delete/clear).
// This lets the work cache persist only genuinely-evicted rasters to disk (spec-web §W2 row 5),
// while delete()/clear() (intent change, reset) still just close without a wasted disk write.

export class LRUCache<K, V> {
  private readonly _map = new Map<K, V>()
  private readonly _capacity: number
  private readonly _onEvict: ((key: K, value: V) => void) | undefined
  private readonly _onCapacityEvict: ((key: K, value: V) => void) | undefined

  constructor(capacity: number, onEvict?: (key: K, value: V) => void,
              onCapacityEvict?: (key: K, value: V) => void) {
    this._capacity = capacity
    this._onEvict  = onEvict
    this._onCapacityEvict = onCapacityEvict
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
      const cb = this._onCapacityEvict ?? this._onEvict
      cb?.(k, v)
    }
  }
}
