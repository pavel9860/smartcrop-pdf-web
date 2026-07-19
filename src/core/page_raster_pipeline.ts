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

  // The Dewarp&Deskew ONNX result at the page's UNROTATED (rotation=0) orientation — keyed by
  // supersample only, never rotation. Computed exactly once per (page, supersample) no matter how
  // many times the page is later rotated: rotate must never re-trigger the ONNX pass, only the
  // Dewarp&Deskew button itself does (spec-web §7). `_dewarped_versions` below derives each
  // rotation's view of this from a cheap bitmap rotation instead of re-running the model.
  private _dewarp_canonical  = new Map<number, LRUCache<string, ImageBitmap>>()

  // Dewarp-only intermediate AT THE PAGE'S CURRENT ROTATION (post-Dewarp&Deskew, pre-filter),
  // keyed by rotation+supersample only (no filter component) — switching the filter while dewarp
  // stays on reuses this instead of re-deriving it. Holds only the non-zero-rotation views: a
  // rotation=0 request is served directly from `_dewarp_canonical` (see _get_dewarped) rather than
  // duplicated in here too, avoiding two caches closing the same bitmap on eviction. Same
  // version-bounded-per-page shape as _work_versions; an Undo/Redo that actually flips dewarp_on
  // just resolves _work_key's `d0`/`d1` component to a different entry, no separate invalidation
  // needed here either.
  private _dewarped_versions = new Map<number, LRUCache<string, ImageBitmap>>()

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
    this._clear_versions(this._dewarp_canonical)
    this._clear_versions(this._dewarped_versions)
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
    this._clear_versions(this._dewarp_canonical)
    this._clear_versions(this._dewarped_versions)
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
    return this._get_source_at(p, this._ctx.rotation(p))
  }

  // Same as get_source, but at an EXPLICIT rotation rather than the page's current one — used to
  // fetch the canonical (rotation=0) source Dewarp&Deskew's ONNX pass runs against, regardless of
  // whatever rotation the page is currently displayed at (see _get_dewarped).
  private async _get_source_at(p: number, rotation: number): Promise<ImageBitmap> {
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
    const slot = this._work_slot(p)
    if (slot === 'source') {
      // NORMAL, or a no-op intent: the work raster IS the source raster. Do NOT also store it in
      // the work cache — the same bitmap in two close-on-evict caches gets double-closed,
      // detaching a bitmap the other cache still serves (root of the "image source is detached"
      // crash). It stays in the source cache.
      return this.get_source(p)
    }

    const intent = this._ctx.process_intent(p)
    const rotation = this._ctx.rotation(p)
    const supersample = this._ctx.dewarp_supersample()

    // Dewarp&Deskew dominates cost (multi-second CPU ONNX inference vs. the filter's ~200ms OpenCV
    // pass) — resolve it through its own cache, keyed only by rotation+supersample (no filter
    // component), so switching the filter while dewarp stays on reuses the dewarped raster instead
    // of re-running the dewarp pass on every filter change.
    const base = intent.dewarp ? await this._get_dewarped(p, rotation, supersample) : await this.get_source(p)
    // Dewarp-only (no filter): the dewarped raster IS the work result — same double-close hazard as
    // the source-aliasing case above, don't also store it in _work_versions.
    if (!intent.filter) return base

    const cache = this._version_cache(slot.map, p)
    const cached = cache.get(slot.key)
    if (cached) return cached

    // dewarp:false — `base` already carries the dewarp step (or never needed one); this call does
    // filter-only work.
    const work = await this._adapter.get_work_image(base, { dewarp: false, filter: intent.filter }, supersample)
    cache.set(slot.key, work)
    return work
  }

  // Which cache map + key get_work(p) resolves to for its CURRENT process_intent/rotation — the
  // single source of truth for cache routing, used by get_work itself (the final work_versions
  // step) and by prefetch's warmth check below, so the two can never independently drift on what
  // counts as "already cached." Read-only: never creates a cache entry (unlike _version_cache).
  private _work_slot(p: number): { map: Map<number, LRUCache<string, ImageBitmap>>; key: string } | 'source' {
    if (this._ctx.mode() !== Mode.SCANNED) return 'source'
    const intent = this._ctx.process_intent(p)
    if (!intent.dewarp && !intent.filter) return 'source'
    const rotation = this._ctx.rotation(p)
    const supersample = this._ctx.dewarp_supersample()
    if (!intent.filter) {
      return rotation === 0
        ? { map: this._dewarp_canonical, key: String(supersample) }
        : { map: this._dewarped_versions, key: this._dewarped_key(rotation, supersample) }
    }
    return { map: this._work_versions, key: this._work_key(intent, rotation) }
  }

  // Resolves the page's Dewarp&Deskew result at its CURRENT rotation, deriving it from the
  // canonical (rotation=0) ONNX result via a cheap bitmap rotation rather than re-running the
  // model — rotate must never re-trigger Dewarp&Deskew's ONNX pass (spec-web §7).
  private async _get_dewarped(p: number, rotation: number, supersample: number): Promise<ImageBitmap> {
    const canonical = await this._get_dewarp_canonical(p, supersample)
    if (rotation === 0) return canonical

    const cache = this._version_cache(this._dewarped_versions, p)
    const key = this._dewarped_key(rotation, supersample)
    const cached = cache.get(key)
    if (cached) return cached
    const rotated = await this._adapter.rotate_bitmap(canonical, rotation)
    cache.set(key, rotated)
    return rotated
  }

  // The ONNX-processed Dewarp&Deskew result at rotation 0 — computed once per (page, supersample)
  // no matter how many times the page is rotated afterward. Only run_dewarp() (the button) ever
  // reaches this via a cache miss; every other caller (rotate, prefetch, page nav) hits the same
  // entry or the cheap per-rotation derivation above.
  private async _get_dewarp_canonical(p: number, supersample: number): Promise<ImageBitmap> {
    const cache = this._version_cache(this._dewarp_canonical, p)
    const key = String(supersample)
    const cached = cache.get(key)
    if (cached) return cached
    const src0 = await this._get_source_at(p, 0)
    const dewarped = await this._adapter.get_work_image(src0, { dewarp: true, filter: null }, supersample)
    cache.set(key, dewarped)
    return dewarped
  }

  private _dewarped_key(rotation: number, supersample: number): string {
    return `r${rotation}|s${supersample}`
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
    const slot = this._work_slot(p)
    const warm = slot === 'source'
      ? (this._source_versions.get(p)?.has(String(this._ctx.rotation(p))) ?? false)
      : (slot.map.get(p)?.has(slot.key) ?? false)
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
