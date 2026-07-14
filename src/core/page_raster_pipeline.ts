// PageRasterPipeline (§18 AppModel decomposition, step 2/7) — owns the three raster caches
// (source / work / output), the disk-tier bookkeeping, and the currently-displayed bitmap.
// Every consumer that needs pixels — the NORMAL view, the SCANNED work pipeline, and Auto-detect
// — funnels through get_source/get_work, so a page is rasterized exactly once per (page,
// rotation) (spec-web §7).
import type { Box } from './geometry'
import type { PageProcessIntent } from './document_state'
import type { RendererAdapter, PageSize } from './model'
import type { PageIndexMap } from './page_index_map'
import { Mode } from './enums'
import { LRUCache } from './lru'
import { CACHE_WINDOW, SRC_DPI, SYNTH_W, SYNTH_H, MAX_SPLIT } from './constants'

// Live reads into AppModel state that the pipeline itself doesn't own (mode/display DPI/rotation
// are UI- and DocumentState-driven; process_intent is derived from DocumentState's scan flags).
// Function members (not properties) so every read is live, never a stale snapshot.
export interface RasterContext {
  mode(): Mode
  display_dpi(): number
  is_synthetic(): boolean
  rotation(p: number): number
  process_intent(p: number): PageProcessIntent
  dewarp_supersample(): number
}

export class PageRasterPipeline {
  // Eviction closes the bitmap to free memory eagerly — EXCEPT the one currently on screen
  // (_current): closing a displayed/in-flight bitmap detaches it and the next drawImage throws
  // InvalidStateError ("image source is detached"). This hit hardest during Auto-detect on long
  // books, which walks every page through get_work and would otherwise evict+close the live page
  // (bug: site dead).
  private _source_cache = new LRUCache<number, ImageBitmap>(CACHE_WINDOW,
    (_, b) => { if (b !== this._current) b.close() })

  // Processed-raster RAM tier. WRITE-BACK to the disk tier: a raster is persisted to IndexedDB
  // only when the RAM cache is full and it is genuinely evicted (onCapacityEvict) — NOT eagerly on
  // every compute. Eager persist made a warm pass fire N concurrent PNG-encode+IDB-write jobs that
  // piled up (hundreds of ms each) and contended with the next page's OpenCV work; for a document
  // that fits in RAM (≤ CACHE_WINDOW pages) the disk tier is never even read, so that work was
  // pure overhead. Delete/clear (intent change, reset) close without a disk write.
  // `_work_disk_keys` carries each cached page's disk key (the intent it was computed under) so
  // eviction persists it under the right key even if the current intent has since changed.
  private _work_disk_keys = new Map<number, string>()
  // Keys actually written to the disk tier (on capacity eviction). get_work only reads disk for a
  // key in this set — so a document that fits in RAM does ZERO disk reads and never touches
  // IndexedDB on the hot path (a stray read would serialize behind the load-time clear transaction
  // for ~300 ms; this set makes that read never happen). In-memory, cleared on load/reset.
  private _persisted_keys = new Set<string>()
  private _work_cache = new LRUCache<number, ImageBitmap>(CACHE_WINDOW,
    (p, b) => { this._work_disk_keys.delete(p); if (b !== this._current) b.close() },
    (p, b) => {
      const key = this._work_disk_keys.get(p)
      // persist_work snapshots pixels synchronously (drawImage before any await), so closing
      // right after is safe; a capacity eviction only happens deep into processing, long after
      // any load-time clear. Record the key so get_work knows this raster is retrievable from disk.
      if (key && this._adapter.persist_work) { void this._adapter.persist_work(key, b); this._persisted_keys.add(key) }
      this._work_disk_keys.delete(p)
      if (b !== this._current) b.close()
    })

  // Pre-rendered output bitmaps for committed pages (keyed "page:split_idx")
  private _output_cache = new LRUCache<string, ImageBitmap>(CACHE_WINDOW * 2,
    (_, b) => { if (b !== this._current) b.close() })

  // Currently displayed bitmap (synchronously available for view_snapshot)
  private _current: ImageBitmap | null = null
  private _loading = false
  private readonly _prefetching = new Set<number>()

  // Monotonic document generation, bumped on every load/reset and baked into each disk-cache key.
  // This namespaces a document's processed rasters so a disk read can never return a PREVIOUS
  // document's raster (key collision), which means reads/persists do NOT have to wait for the
  // load-time IndexedDB clear to finish — that wait added ~300 ms to the first pages of a scan
  // pass. The clear still runs (fire-and-forget) to bound storage; correctness no longer depends
  // on it.
  private _doc_gen = 0

  constructor(
    private readonly _adapter: RendererAdapter,
    private readonly _page_index: PageIndexMap,
    private readonly _ctx: RasterContext,
  ) {}

  get current(): ImageBitmap | null { return this._current }
  get is_loading(): boolean { return this._loading }
  set is_loading(v: boolean) { this._loading = v }

  output_at(p: number, split_idx: number): ImageBitmap | null {
    return this._output_cache.get(`${p}:${split_idx}`) ?? null
  }

  // Full reset on document load/reopen: new generation, drop everything (RAM + best-effort disk).
  reset(): void {
    this._source_cache.clear()
    this._work_cache.clear()
    this._work_disk_keys.clear()
    this._persisted_keys.clear()
    this._output_cache.clear()
    // New generation → new disk-key namespace. Drop the old generation's rasters from disk to
    // bound storage, but fire-and-forget: correctness no longer waits on it.
    this._doc_gen += 1
    void this._adapter.clear_work_cache?.()
    this._current = null
  }

  // Undo/redo: any undoable field could have changed underneath (rotation, crop, filter, dewarp),
  // so drop every RAM raster — but disk bookkeeping (_doc_gen, persisted keys) stays valid, since
  // disk keys are content-addressed by intent/rotation, not doc-generation-invalidated.
  clear_ram(): void {
    this._source_cache.clear()
    this._work_cache.clear()
    this._output_cache.clear()
    this._current = null
  }

  clear_source(): void { this._source_cache.clear() }

  delete_page(p: number): void {
    this._source_cache.delete(p)
    this._work_cache.delete(p)
    this.invalidate_output(p)
  }

  drop_work(p: number): void { this._work_cache.delete(p) }

  invalidate_output(p: number): void {
    for (let i = 0; i < MAX_SPLIT; i++) this._output_cache.delete(`${p}:${i}`)
  }

  invalidate_current(): void { this._current = null }

  // Raw page raster (before scan processing), rendered once per page and cached.
  async get_source(p: number): Promise<ImageBitmap> {
    const cached = this._source_cache.get(p)
    if (cached) return cached
    const dpi = this._ctx.mode() === Mode.SCANNED ? SRC_DPI : this._ctx.display_dpi()
    const rotation = this._ctx.rotation(p)
    // p is logical (post-delete); the adapter only knows original pdf.js page indices.
    const orig = this._page_index.orig(p)
    const b = !this._ctx.is_synthetic()
      ? await this._adapter.get_source_image(orig, dpi, rotation)
      : await this._adapter.make_synth_page(orig, SYNTH_W, SYNTH_H)
    this._source_cache.set(p, b)
    return b
  }

  async get_work(p: number): Promise<ImageBitmap> {
    const cached = this._work_cache.get(p)
    if (cached) return cached

    const src = await this.get_source(p)
    if (this._ctx.mode() !== Mode.SCANNED) {
      // NORMAL: the work raster IS the source raster. Do NOT also store it in _work_cache — the
      // same bitmap in two close-on-evict caches gets double-closed, detaching a bitmap the other
      // cache still serves (root of the "image source is detached" crash). It stays in _source_cache.
      return src
    }

    // A no-op intent (no dewarp, no filter) has no work raster distinct from the source — return
    // src directly rather than caching a duplicate (same double-close hazard as NORMAL).
    const intent = this._ctx.process_intent(p)
    if (!intent.dewarp && !intent.filter) return src

    const key = this._work_disk_key(p, intent)
    // Only hit the disk tier for a key we actually persisted (see _persisted_keys) — a page that
    // never left RAM was never written, so skip the IndexedDB round-trip (and its clear-serialized
    // stall) entirely.
    const disk = this._persisted_keys.has(key) ? await this._load_work_from_disk(key) : null
    if (disk) { this._cache_work(p, key, disk); return disk }

    const work = await this._adapter.get_work_image(src, intent, this._ctx.dewarp_supersample())
    // Write-back cache: don't persist here — the disk write happens only if/when this raster is
    // evicted from RAM (see _work_cache's onCapacityEvict). Small documents never evict, so they
    // never pay for a disk write they'd never read back.
    this._cache_work(p, key, work)
    return work
  }

  // Fetches the page's work raster AND marks it as the on-screen bitmap in one step, so the
  // close-on-evict guards above (`b !== this._current`) never race a fetch that's about to
  // become the displayed page.
  async load_current(p: number): Promise<ImageBitmap> {
    const work = await this.get_work(p)
    this._current = work
    return work
  }

  private _cache_work(p: number, key: string, work: ImageBitmap): void {
    this._work_disk_keys.set(p, key)
    this._work_cache.set(p, work)
  }

  // Two-tier work cache — disk (IndexedDB) tier. Key = document generation + original page index +
  // full intent (dewarp, filter mode/strength), rotation and supersample: any change yields a
  // different key, so a settings change never returns a stale raster (it re-processes into a new
  // key instead) and a new document (new _doc_gen) never collides with a prior one's rasters.
  private _work_disk_key(p: number, intent: PageProcessIntent): string {
    const orig = this._page_index.orig(p)
    const filt = intent.filter ? `${intent.filter[0]}-${intent.filter[1]}` : 'none'
    const rot = this._ctx.rotation(p)
    return `g${this._doc_gen}|${orig}|d${intent.dewarp ? 1 : 0}|f${filt}|r${rot}|s${this._ctx.dewarp_supersample()}`
  }

  private _load_work_from_disk(key: string): Promise<ImageBitmap | null> {
    // No wait on the load-time clear: _doc_gen namespaces the key, so there is no cross-document
    // collision to guard against, and the read just misses (fast) for a never-persisted page.
    return this._adapter.load_work?.(key) ?? Promise.resolve(null)
  }

  // Background-warms an adjacent page so next/prev is a cache hit instead of a blank "Loading…"
  // flash while the (potentially heavy, scanned-mode) work raster renders on demand.
  prefetch(p: number): void {
    if (p < 0 || p >= this._page_index.length || this._prefetching.has(p)) return
    const warm = this._ctx.mode() === Mode.SCANNED ? this._work_cache.has(p) : this._source_cache.has(p)
    if (warm) return
    this._prefetching.add(p)
    void this.get_work(p).catch(() => { /* best-effort warm */ })
      .finally(() => { this._prefetching.delete(p) })
  }

  // Pre-render every split view's output bitmap for a committed page (so jumping between split
  // views via view_snapshot() never blocks on a render call). Preview must NOT bake in output
  // quality: compress DPI + grayscale are EXPORT-only (spec-web §W2 row 8) — render_output_image
  // is still the single path, only the DPI/colour args differ.
  async prerender_output_views(
    p: number, committed: readonly Box[], sz: PageSize, work: ImageBitmap,
  ): Promise<void> {
    for (let i = 0; i < committed.length; i++) {
      const key = `${p}:${i}`
      if (this._output_cache.has(key)) continue
      const box = committed[i]
      if (!box) continue
      const out = await this._adapter.render_output_image(work, box, sz.width, sz.height, null, false)
      this._output_cache.set(key, out)
    }
  }
}
