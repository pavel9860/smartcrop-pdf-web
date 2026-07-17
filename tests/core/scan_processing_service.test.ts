// ScanProcessingService tests (§18 AppModel decomposition, step 6/7): direct unit coverage of
// dewarp/filter toggles, independent of AppModel (which exercises it indirectly through its own
// suite).
import { describe, it, expect, vi } from 'vitest'
import { ScanProcessingService, type ScanContext } from '@core/scan_processing_service'
import { PageIndexMap } from '@core/page_index_map'
import { PageRasterPipeline } from '@core/page_raster_pipeline'
import { History } from '@core/history'
import { default_document_state, type DocumentState } from '@core/document_state'
import { FilterMode, Mode } from '@core/enums'
import { Failed, Cancelled } from '@core/batch'
import type { RendererAdapter } from '@core/model'
import { make_adapter } from './harness'

function setup(opts: { adapter?: Partial<RendererAdapter> } = {}): {
  svc: ScanProcessingService
  doc: DocumentState
  history: History
  invalidated_output: number[]
  invalidated_current: number
} {
  const idx = new PageIndexMap()
  idx.reset(3)
  const doc = default_document_state()
  const adapter: RendererAdapter = { ...make_adapter(3, Mode.SCANNED), ...opts.adapter }
  const raster = new PageRasterPipeline(adapter, idx, {
    mode: () => Mode.SCANNED, display_dpi: () => 96, is_synthetic: () => false,
    rotation: () => 0,
    process_intent: () => ({
      dewarp: doc.dewarp_on,
      filter: doc.filter_mode === FilterMode.NONE ? null : [doc.filter_mode, doc.filter_strength],
    }),
    dewarp_supersample: () => 1,
    undo_depth: () => 2,
  })
  const history = new History(20)
  const invalidated_output: number[] = []
  let invalidated_current = 0
  const ctx: ScanContext = {
    document: () => doc,
    invalidate_output: (p) => { invalidated_output.push(p) },
    invalidate_current: () => { invalidated_current += 1 },
  }
  const svc = new ScanProcessingService(history, raster, ctx)
  return { svc, doc, history, invalidated_output, get invalidated_current() { return invalidated_current } }
}

describe('ScanProcessingService.run_dewarp', () => {
  it('turns dewarp on and pushes a history checkpoint before the flip', () => {
    const { svc, doc, history } = setup()
    expect(doc.dewarp_on).toBe(false)
    svc.run_dewarp([0])
    expect(doc.dewarp_on).toBe(true)
    expect(history.can_undo).toBe(true)
  })

  it('pressing it again while already on does not push a second history checkpoint (no reverse-by-repress)', () => {
    const { svc, doc, history } = setup()
    svc.run_dewarp([0])
    svc.run_dewarp([0])   // already on — no-op on the toggle itself
    expect(doc.dewarp_on).toBe(true)
    history.undo(doc)
    expect(history.can_undo).toBe(false)   // only one checkpoint was ever pushed
  })

  it('records the new intent for every selected page and invalidates their output cache', () => {
    const { svc, doc, invalidated_output } = setup()
    svc.run_dewarp([0, 1])
    expect(doc.processed.get(0)?.dewarp).toBe(true)
    expect(doc.processed.get(1)?.dewarp).toBe(true)
    expect(invalidated_output).toEqual([0, 1])
  })

  it('warms the work cache for the selection and completes Ok', async () => {
    const job = setup().svc.run_dewarp([0])
    const result = await job.result()
    expect(result).not.toBeInstanceOf(Failed)
    expect(result).not.toBeInstanceOf(Cancelled)
  })
})

describe('ScanProcessingService.set_filter_mode', () => {
  it('sets the filter mode and pushes a history checkpoint', () => {
    const { svc, doc, history } = setup()
    svc.set_filter_mode([0], FilterMode.BW)
    expect(doc.filter_mode).toBe(FilterMode.BW)
    expect(history.can_undo).toBe(true)
  })

  it('pressing the already-active filter is a no-op — it persists, no reverse-by-repress (spec §4.3/§7)', () => {
    const { svc, doc, history } = setup()
    svc.set_filter_mode([0], FilterMode.BW)
    svc.set_filter_mode([0], FilterMode.BW)
    expect(doc.filter_mode).toBe(FilterMode.BW)
    history.undo(doc)
    expect(history.can_undo).toBe(false)   // only one checkpoint was ever pushed
  })

  it('switching from one filter to another does not toggle off', () => {
    const { svc, doc } = setup()
    svc.set_filter_mode([0], FilterMode.BW)
    svc.set_filter_mode([0], FilterMode.SHARPEN)
    expect(doc.filter_mode).toBe(FilterMode.SHARPEN)
  })
})

describe('ScanProcessingService.set_filter_strength', () => {
  it('clamps to [FILTER_STRENGTH_MIN, FILTER_STRENGTH_MAX]', () => {
    const { svc, doc } = setup()
    svc.set_filter_strength([0], 999)
    expect(doc.filter_strength).toBe(3)
    svc.set_filter_strength([0], -5)
    expect(doc.filter_strength).toBe(1)
  })
})

describe('ScanProcessingService — batch job behavior', () => {
  it('cancels cleanly without completing further pages', async () => {
    const { svc } = setup()
    const job = svc.run_dewarp([0, 1, 2])
    job.cancel()
    const result = await job.result()
    expect(result).toBeInstanceOf(Cancelled)
  })

  it('completes Failed when the raster pipeline throws', async () => {
    const get_work_image = vi.fn(() => Promise.reject(new Error('decode failed')))
    const { svc } = setup({ adapter: { get_work_image } })
    const result = await svc.run_dewarp([0]).result()
    expect(result).toBeInstanceOf(Failed)
  })
})
