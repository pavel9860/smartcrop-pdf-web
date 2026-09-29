// ScanProcessingService (§18 AppModel decomposition, step 6/7) — dewarp/filter toggles (spec-web
// §7, §10). Scan toggles flip SYNCHRONOUSLY, then the returned BatchJob pre-computes the
// selection's work rasters under the progress overlay (spec-web §11), yielding to the event loop
// so the overlay repaints and Cancel works. A changed toggle is one undo step, pushed up front so
// undo order matches press order; a cancel keeps the intent (unprocessed pages compute lazily on
// view), and a failure restores the pre-action document (spec-web §21 #26).
import { snapshot, type DocumentState, type PageProcessIntent } from './document_state'
import type { History } from './history'
import { FILTER_STRENGTH_MIN, FILTER_STRENGTH_MAX } from './constants'
import { FilterMode } from './enums'
import {
  type BatchJob, type PageBatchJob, Ok, Cancelled, start_batch, fail_batch, make_paint_yielder,
} from './batch'
import type { PageRasterPipeline } from './page_raster_pipeline'

export interface ScanContext {
  document(): DocumentState
  invalidate_output(p: number): void
  invalidate_current(): void
}

export class ScanProcessingService {
  constructor(
    private readonly _history: History,
    private readonly _raster: PageRasterPipeline,
    private readonly _ctx: ScanContext,
  ) {}

  // Persists until Undo — pressing it again while already on is a no-op on the toggle itself (no
  // reverse-by-repress, spec §4.3/§7), but the selection's intent/cache still gets (re)applied so a
  // newly-widened Pages selection catches up.
  run_dewarp(pages: readonly number[]): BatchJob {
    const doc = this._ctx.document()
    const before = snapshot(doc)
    const changed = !doc.dewarp_on
    doc.dewarp_on = true
    return this._apply_and_warm(pages, 'Dewarping…', before, changed)
  }

  // Persists until Undo — pressing the already-active filter is a no-op on the toggle itself (no
  // reverse-by-repress, spec §4.3/§7); switching to the other filter replaces it in one step.
  set_filter_mode(pages: readonly number[], mode: FilterMode): BatchJob {
    const doc = this._ctx.document()
    const before = snapshot(doc)
    const changed = doc.filter_mode !== mode
    doc.filter_mode = mode
    return this._apply_and_warm(pages, 'Applying filter…', before, changed)
  }

  set_filter_strength(pages: readonly number[], n: number): BatchJob {
    const doc = this._ctx.document()
    const before = snapshot(doc)
    doc.filter_strength = Math.max(FILTER_STRENGTH_MIN, Math.min(FILTER_STRENGTH_MAX, n))
    return this._apply_and_warm(pages, 'Applying filter…', before, true)
  }

  private _apply_and_warm(
    pages: readonly number[], title: string, before: DocumentState, changed: boolean,
  ): BatchJob {
    if (changed) this._history.push(before)
    this._apply_scan_intents(pages)
    return start_batch(title, pages.length, job => this._run_warm(job, pages, before))
  }

  private async _run_warm(
    job: PageBatchJob, pages: readonly number[], before: DocumentState,
  ): Promise<void> {
    const ctrl = job.controller
    const yield_to_paint = make_paint_yielder()
    for (const p of pages) {
      if (ctrl.is_cancelled) { ctrl.complete(new Cancelled()); return }
      try {
        await this._raster.get_work(p)
      } catch (e) {
        Object.assign(this._ctx.document(), before)
        for (const q of pages) this._ctx.invalidate_output(q)
        this._ctx.invalidate_current()
        fail_batch(ctrl, e)
        return
      }
      ctrl.advance()
      // Yield so the progress overlay repaints (per-page OpenCV/ONNX blocks the main thread) —
      // gated on elapsed time (PAINT_YIELD_INTERVAL_MS), not once per page.
      await yield_to_paint()
    }
    ctrl.complete(new Ok())
  }

  // Record the CURRENT global scan flags as each selected page's intent and invalidate its crop
  // preview. No image work here — the next get_work(p) resolves the (page, rotation, dewarp,
  // filter, strength) cache key and renders that page only on a genuine miss (§7); an already-
  // cached raster for this exact combination (e.g. re-applying the same intent, or Undo landing
  // back on one) is reused, not recomputed. (Callers push history BEFORE mutating the flags, so
  // undo reverts the toggle.)
  private _apply_scan_intents(pages: readonly number[]): void {
    const doc = this._ctx.document()
    const intent: PageProcessIntent = {
      dewarp: doc.dewarp_on,
      filter: doc.filter_mode === FilterMode.NONE
        ? null
        : [doc.filter_mode, doc.filter_strength],
    }
    for (const p of pages) {
      doc.processed.set(p, intent)
      this._ctx.invalidate_output(p)
    }
    this._ctx.invalidate_current()
  }
}
