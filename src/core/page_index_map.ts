// Logical page index -> original adapter page index. pdf.js has no page-deletion primitive that
// renumbers indices in place, so delete_pages() removes entries from this map instead of the
// document itself. Every adapter call that takes a page index must translate through it.
export class PageIndexMap {
  private _map: number[] = []

  reset(count: number): void {
    this._map = Array.from({ length: count }, (_, i) => i)
  }

  get length(): number { return this._map.length }

  // p is always a valid logical index here (bounded by length), so _map[p] is always defined;
  // the `?? p` fallback exists only to satisfy noUncheckedIndexedAccess.
  orig(p: number): number { return this._map[p] ?? p }

  remove(removed: ReadonlySet<number>): void {
    this._map = this._map.filter((_, i) => !removed.has(i))
  }
}
