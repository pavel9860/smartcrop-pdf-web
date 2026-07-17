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
  // Per-page version history: each page gets its OWN small LRU (capacity = undo_depth + 1 — the
  // current combination plus as many prior ones as Undo can still reach), created lazily on first
  // use. This is deliberately NOT one shared cache across pages — a shared capacity would evict
  // OTHER pages' bitmaps just from paging through a long document, forcing a recompute on return
  // that undoes the point of eager processing. Keyed by rotation (source) / the full processing
  // intent (work) — content-addressed, so Undo/Redo re-hit an already-computed bitmap when it is
  // still within reach instead of recomputing, and never serve stale content for a different
  // combination. Eviction closes the bitmap to free memory — EXCEPT the one currently on screen
  // (_current): closing a displayed/in-flight bitmap detaches it and the next drawImage throws
  // InvalidStateError ("image source is detached").
  private _source_versions = new Map<number, LRUCache<string, ImageBitmap>>()
  private _work_versions   = new Map<number, LRUCache<string, ImageBitmap>>()

  // Pre-rendered output bitmaps for committed pages (keyed "page:split_idx"). Cheap to rebuild from
  // the (separately cached) work bitmap — a crop/split is processing in the same sense as
  // dewarp/filter (the cached entry is the actual cropped pixels, never a full page + remembered
  // rectangle) — but unlike source/work it is not content-addressed or version-bounded: it is
  // small (≤ MAX_SPLIT entries per page) and invalidate_output(p)/clear_output() are called at
  // every site that can change what it should show (spec-web §7), so nothing here ever goes stale.
  private _output_cache = new LRUCache<string, ImageBitmap>(Infinity,
    (_, b) => { if (b !== this._current) b.close() })

  // Currently displayed bitmap (synchronously available for view_snapshot)
  private _current: ImageBitmap | null = null
  private _loading = false
  private readonly _prefetching = new Set<number>()

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
    return this._output_cache.get(`${p}:${split_idx}`) ?? null
  }

  // Full reset on document load/reopen: drop everything.
  reset(): void {
    this._clear_versions(this._source_versions)
    this._clear_versions(this._work_versions)
    this._output_cache.clear()
    this._current = null
  }

  // Undo/redo (spec-web §12): drop only the cheap crop/split output preview. The source/work
  // per-page version histories are content-addressed and bounded by undo_depth — whatever state
  // DocumentState reverted to simply resolves to its own entry (a hit if still within reach, one
  // clean recompute otherwise) — so they are deliberately left alone.
  clear_output(): void { this._output_cache.clear() }

  // Delete (spec-web §12): every cache is keyed by LOGICAL page number, and delete shifts every
  // subsequent page's logical index — every entry's association is now wrong, not just stale, so
  // (unlike Undo/Redo) a wholesale wipe is the correct behavior here, not a shortcut.
  clear_ram(): void {
    this._clear_versions(this._source_versions)
    this._clear_versions(this._work_versions)
    this._output_cache.clear()
    this._current = null
  }

  clear_source(): void { this._clear_versions(this._source_versions) }

  private _clear_versions(map: Map<number, LRUCache<string, ImageBitmap>>): void {
    for (const cache of map.values()) cache.clear()
    map.clear()
  }

  invalidate_output(p: number): void {
    for (let i = 0; i < MAX_SPLIT; i++) this._output_cache.delete(`${p}:${i}`)
  }

  invalidate_current(): void { this._current = null }

  private _version_cache(
    map: Map<number, LRUCache<string, ImageBitmap>>, p: number,
  ): LRUCache<string, ImageBitmap> {
    let cache = map.get(p)
    if (!cache) {
      cache = new LRUCache<string, ImageBitmap>(this._ctx.undo_depth() + 1,
        (_, b) => { if (b !== this._current) b.close() })
      map.set(p, cache)
    }
    return cache
  }

  // Raw page raster (before scan processing), rendered once per (page, rotation) and cached.
  async get_source(p: number): Promise<ImageBitmap> {
    const rotation = this._ctx.rotation(p)
    const cache = this._version_cache(this._source_versions, p)
    const key = String(rotation)
    const cached = cache.get(key)
    if (cached) return cached
    const dpi = this._ctx.mode() === Mode.SCANNED ? SRC_DPI : this._ctx.display_dpi()
    // p is logical (post-delete); the adapter only knows original pdf.js page indices.
    const orig = this._page_index.orig(p)
    const b = !this._ctx.is_synthetic()
      ? await this._adapter.get_source_image(orig, dpi, rotation)
      : await this._adapter.make_synth_page(orig, SYNTH_W, SYNTH_H)
    cache.set(key, b)
    return b
  }

  async get_work(p: number): Promise<ImageBitmap> {
    if (this._ctx.mode() !== Mode.SCANNED) {
      // NORMAL: the work raster IS the source raster. Do NOT also store it in the work cache — the
      // same bitmap in two close-on-evict caches gets double-closed, detaching a bitmap the other
      // cache still serves (root of the "image source is detached" crash). It stays in the source cache.
      return this.get_source(p)
    }

    // A no-op intent (no dewarp, no filter) has no work raster distinct from the source — return
    // src directly rather than caching a duplicate (same double-close hazard as NORMAL).
    const intent = this._ctx.process_intent(p)
    if (!intent.dewarp && !intent.filter) return this.get_source(p)

    const cache = this._version_cache(this._work_versions, p)
    const key = this._work_key(intent, this._ctx.rotation(p))
    const cached = cache.get(key)
    if (cached) return cached

    const src = await this.get_source(p)
    const work = await this._adapter.get_work_image(src, intent, this._ctx.dewarp_supersample())
    cache.set(key, work)
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

  // Version key within a page's own cache = full intent (dewarp, filter mode/strength) + rotation +
  // supersample: any change yields a different key, so a settings/rotation change never returns a
  // stale raster (it re-processes into a new key instead) rather than needing an explicit
  // invalidation call.
  private _work_key(intent: PageProcessIntent, rotation: number): string {
    const filt = intent.filter ? `${intent.filter[0]}-${intent.filter[1]}` : 'none'
    return `d${intent.dewarp ? 1 : 0}|f${filt}|r${rotation}|s${this._ctx.dewarp_supersample()}`
  }

  // Background-warms an adjacent page so next/prev is a cache hit instead of a blank "Loading…"
  // flash while the (potentially heavy, scanned-mode) work raster renders on demand.
  prefetch(p: number): void {
    if (p < 0 || p >= this._page_index.length || this._prefetching.has(p)) return
    const intent = this._ctx.process_intent(p)
    const warm = (this._ctx.mode() === Mode.SCANNED && (intent.dewarp || intent.filter))
      ? (this._work_versions.get(p)?.has(this._work_key(intent, this._ctx.rotation(p))) ?? false)
      : (this._source_versions.get(p)?.has(String(this._ctx.rotation(p))) ?? false)
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
