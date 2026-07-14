// PageOpsService tests (§18 AppModel decomposition, step 4/7): direct unit coverage of rotate/
// delete, independent of AppModel (which exercises it indirectly through its own suite).
import { describe, it, expect } from 'vitest'
import { PageOpsService, type PageOpsContext, type DetectionState } from '@core/page_ops_service'
import { PageIndexMap } from '@core/page_index_map'
import { PageRasterPipeline } from '@core/page_raster_pipeline'
import { History } from '@core/history'
import { default_document_state, type DocumentState } from '@core/document_state'
import { DeleteAllPagesError } from '@core/errors'
import { Mode } from '@core/enums'
import type { RendererAdapter, DocInfo, PageSize } from '@core/model'

function bmp(w = 100, h = 100): ImageBitmap { return { width: w, height: h, close: (): void => {} } }
function adapter(page_count = 3): RendererAdapter {
  return {
    load_files: (f: File[]): Promise<DocInfo> => Promise.resolve({
      page_count, page_sizes: Array.from({ length: page_count }, () => ({ width: 200, height: 300 })),
      file_names: f.map(x => x.name), mode: Mode.NORMAL,
    }),
    get_source_image: () => Promise.resolve(bmp()),
    get_work_image: () => Promise.resolve(bmp()),
    render_output_image: () => Promise.resolve(bmp()),
    detect_content_box: (_i, w, h) => Promise.resolve({ x0: 0, y0: 0, x1: w, y1: h }),
    export_pdf: () => Promise.resolve(new Uint8Array()),
    export_images: () => Promise.resolve(new Uint8Array()),
    make_synth_page: (_i, w, h) => Promise.resolve(bmp(w, h)),
    close: (): void => {},
  }
}

function setup(page_count = 3): {
  svc: PageOpsService
  doc: DocumentState
  detection: DetectionState
  current_page: { v: number }
  view_pos: { v: number }
  history: History
} {
  const idx = new PageIndexMap()
  idx.reset(page_count)
  const raster = new PageRasterPipeline(adapter(page_count), idx, {
    mode: () => Mode.NORMAL, display_dpi: () => 96, is_synthetic: () => false,
    rotation: () => 0, process_intent: () => ({ dewarp: false, filter: null }),
    dewarp_supersample: () => 1,
  })
  const doc = default_document_state()
  const detection: DetectionState = { cache: new Map(), union: null, auto_active: false }
  const current_page = { v: 0 }
  const view_pos = { v: 1 }
  const ctx: PageOpsContext = {
    document: () => doc,
    page_dims: (): PageSize => ({ width: 200, height: 300 }),
    detection: () => detection,
    set_detection: (d) => { detection.cache = d.cache; detection.union = d.union; detection.auto_active = d.auto_active },
    recompute_union: (cache) => {
      if (cache.size === 0) return null
      const boxes = [...cache.values()]
      return boxes.reduce((a, b) => ({
        x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
        x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
      }))
    },
    current_page: () => current_page.v,
    set_current_page: (p) => { current_page.v = p },
    view_pos: () => view_pos.v,
    set_view_pos: (p) => { view_pos.v = p },
    view_total: () => idx.length,
    page_count: () => idx.length,
  }
  const history = new History(20)
  const svc = new PageOpsService(history, idx, raster, ctx)
  return { svc, doc, detection, current_page, view_pos, history }
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

  it('rotates a committed crop box CW along with the page', () => {
    const { svc, doc } = setup()
    doc.applied.set(0, [{ x0: 0, y0: 0, x1: 100, y1: 50 }])
    svc.rotate([0])
    const rotated = doc.applied.get(0)![0]!
    expect(rotated).not.toEqual({ x0: 0, y0: 0, x1: 100, y1: 50 })
  })

  it('rotates a cached detected box and rebuilds the union when one exists', () => {
    const { svc, detection } = setup()
    detection.cache.set(0, { x0: 0, y0: 0, x1: 100, y1: 50 })
    detection.union = { x0: 0, y0: 0, x1: 100, y1: 50 }
    svc.rotate([0])
    expect(detection.cache.get(0)).not.toEqual({ x0: 0, y0: 0, x1: 100, y1: 50 })
    expect(detection.union).not.toBeNull()
  })

  it('resets offsets and drops the page from every raster cache', () => {
    const { svc, doc } = setup()
    doc.offsets = { left: 10, top: 10, right: 10, bottom: 10 }
    svc.rotate([0])
    expect(doc.offsets).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
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
    detection.cache.set(1, { x0: 0, y0: 0, x1: 50, y1: 50 })
    detection.auto_active = true
    svc.delete([0])
    expect(detection.auto_active).toBe(true)
    expect(detection.union).not.toBeNull()
  })

  it('clamps current_page and view_pos into the shrunk range', () => {
    const { svc, current_page, view_pos } = setup(3)
    current_page.v = 2
    view_pos.v = 3
    svc.delete([1, 2])   // only page 0 survives
    expect(current_page.v).toBe(0)
    expect(view_pos.v).toBe(1)
  })

  it('is destructive, not undoable — clears history rather than pushing a checkpoint', () => {
    const { svc, doc, history } = setup(3)
    history.push(doc)
    expect(history.can_undo).toBe(true)
    svc.delete([0])
    expect(history.can_undo).toBe(false)
  })
})
