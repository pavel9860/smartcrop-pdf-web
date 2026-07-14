// PageOpsService (§18 AppModel decomposition, step 4/7) — rotate/delete (spec-web §6.10). Neither
// operation owns new state: both mutate DocumentState fields (rotation/applied/processed),
// PageIndexMap, the raster caches, and the shared detection-result state (detect_cache/union/
// auto_active) that AppModel still owns (also read by CropController and, soon, DetectionService
// — see PageOpsContext below, the same "shared state stays on AppModel, exposed live" pattern
// PageRasterPipeline/CropController already established).
import type { Box } from './geometry'
import { rotate_box_cw, reindex_map } from './geometry'
import type { DocumentState } from './document_state'
import type { History } from './history'
import { DEFAULT_OFFSETS } from './document_state'
import { DeleteAllPagesError } from './errors'
import type { PageSize } from './model'
import type { PageIndexMap } from './page_index_map'
import type { PageRasterPipeline } from './page_raster_pipeline'

export interface DetectionState {
  cache: Map<number, Box>
  union: Box | null
  auto_active: boolean
}

export interface PageOpsContext {
  document(): DocumentState
  page_dims(p: number): PageSize
  detection(): DetectionState
  set_detection(d: DetectionState): void
  // = AppModel's _compute_detection_union, shared with the (soon) DetectionService — pure w.r.t.
  // this service, reads only settings.detect_outlier_pages and page_dims.
  recompute_union(cache: Map<number, Box>): Box | null
  current_page(): number
  set_current_page(p: number): void
  view_pos(): number
  set_view_pos(pos: number): void
  view_total(): number
  page_count(): number
}

export class PageOpsService {
  constructor(
    private readonly _history: History,
    private readonly _page_index: PageIndexMap,
    private readonly _raster: PageRasterPipeline,
    private readonly _ctx: PageOpsContext,
  ) {}

  rotate(pages: readonly number[]): void {
    this._history.push(this._ctx.document())
    for (const p of pages) this._rotate_page(p)
  }

  private _rotate_page(p: number): void {
    // Effective dims BEFORE this 90° step — box coords being carried through are still in
    // that (pre-step) frame. Must read before mutating rotation.
    const sz = this._ctx.page_dims(p)
    const doc = this._ctx.document()
    const cur_rot = doc.rotation.get(p) ?? 0
    doc.rotation.set(p, (cur_rot + 90) % 360)

    const app = doc.applied.get(p)
    if (app) doc.applied.set(p, app.map(b => rotate_box_cw(b, sz.height)))
    const det = this._ctx.detection()
    const rotated_det = det.cache.get(p)
    if (rotated_det) det.cache.set(p, rotate_box_cw(rotated_det, sz.height))

    this._raster.delete_page(p)

    doc.offsets = DEFAULT_OFFSETS
    if (det.union) {
      // Rebuild with the SAME FULL_PAGE_FRAC exclusion the initial detect applies (bug 2a,
      // 99_FOUND_ISSUES): the old raw detection_union() re-admitted full-page fallback boxes after
      // a rotate, silently inflating every crop. Judged against each page's rotated dims.
      this._ctx.set_detection({ ...det, union: this._ctx.recompute_union(det.cache) })
    }
  }

  delete(pages: readonly number[]): void {
    if (pages.length >= this._ctx.page_count()) throw new DeleteAllPagesError('Cannot delete all pages')

    const sorted = [...pages].sort((a, b) => a - b)
    const removed = new Set(sorted)

    // Delete is destructive, not undoable (clears history rather than snapshotting — spec-web §12
    // states Rotate is "Fully undoable" in explicit contrast). It can't be made undoable here
    // regardless: PageIndexMap lives outside DocumentState, so a restored applied/rotation map
    // could reference original page indices the map no longer has — the same class of desync bug
    // as the set_keep_ratio fix elsewhere, just for a field History can't reach.
    this._history.clear()

    // Reindex per-page maps (spec-web §12)
    const doc = this._ctx.document()
    doc.applied   = reindex_map(doc.applied,   sorted)
    doc.rotation  = reindex_map(doc.rotation,  sorted)
    doc.processed = reindex_map(doc.processed, sorted)
    const det = this._ctx.detection()
    const cache = reindex_map(det.cache, sorted)

    // Rebuild the logical->original page index map (pdf.js has no in-place page-deletion
    // primitive, so this is a filter + reindex instead).
    // MUST precede the union rebuild below: recompute_union reads each surviving page's
    // dimensions through PageIndexMap, so it has to be reindexed first (bug 2a — the union was
    // judged against a stale page map).
    this._page_index.remove(removed)

    if (det.auto_active && cache.size > 0) {
      // Same FULL_PAGE_FRAC exclusion the initial detect applies (bug 2a): the old raw
      // detection_union() re-admitted full-page fallback boxes, distorting the union after a delete.
      const union = this._ctx.recompute_union(cache)
      this._ctx.set_detection({ cache, union, auto_active: union !== null })
    } else {
      this._ctx.set_detection({ cache, union: null, auto_active: false })
    }

    this._raster.clear_ram()
    this._ctx.set_current_page(Math.min(this._ctx.current_page(), this._ctx.page_count() - 1))
    this._ctx.set_view_pos(Math.min(this._ctx.view_pos(), this._ctx.view_total()))
  }
}
