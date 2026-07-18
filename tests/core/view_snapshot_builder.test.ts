// ViewSnapshotBuilder tests (§18 AppModel decomposition, extra step): direct unit coverage of
// ViewSnapshot computation, independent of AppModel (which exercises it indirectly through its
// own suite).
import { describe, it, expect } from 'vitest'
import { ViewSnapshotBuilder, type ViewContext } from '@core/view_snapshot_builder'
import { CropController, type CropContext } from '@core/crop_controller'
import { PageIndexMap } from '@core/page_index_map'
import { PageRasterPipeline } from '@core/page_raster_pipeline'
import { History } from '@core/history'
import { default_document_state, type DocumentState } from '@core/document_state'
import { Mode } from '@core/enums'
import type { PageSize } from '@core/model'
import type { Box } from '@core/geometry'
import { make_adapter } from './harness'

function setup(page_count = 2): {
  builder: ViewSnapshotBuilder
  crop: CropController
  doc: DocumentState
  current_page: { v: number }
  view_pos: { v: number }
  drawn: { v: Box | null }
  detected: Map<number, Box>
  union: { v: Box | null }
  auto_active: { v: boolean }
} {
  const idx = new PageIndexMap()
  idx.reset(page_count)
  const doc = default_document_state()
  const raster = new PageRasterPipeline(make_adapter(page_count, Mode.NORMAL), idx, {
    mode: () => Mode.NORMAL, display_dpi: () => 96, is_synthetic: () => false,
    rotation: () => 0, process_intent: () => ({ dewarp: false, filter: null }),
    dewarp_supersample: () => 1, undo_depth: () => 2,
  })
  const current_page = { v: 0 }
  const view_pos = { v: 1 }
  const drawn: { v: Box | null } = { v: null }
  const detected = new Map<number, Box>()
  const union: { v: Box | null } = { v: null }
  const auto_active = { v: false }
  const page_dims = (): PageSize => ({ width: 200, height: 300 })
  const crop_ctx: CropContext = {
    document: () => doc,
    has_document: () => true,
    current_page: () => current_page.v,
    page_dims,
    detected: (p) => detected.get(p) ?? null,
    union: () => union.v,
    auto_active: () => auto_active.v,
    set_auto_active: (on) => { auto_active.v = on },
    drawn: () => drawn.v,
    set_drawn: (b) => { drawn.v = b },
  }
  const crop = new CropController(new History(20), crop_ctx)
  const view_ctx: ViewContext = {
    document: () => doc,
    page_dims,
    current_page: () => current_page.v,
    view_pos: () => view_pos.v,
    view_total: () => idx.length,
    page_count: () => idx.length,
    drawn: () => drawn.v,
    detected: (p) => detected.get(p) ?? null,
    union: () => union.v,
    auto_active: () => auto_active.v,
  }
  const builder = new ViewSnapshotBuilder(raster, crop, view_ctx)
  return { builder, crop, doc, current_page, view_pos, drawn, detected, union, auto_active }
}

describe('ViewSnapshotBuilder.synth_snapshot', () => {
  it('returns a null-image placeholder snapshot for the no-document state', () => {
    const { builder } = setup()
    const snap = builder.synth_snapshot()
    expect(snap.image).toBeNull()
    expect(snap.total).toBe(0)
    expect(snap.is_loading).toBe(false)
    expect(snap.overlay).toEqual([])
  })
})

describe('ViewSnapshotBuilder.build — uncommitted page', () => {
  it('reports the page dims, position, and an empty overlay with no crop/detect state', () => {
    const { builder } = setup()
    const snap = builder.build()
    expect(snap.page_w).toBe(200)
    expect(snap.page_h).toBe(300)
    expect(snap.crop_origin).toEqual({ x: 0, y: 0 })
    expect(snap.overlay).toEqual([])
    expect(snap.position).toBe(1)
  })

  it('shows split-mode boxes as the overlay when split_count > 1', () => {
    const { builder, crop, doc } = setup()
    crop.set_split(2)
    doc.crop_rects = [{ x0: 0, y0: 0, x1: 100, y1: 300 }, { x0: 100, y0: 0, x1: 200, y1: 300 }]
    const snap = builder.build()
    expect(snap.overlay).toEqual([
      { kind: 'split', box: { x0: 0, y0: 0, x1: 100, y1: 300 }, idx: 1 },
      { kind: 'split', box: { x0: 100, y0: 0, x1: 200, y1: 300 }, idx: 2 },
    ])
  })

  it('shows the drawn (hand-drawn) window, clamped to the page, when one is pending', () => {
    const { builder, drawn } = setup()
    drawn.v = { x0: -10, y0: -10, x1: 500, y1: 500 }   // deliberately outside the page
    const snap = builder.build()
    expect(snap.overlay).toEqual([{ kind: 'committed', box: { x0: 0, y0: 0, x1: 200, y1: 300 } }])
  })

  it('shows the live auto-crop when detection is active and anchored', () => {
    const { builder, detected, union, auto_active } = setup()
    detected.set(0, { x0: 10, y0: 10, x1: 100, y1: 100 })
    union.v = { x0: 10, y0: 10, x1: 100, y1: 100 }
    auto_active.v = true
    const snap = builder.build()
    expect(snap.overlay).toHaveLength(1)
    expect(snap.overlay[0]?.kind).toBe('auto')
  })
})

describe('ViewSnapshotBuilder.build — committed page', () => {
  it('shows the crop box dimensions and origin, not the full page', () => {
    const { builder, doc } = setup()
    doc.applied.set(0, [{ x0: 20, y0: 30, x1: 120, y1: 180 }])
    const snap = builder.build()
    expect(snap.page_w).toBe(100)   // 120 - 20
    expect(snap.page_h).toBe(150)   // 180 - 30
    expect(snap.crop_origin).toEqual({ x: 20, y: 30 })
  })

  it('shows no outline when plain committed with nothing being drawn (spec: no frame)', () => {
    const { builder, doc } = setup()
    doc.applied.set(0, [{ x0: 20, y0: 30, x1: 120, y1: 180 }])
    const snap = builder.build()
    expect(snap.overlay).toEqual([])
  })

  it('shows the drawn window clamped to the crop box, not the full page, once committed', () => {
    const { builder, doc, drawn } = setup()
    doc.applied.set(0, [{ x0: 20, y0: 30, x1: 120, y1: 180 }])
    drawn.v = { x0: 0, y0: 0, x1: 500, y1: 500 }   // outside the crop box
    const snap = builder.build()
    expect(snap.overlay).toEqual([{ kind: 'committed', box: { x0: 20, y0: 30, x1: 120, y1: 180 } }])
  })
})

describe('ViewSnapshotBuilder.live_auto_crop_for', () => {
  it('returns null with no detection', () => {
    const { builder } = setup()
    expect(builder.live_auto_crop_for(0)).toBeNull()
  })

  it('returns null when neither anchor is set', () => {
    const { builder, crop, detected, union, auto_active } = setup()
    crop.set_anchor(false, false)
    detected.set(0, { x0: 10, y0: 10, x1: 100, y1: 100 })
    union.v = { x0: 10, y0: 10, x1: 100, y1: 100 }
    auto_active.v = true
    expect(builder.live_auto_crop_for(0)).toBeNull()
  })

  it('returns the anchored auto-crop rect when detection is active', () => {
    const { builder, detected, union, auto_active } = setup()
    detected.set(0, { x0: 10, y0: 10, x1: 100, y1: 100 })
    union.v = { x0: 10, y0: 10, x1: 100, y1: 100 }
    auto_active.v = true
    expect(builder.live_auto_crop_for(0)).not.toBeNull()
  })
})
