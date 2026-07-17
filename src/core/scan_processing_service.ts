// ScanProcessingService (§18 AppModel decomposition, step 6/7) — dewarp/filter toggles (spec-web
// §7, §10). Scan toggles flip SYNCHRONOUSLY (undoable — history pushed first), then the returned
// BatchJob pre-computes the selection's work rasters under the progress overlay (spec-web §11),
// yielding to the event loop so the overlay repaints and Cancel works. A cancel keeps the intent:
// unprocessed pages fall back to on-view lazy compute in the raster pipeline's get_work.
import type { DocumentState } from './document_state'
import type { PageProcessIntent } from './document_state'
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

  run_dewarp(pages: readonly number[]): BatchJob {
    this._history.push(this._ctx.document())   // snapshot BEFORE the toggle so undo reverts it
    const doc = this._ctx.document()
    doc.dewarp_on = !doc.dewarp_on
    this._apply_scan_intents(pages)
    return this._warm_work_cache(pages, 'Dewarping…')
  }

  set_filter_mode(pages: readonly number[], mode: FilterMode): BatchJob {
    this._history.push(this._ctx.document())
    const doc = this._ctx.document()
    // Toggle: pressing the active filter turns it off (spec §7.2)
    doc.filter_mode = (mode === doc.filter_mode) ? FilterMode.NONE : mode
    this._apply_scan_intents(pages)
    return this._warm_work_cache(pages, 'Applying filter…')
  }

  set_filter_strength(pages: readonly number[], n: number): BatchJob {
    this._history.push(this._ctx.document())
    this._ctx.document().filter_strength = Math.max(FILTER_STRENGTH_MIN, Math.min(FILTER_STRENGTH_MAX, n))
    this._apply_scan_intents(pages)
    return this._warm_work_cache(pages, 'Applying filter…')
  }

  private _warm_work_cache(pages: readonly number[], title: string): BatchJob {
    return start_batch(title, pages.length, job => this._run_warm(job, pages))
  }

  private async _run_warm(job: PageBatchJob, pages: readonly number[]): Promise<void> {
    const ctrl = job.controller
    const yield_to_paint = make_paint_yielder()
    for (const p of pages) {
      if (ctrl.is_cancelled) { ctrl.complete(new Cancelled()); return }
      try {
        await this._raster.get_work(p)
      } catch (e) {
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

  // Record the CURRENT global scan flags as each selected page's intent and drop its cached
  // rasters. No image work here — the next get_work(p) renders that page. (Callers push history
  // BEFORE mutating the flags, so undo reverts the toggle.)
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
      this._raster.drop_work(p)
      this._ctx.invalidate_output(p)
    }
    this._ctx.invalidate_current()
  }
}
