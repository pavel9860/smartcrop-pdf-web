// PageRasterPipeline (§18 AppModel decomposition, step 2/7) — owns the RAM-only raster caches
// (source / work / output) and the currently-displayed bitmap. Every consumer that needs pixels —
// the NORMAL view, the SCANNED work pipeline, and Auto-detect — funnels through get_source/
// get_work, so a page is rasterized exactly once per distinct (page, rotation[, dewarp, filter,
// strength]) combination (spec-web §7). Navigating between pages never evicts anything: each
// page owns its own small version history, so walking through a 50-page document is exactly as
// fast as viewing 1 (spec-web §16) — there is no shared page-count window to exhaust.
import type { Box } from './geometry'
import type { PageProcessIntent } from './document_state'
import type { RendererAdapter, PageSize } from './model'
import type { PageIndexMap } from './page_index_map'
import { Mode } from './enums'
import { LRUCache } from './lru'
import { SRC_DPI, SYNTH_W, SYNTH_H, MAX_SPLIT } from './constants'

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
  // The undo/redo depth setting (spec-web §12) — the ONE number that bounds how many past
  // processing combinations per page are worth keeping a bitmap for; there is no separate cache
  // capacity to keep in sync with it.
  undo_depth(): number
}

export class PageRasterPipeline {
  // One small LRU per page and step (capacity = undo depth + 1, so Undo/Redo re-hit what they can
  // still reach), never one shared cache: paging through a long document must not evict other pages.
  // Entries are content-addressed (rotation, dewarp, filter, strength, supersample in the key), so a
  // changed setting resolves to a new entry instead of needing invalidation. Eviction closes the
  // bitmap — except the one on screen (_current), which drawImage would otherwise find detached.
  private _source_versions   = new Map<number, LRUCache<string, ImageBitmap>>()   // raw page, per rotation
  private _dewarp_canonical  = new Map<number, LRUCache<string, ImageBitmap>>()   // ONNX result, rotation 0
  private _dewarped_versions = new Map<number, LRUCache<string, ImageBitmap>>()   // it, rotated 90/180/270
  private _work_versions     = new Map<number, LRUCache<string, ImageBitmap>>()   // filtered result

  // Cropped/split preview bitmaps per committed page ("orig:split_idx"); invalidated explicitly
  // wherever a crop changes (invalidate_output / clear_output).
  private _output_cache = new LRUCache<string, ImageBitmap>(Infinity,
    (_, b) => { if (b !== this._current) b.close() })

  // Currently displayed bitmap (synchronously available for view_snapshot)
  private _current: ImageBitmap | null = null
  private _loading = false

  // In-flight computes by the same key as the cache: the view refresh, prefetch and a scan batch
  // often ask for one page at once, and must share one (possibly multi-second) compute.
  private readonly _inflight = new Map<string, Promise<ImageBitmap>>()

  constructor(
    private readonly _adapter: RendererAdapter,
    private readonly _page_index: PageIndexMap,
    private readonly _ctx: RasterContext,
  ) {}

  get current(): ImageBitmap | null { return this._current }
  set current(bitmap: ImageBitmap | null) { this._current = bitmap }
  get is_loading(): boolean { return this._loading }
  set is_loading(v: boolean) { this._loading = v }

  output_at(p: number, split_idx: number): ImageBitmap | null {
    return this._output_cache.get(`${this._page_index.orig(p)}:${split_idx}`) ?? null
  }

  // Undo/redo (spec-web §12): drop only the cheap crop/split output preview. The source/work
  // per-page version histories are content-addressed and bounded by undo_depth — whatever state
  // DocumentState reverted to simply resolves to its own entry (a hit if still within reach, one
  // clean recompute otherwise) — so they are deliberately left alone.
  clear_output(): void { this._output_cache.clear() }

  // Document load/reopen: drop everything. In-flight jobs go too — one started before the reset
  // still resolves for its own caller, but is never joined afterwards.
  reset(): void {
    this._inflight.clear()
    this._clear_versions(this._source_versions)
    this._clear_versions(this._work_versions)
    this._clear_versions(this._dewarp_canonical)
    this._clear_versions(this._dewarped_versions)
    this._output_cache.clear()
    this._current = null
  }

  clear_source(): void {
    this._inflight.clear()
    this._clear_versions(this._source_versions)
  }

  private _clear_versions(map: Map<number, LRUCache<string, ImageBitmap>>): void {
    for (const cache of map.values()) cache.clear()
    map.clear()
  }

  invalidate_output(p: number): void {
    const o = this._page_index.orig(p)
    for (let i = 0; i < MAX_SPLIT; i++) this._output_cache.delete(`${o}:${i}`)
  }

  invalidate_current(): void { this._current = null }

  // Every cache and in-flight job is keyed by the ORIGINAL page index: the public entry points
  // translate the logical page once, up front, so a Delete or its Undo landing mid-await can never
  // re-point a result at a different page.
  private _version_cache(map: Map<number, LRUCache<string, ImageBitmap>>, o: number): LRUCache<string, ImageBitmap> {
    let cache = map.get(o)
    if (!cache) {
      cache = new LRUCache<string, ImageBitmap>(this._ctx.undo_depth() + 1,
        (_, b) => { if (b !== this._current) b.close() })
      map.set(o, cache)
    }
    return cache
  }

  // Cached-or-computed raster: one entry per (original page, key), one compute in flight at a time.
  // Keys carry a per-step prefix (s/c/r/d), so they are unique across the four maps.
  private _cached(
    map: Map<number, LRUCache<string, ImageBitmap>>, o: number, key: string, compute: () => Promise<ImageBitmap>,
  ): Promise<ImageBitmap> {
    const cache = this._version_cache(map, o)
    const hit = cache.get(key)
    if (hit) return Promise.resolve(hit)
    const id = `${o}|${key}`
    const pending = this._inflight.get(id)
    if (pending) return pending
    const promise = compute().then(b => { cache.set(key, b); return b }).finally(() => {
      if (this._inflight.get(id) === promise) this._inflight.delete(id)
    })
    this._inflight.set(id, promise)
    return promise
  }

  // Raw page raster (before scan processing), rendered once per (page, rotation) and cached.
  get_source(p: number): Promise<ImageBitmap> {
    return this._source(this._page_index.orig(p), this._ctx.rotation(p))
  }

  private _source(o: number, rotation: number): Promise<ImageBitmap> {
    return this._cached(this._source_versions, o, `s${rotation}`, () => {
      const dpi = this._ctx.mode() === Mode.SCANNED ? SRC_DPI : this._ctx.display_dpi()
      return !this._ctx.is_synthetic()
        ? this._adapter.get_source_image(o, dpi, rotation)
        : this._adapter.make_synth_page(o, SYNTH_W, SYNTH_H)
    })
  }

  // The page as shown: source, then (SCANNED) Dewarp&Deskew, then the filter — each step cached on
  // its own, so a filter change reuses the dewarped raster and a rotate never re-runs the dewarp.
  async get_work(p: number): Promise<ImageBitmap> {
    const o = this._page_index.orig(p)
    const rotation = this._ctx.rotation(p)
    const intent = this._ctx.process_intent(p)
    if (this._ctx.mode() !== Mode.SCANNED || (!intent.dewarp && !intent.filter)) return this._source(o, rotation)
    const ss = this._ctx.dewarp_supersample()
    const filter = intent.filter
    const base = intent.dewarp ? await this._dewarped(o, rotation, ss) : await this._source(o, rotation)
    if (!filter) return base
    const key = `d${intent.dewarp ? 1 : 0}|f${filter[0]}-${filter[1]}|r${rotation}|s${ss}`
    return this._cached(this._work_versions, o, key,
      () => this._adapter.get_work_image(base, { dewarp: false, filter }, ss))
  }

  // Dewarp&Deskew at the page's rotation: the ONNX pass runs once per (page, supersample) on the
  // unrotated source; other rotations are a cheap bitmap rotation of that result (spec-web §7).
  private async _dewarped(o: number, rotation: number, ss: number): Promise<ImageBitmap> {
    const canonical = await this._cached(this._dewarp_canonical, o, `c${ss}`, async () =>
      this._adapter.get_work_image(await this._source(o, 0), { dewarp: true, filter: null }, ss))
    if (rotation === 0) return canonical
    return this._cached(this._dewarped_versions, o, `r${rotation}|s${ss}`,
      () => this._adapter.rotate_bitmap(canonical, rotation))
  }

  // Fetches the page's work raster AND marks it as the on-screen bitmap in one step, so the
  // close-on-evict guards above (`b !== this._current`) never race a fetch that's about to
  // become the displayed page.
  async load_current(p: number): Promise<ImageBitmap> {
    const work = await this.get_work(p)
    this._current = work
    return work
  }

  // Background-warms an adjacent page so next/prev is a cache hit instead of a blank "Loading…"
  // flash while the (potentially heavy, scanned-mode) work raster renders on demand.
  prefetch(p: number): void {
    if (p < 0 || p >= this._page_index.length) return
    void this.get_work(p).catch(() => { /* best-effort warm */ })
  }

  // Pre-render every split view's output bitmap for a committed page (so jumping between split
  // views via view_snapshot() never blocks on a render call). Preview must NOT bake in output
  // quality: compress DPI + grayscale are EXPORT-only (spec-web §W2 row 8) — render_output_image
  // is still the single path, only the DPI/colour args differ.
  async prerender_output_views(
    p: number, committed: readonly Box[], sz: PageSize, work: ImageBitmap,
  ): Promise<void> {
    for (let i = 0; i < committed.length; i++) {
      const key = `${this._page_index.orig(p)}:${i}`
      if (this._output_cache.has(key)) continue
      const box = committed[i]
      if (!box) continue
      const out = await this._adapter.render_output_image(work, box, sz.width, sz.height, null, false)
      this._output_cache.set(key, out)
    }
  }
}
