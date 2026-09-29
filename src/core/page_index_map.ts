// Logical page index -> original adapter page index, mirrored from DocumentState.pages (the undoable
// page order). pdf.js has no page-deletion primitive that renumbers indices in place, so Delete
// edits this order instead of the document itself. Every adapter call that takes a page index must
// translate through it.
export class PageIndexMap {
  private _map: readonly number[] = []

  reset(count: number): void { this._map = Array.from({ length: count }, (_, i) => i) }

  set(pages: readonly number[]): void { this._map = pages }

  get pages(): readonly number[] { return this._map }

  get length(): number { return this._map.length }

  // p is always a valid logical index here (bounded by length), so _map[p] is always defined;
  // the `?? p` fallback exists only to satisfy noUncheckedIndexedAccess.
  orig(p: number): number { return this._map[p] ?? p }
}

// Moves a per-logical-page map from one page order to another through the original page indices;
// entries of pages absent from `next` are dropped (Delete), restored ones reappear only if present.
export function remap_pages<V>(map: ReadonlyMap<number, V>, prev: readonly number[], next: readonly number[]): Map<number, V> {
  const at = new Map(next.map((o, i) => [o, i]))
  const out = new Map<number, V>()
  for (const [p, v] of map) {
    const i = at.get(prev[p] ?? -1)
    if (i !== undefined) out.set(i, v)
  }
  return out
}

// The logical index of the page the viewer was on after the page order changes: the same original
// page if it survived, else the nearest remaining position.
export function follow_page(prev: readonly number[], next: readonly number[], current: number): number {
  const i = next.indexOf(prev[current] ?? -1)
  return i >= 0 ? i : Math.max(0, Math.min(current, next.length - 1))
}
