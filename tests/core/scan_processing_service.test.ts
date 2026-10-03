// ScanProcessingService tests (§18 AppModel decomposition, step 6/7): direct unit coverage of
// dewarp/filter toggles, independent of AppModel (which exercises it indirectly through its own
// suite).
import { describe, it, expect, vi } from 'vitest'
import { ScanProcessingService, type ScanContext } from '@core/scan_processing_service'
import { PageIndexMap } from '@core/page_index_map'
import { History } from '@core/history'
import { default_document_state, type DocumentState } from '@core/document_state'
import { FilterMode, Mode } from '@core/enums'
import { Ok, Failed, Cancelled } from '@core/batch'
import type { RendererAdapter } from '@core/model'
import { make_adapter, make_raster } from './harness'

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
  const adapter: RendererAdapter = { ...make_adapter({ mode: Mode.SCANNED }), ...opts.adapter }
  const raster = make_raster(adapter, idx, {
    mode: () => Mode.SCANNED,
    process_intent: () => ({
      dewarp: doc.dewarp_on,
      filter: doc.filter_mode === FilterMode.NONE ? null : [doc.filter_mode, doc.filter_strength],
    }),
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

  it('warms the work cache for every selected page and completes Ok', async () => {
    const get_work_image = vi.fn((src: ImageBitmap) => Promise.resolve(src))
    const result = await setup({ adapter: { get_work_image } }).svc.run_dewarp([0, 2]).result()
    expect(result).toBeInstanceOf(Ok)
    expect(get_work_image).toHaveBeenCalledTimes(2)
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
    const get_work_image = vi.fn((src: ImageBitmap) => Promise.resolve(src))
    const job = setup({ adapter: { get_work_image } }).svc.run_dewarp([0, 1, 2])
    job.cancel()
    expect(await job.result()).toBeInstanceOf(Cancelled)
    expect(get_work_image.mock.calls.length).toBeLessThan(3)
  })

  it('completes Failed when the raster pipeline throws', async () => {
    const get_work_image = vi.fn(() => Promise.reject(new Error('decode failed')))
    const { svc } = setup({ adapter: { get_work_image } })
    const result = await svc.run_dewarp([0]).result()
    expect(result).toBeInstanceOf(Failed)
  })
})
