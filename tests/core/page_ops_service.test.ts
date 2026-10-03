// PageOpsService tests (§18 AppModel decomposition, step 4/7): direct unit coverage of rotate/
// delete, independent of AppModel (which exercises it indirectly through its own suite).
import { describe, it, expect } from 'vitest'
import { PageOpsService, type PageOpsContext, type DetectionState } from '@core/page_ops_service'
import { split_rects_grid, union_box } from '@core/geometry'
import { PageIndexMap } from '@core/page_index_map'
import type { PageRasterPipeline } from '@core/page_raster_pipeline'
import { History } from '@core/history'
import { default_document_state, type DocumentState } from '@core/document_state'
import { DeleteAllPagesError } from '@core/errors'
import type { PageSize } from '@core/model'
import { make_adapter, make_raster, bmp } from './harness'

function setup(page_count = 3): {
  svc: PageOpsService
  doc: DocumentState
  detection: DetectionState
  current_page: { v: number }
  split_count: { v: 1 | 2 | 4 }
  history: History
  raster: PageRasterPipeline
} {
  const idx = new PageIndexMap()
  idx.reset(page_count)
  const raster = make_raster(make_adapter({ page_count }), idx)
  const doc = default_document_state()
  doc.pages = Array.from({ length: page_count }, (_, i) => i)
  const detection: DetectionState = { cache: new Map(), union: null, auto_active: false }
  const current_page = { v: 0 }
  const split_count: { v: 1 | 2 | 4 } = { v: 1 }
  const ctx: PageOpsContext = {
    document: () => doc,
    page_dims: (): PageSize => ({ width: 200, height: 300 }),
    detection: () => detection,
    set_detection: (d) => { detection.cache = d.cache; detection.union = d.union; detection.auto_active = d.auto_active },
    recompute_union: cache => cache.size ? union_box([...cache.values()]) : null,
    current_page: () => current_page.v,
    set_current_page: (p) => { current_page.v = p },
    page_count: () => idx.length,
    split_count: () => split_count.v,
  }
  const history = new History(20)
  const svc = new PageOpsService(history, idx, raster, ctx)
  return { svc, doc, detection, current_page, split_count, history, raster }
}

describe('PageOpsService.rotate', () => {
  it('advances rotation by 90 degrees per page, wrapping at 360', () => {
    const { svc, doc } = setup()
    svc.rotate([0])
    expect(doc.rotation.get(0)).toBe(90)
    svc.rotate([0])
    svc.rotate([0])
    svc.rotate([0])
    expect(doc.rotation.get(0)).toBe(0)   // 90*4 wraps to 0
  })

  it('rotates the committed crop and the cached detection CW with the page, rebuilding the union', () => {
    const { svc, doc, detection } = setup()
    const b = { x0: 0, y0: 0, x1: 100, y1: 50 }
    doc.applied.set(0, [b])
    detection.cache.set(0, b)
    detection.union = b
    svc.rotate([0])
    const cw = { x0: 250, y0: 0, x1: 300, y1: 100 }
    expect([doc.applied.get(0), detection.cache.get(0), detection.union]).toEqual([[cw], cw, cw])
  })

  it('resets offsets', () => {
    const { svc, doc } = setup()
    doc.offsets = { left: 10, top: 10, right: 10, bottom: 10 }
    svc.rotate([0])
    expect(doc.offsets).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
  })

  it('invalidates the page\'s crop/split output preview (rotated box coordinates no longer match it)', async () => {
    const { svc, raster } = setup()
    await raster.prerender_output_views(0, [{ x0: 0, y0: 0, x1: 100, y1: 100 }], { width: 200, height: 300 }, bmp())
    expect(raster.output_at(0, 0)).not.toBeNull()

    svc.rotate([0])

    expect(raster.output_at(0, 0)).toBeNull()
  })

  it('reseeds crop_rects to a fresh page-fraction grid when split > 1 (bug: stayed stale after rotate)', () => {
    const { svc, doc, split_count, current_page } = setup()
    split_count.v = 2
    current_page.v = 0
    doc.crop_rects = [{ x0: 999, y0: 999, x1: 1000, y1: 1000 }, { x0: 0, y0: 0, x1: 1, y1: 1 }]
    svc.rotate([0])
    expect(doc.crop_rects).toEqual(split_rects_grid(2, 1, 1))
  })

  it('leaves crop_rects untouched when split === 1', () => {
    const { svc, doc } = setup()
    const rects = [{ x0: 1, y0: 2, x1: 3, y1: 4 }]
    doc.crop_rects = rects
    svc.rotate([0])
    expect(doc.crop_rects).toBe(rects)
  })
})

describe('PageOpsService.delete', () => {
  it('throws DeleteAllPagesError when the selection covers every page', () => {
    const { svc } = setup(3)
    expect(() => { svc.delete([0, 1, 2]) }).toThrow(DeleteAllPagesError)
  })

  it('reindexes applied/rotation/processed and the detection cache past the deleted page', () => {
    const { svc, doc, detection } = setup(3)
    doc.rotation.set(0, 90)
    doc.rotation.set(1, 180)
    doc.rotation.set(2, 270)
    detection.cache.set(2, { x0: 1, y0: 1, x1: 2, y1: 2 })
    svc.delete([0])
    // page 1 (rot 180) is now logical page 0; page 2 (rot 270) is now logical page 1
    expect(doc.rotation.get(0)).toBe(180)
    expect(doc.rotation.get(1)).toBe(270)
    expect(detection.cache.get(1)).toEqual({ x0: 1, y0: 1, x1: 2, y1: 2 })
  })

  it('drops auto_active and the union when nothing survives detection', () => {
    const { svc, detection } = setup(3)
    detection.auto_active = true
    detection.union = { x0: 0, y0: 0, x1: 1, y1: 1 }
    svc.delete([0])
    expect(detection.auto_active).toBe(false)
    expect(detection.union).toBeNull()
  })

  it('rebuilds the union from surviving detected pages when auto_active was on', () => {
    const { svc, detection } = setup(3)
    detection.cache.set(0, { x0: 0, y0: 0, x1: 90, y1: 90 })
    detection.cache.set(1, { x0: 10, y0: 10, x1: 50, y1: 50 })
    detection.auto_active = true
    svc.delete([0])
    expect([detection.auto_active, detection.union]).toEqual([true, { x0: 10, y0: 10, x1: 50, y1: 50 }])
  })

  it('moves current_page to a surviving page when its own page is deleted', () => {
    const { svc, current_page } = setup(3)
    current_page.v = 2
    svc.delete([1, 2])   // only page 0 survives
    expect(current_page.v).toBe(0)
  })

  it('is undoable — pushes a checkpoint holding the pre-delete page order', () => {
    const { svc, doc, history } = setup(3)
    svc.delete([0])
    expect(doc.pages).toEqual([1, 2])
    expect(history.undo(doc)?.pages).toEqual([0, 1, 2])
  })
})
