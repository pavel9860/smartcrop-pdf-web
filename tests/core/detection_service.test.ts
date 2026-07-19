// DetectionService tests (§18 AppModel decomposition, step 5/7): direct unit coverage of
// Auto-detect, independent of AppModel (which exercises it indirectly through its own suite).
import { describe, it, expect, vi } from 'vitest'
import { DetectionService, type DetectionContext, type RegionDetectionState } from '@core/detection_service'
import type { DetectionState } from '@core/page_ops_service'
import { PageIndexMap } from '@core/page_index_map'
import { PageRasterPipeline } from '@core/page_raster_pipeline'
import { History } from '@core/history'
import { default_document_state, type DocumentState } from '@core/document_state'
import { Mode } from '@core/enums'
import { Failed, Cancelled } from '@core/batch'
import type { RendererAdapter, PageSize } from '@core/model'
import type { Box } from '@core/geometry'
import { make_adapter } from './harness'

function setup(opts: {
  page_count?: number
  mode?: Mode
  adapter?: Partial<RendererAdapter>
  omit_detect_text_box?: boolean
  has_document?: boolean
  split_count?: 1 | 2 | 4
  same_size?: boolean
  current_page?: number
  page_dims?: PageSize
} = {}): {
  svc: DetectionService
  doc: DocumentState
  detection: DetectionState
  region_detection: RegionDetectionState
  anchor: { left: boolean; top: boolean }
  keep_ratio: { v: boolean }
  ratio: { v: number }
  invalidated: number[]
  drawn: { v: Box | null }
} {
  const page_count = opts.page_count ?? 3
  const adapter: RendererAdapter = { ...make_adapter(page_count, opts.mode ?? Mode.NORMAL), ...opts.adapter }
  if (opts.omit_detect_text_box) delete adapter.detect_text_box
  const idx = new PageIndexMap()
  idx.reset(page_count)
  const raster = new PageRasterPipeline(adapter, idx, {
    mode: () => opts.mode ?? Mode.NORMAL, display_dpi: () => 96, is_synthetic: () => false,
    rotation: () => 0, process_intent: () => ({ dewarp: false, filter: null }),
    dewarp_supersample: () => 1, undo_depth: () => 2,
  })
  const doc = default_document_state()
  const detection: DetectionState = { cache: new Map(), union: null, auto_active: false }
  const region_detection: RegionDetectionState = { cache: [], unions: [] }
  const anchor = { left: true, top: true }
  const keep_ratio = { v: false }
  const ratio = { v: 1 }
  const invalidated: number[] = []
  const drawn: { v: Box | null } = { v: null }
  const history = new History(20)
  const dims = opts.page_dims ?? { width: 200, height: 300 }
  const ctx: DetectionContext = {
    has_document: () => opts.has_document ?? true,
    document: () => doc,
    page_dims: (): PageSize => dims,
    mode: () => opts.mode ?? Mode.NORMAL,
    detection: () => detection,
    set_detection: (d) => { detection.cache = d.cache; detection.union = d.union; detection.auto_active = d.auto_active },
    region_detection: () => region_detection,
    set_region_detection: (d) => { region_detection.cache = d.cache; region_detection.unions = d.unions },
    split_count: () => opts.split_count ?? 1,
    same_size: () => opts.same_size ?? false,
    current_page: () => opts.current_page ?? 0,
    anchor_left: () => anchor.left,
    anchor_top: () => anchor.top,
    keep_ratio: () => keep_ratio.v,
    set_ratio: (r) => { ratio.v = r },
    outlier_pages: () => 0,
    invalidate_output: (p) => { invalidated.push(p) },
    set_drawn: (box) => { drawn.v = box },
  }
  const svc = new DetectionService(adapter, history, raster, idx, ctx)
  return { svc, doc, detection, region_detection, anchor, keep_ratio, ratio, invalidated, drawn }
}

describe('DetectionService.detect — NORMAL mode', () => {
  it('uses adapter.detect_text_box, no rasterization', async () => {
    const text_box = vi.fn(() => Promise.resolve({ x0: 5, y0: 5, x1: 100, y1: 100 } as Box))
    const get_source = vi.fn()
    const { svc, detection } = setup({
      mode: Mode.NORMAL,
      adapter: { detect_text_box: text_box, get_source_image: get_source },
    })
    const result = await svc.detect([0]).result()
    expect(result).toBeInstanceOf(Object) // Ok
    expect(text_box).toHaveBeenCalledTimes(1)
    expect(get_source).not.toHaveBeenCalled()
    expect(detection.cache.get(0)).toEqual({ x0: 5, y0: 5, x1: 100, y1: 100 })
  })

  it('without adapter.detect_text_box: no box detected, never falls back to rasterization', async () => {
    const { svc, detection } = setup({ mode: Mode.NORMAL, omit_detect_text_box: true })
    await svc.detect([0]).result()
    expect(detection.cache.has(0)).toBe(false)
  })
})

describe('DetectionService.detect — SCANNED mode', () => {
  it('rasterizes the source and uses adapter.detect_content_box', async () => {
    const content_box = vi.fn((_i: unknown, w: number, h: number) =>
      Promise.resolve({ x0: 0, y0: 0, x1: w, y1: h } as Box))
    const { svc, detection } = setup({ mode: Mode.SCANNED, adapter: { detect_content_box: content_box } })
    await svc.detect([0]).result()
    expect(content_box).toHaveBeenCalledTimes(1)
    expect(detection.cache.get(0)).toEqual({ x0: 0, y0: 0, x1: 200, y1: 300 })
  })
})

describe('DetectionService.detect — union/ratio/refresh', () => {
  it('sets auto_active and computes a union from the detected (non-full-page) boxes', async () => {
    const text_box = vi.fn(() => Promise.resolve({ x0: 10, y0: 10, x1: 100, y1: 100 } as Box))
    const { svc, detection } = setup({ mode: Mode.NORMAL, adapter: { detect_text_box: text_box } })
    await svc.detect([0, 1]).result()
    expect(detection.auto_active).toBe(true)
    expect(detection.union).not.toBeNull()
  })

  it('sets the crop ratio to the union aspect when keep_ratio is off', async () => {
    const text_box = vi.fn(() => Promise.resolve({ x0: 0, y0: 0, x1: 100, y1: 50 } as Box))
    const { svc, ratio } = setup({ mode: Mode.NORMAL, adapter: { detect_text_box: text_box } })
    await svc.detect([0]).result()
    expect(ratio.v).toBeCloseTo(100 / 50, 5)
  })

  it('leaves the ratio untouched when keep_ratio is on', async () => {
    const text_box = vi.fn(() => Promise.resolve({ x0: 0, y0: 0, x1: 100, y1: 50 } as Box))
    const { svc, ratio, keep_ratio } = setup({ mode: Mode.NORMAL, adapter: { detect_text_box: text_box } })
    keep_ratio.v = true
    await svc.detect([0]).result()
    expect(ratio.v).toBe(1)   // unchanged from setup's default
  })

  it('refreshes an already-committed crop on a re-detected, anchored page', async () => {
    const text_box = vi.fn(() => Promise.resolve({ x0: 0, y0: 0, x1: 100, y1: 100 } as Box))
    const { svc, doc, invalidated } = setup({ mode: Mode.NORMAL, adapter: { detect_text_box: text_box } })
    doc.applied.set(0, [{ x0: 10, y0: 10, x1: 50, y1: 50 }])
    await svc.detect([0]).result()
    expect(doc.applied.get(0)).not.toEqual([{ x0: 10, y0: 10, x1: 50, y1: 50 }])
    expect(invalidated).toContain(0)
  })

  it('does not touch a committed page when neither anchor is on', async () => {
    const text_box = vi.fn(() => Promise.resolve({ x0: 0, y0: 0, x1: 100, y1: 100 } as Box))
    const { svc, doc, anchor } = setup({ mode: Mode.NORMAL, adapter: { detect_text_box: text_box } })
    anchor.left = false; anchor.top = false
    doc.applied.set(0, [{ x0: 10, y0: 10, x1: 50, y1: 50 }])
    await svc.detect([0]).result()
    expect(doc.applied.get(0)).toEqual([{ x0: 10, y0: 10, x1: 50, y1: 50 }])
  })
})

describe('DetectionService.detect — guards and error paths', () => {
  it('completes Cancelled immediately when there is no document', async () => {
    const text_box = vi.fn()
    const { svc } = setup({ has_document: false, adapter: { detect_text_box: text_box } })
    const result = await svc.detect([0]).result()
    expect(result).toBeInstanceOf(Cancelled)
    expect(text_box).not.toHaveBeenCalled()
  })

  it('completes Failed when the adapter throws mid-page', async () => {
    const text_box = vi.fn(() => Promise.reject(new Error('boom')))
    const { svc } = setup({ mode: Mode.NORMAL, adapter: { detect_text_box: text_box } })
    const result = await svc.detect([0]).result()
    expect(result).toBeInstanceOf(Failed)
  })

  it('completes Cancelled without mutating state when cancelled before it starts', async () => {
    const { svc, detection } = setup({ mode: Mode.NORMAL })
    const job = svc.detect([0])
    job.cancel()
    const result = await job.result()
    expect(result).toBeInstanceOf(Cancelled)
    expect(detection.auto_active).toBe(false)
  })

  it('drops a pending hand-drawn window synchronously, not just after the batch resolves (Auto-detect was silently masked by it otherwise)', () => {
    const { svc, drawn } = setup({ mode: Mode.NORMAL })
    drawn.v = { x0: 10, y0: 10, x1: 90, y1: 90 }
    svc.detect([0])   // don't even await — must clear before the async batch does anything
    expect(drawn.v).toBeNull()
  })
})

describe('DetectionService.detect — split regions (spec §4.5/§5a)', () => {
  it('detects independently within each region and writes crop_rects from the current page (SCANNED)', async () => {
    // page 200x300, split=2 -> regions [0,0,100,300] (left) and [100,0,200,300] (right).
    // Mock: "detected content" is the region inset by 10px on every side.
    const content_box = vi.fn((_i: unknown, _w: number, _h: number, _m: unknown, region: Box) =>
      Promise.resolve({ x0: region.x0 + 10, y0: region.y0 + 10, x1: region.x1 - 10, y1: region.y1 - 10 } as Box))
    const { svc, doc, region_detection } = setup({
      mode: Mode.SCANNED, split_count: 2, page_count: 1,
      adapter: { detect_content_box: content_box },
    })
    const result = await svc.detect([0]).result()
    expect(result).toBeInstanceOf(Object)   // Ok
    expect(content_box).toHaveBeenCalledTimes(2)   // once per region
    expect(region_detection.unions).toEqual([
      { x0: 10, y0: 10, x1: 90, y1: 290 },
      { x0: 110, y0: 10, x1: 190, y1: 290 },
    ])
    expect(doc.crop_rects).toEqual([
      { x0: 10, y0: 10, x1: 90, y1: 290 },
      { x0: 110, y0: 10, x1: 190, y1: 290 },
    ])
  })

  it('detects independently within each region (NORMAL, via detect_text_box)', async () => {
    const text_box = vi.fn((_p: unknown, region?: Box) =>
      Promise.resolve(region ? { x0: region.x0 + 5, y0: region.y0 + 5, x1: region.x1 - 5, y1: region.y1 - 5 } : null))
    const { svc, doc } = setup({
      mode: Mode.NORMAL, split_count: 2, page_count: 1,
      adapter: { detect_text_box: text_box },
    })
    await svc.detect([0]).result()
    expect(text_box).toHaveBeenCalledTimes(2)
    expect(doc.crop_rects).toEqual([
      { x0: 5, y0: 5, x1: 95, y1: 295 },
      { x0: 105, y0: 5, x1: 195, y1: 295 },
    ])
  })

  it('same_size ON: every region grows to the largest union size, extended outward from its own anchor corner', async () => {
    const content_box = vi.fn((_i: unknown, _w: number, _h: number, _m: unknown, region: Box) => {
      // left region (x0=0): a small 60x60 box. right region (x0=100): a larger 70x260 box.
      const small = region.x0 === 0
      return Promise.resolve(small
        ? { x0: 20, y0: 20, x1: 80, y1: 80 }
        : { x0: 120, y0: 20, x1: 190, y1: 280 } as Box)
    })
    const { svc, doc } = setup({
      mode: Mode.SCANNED, split_count: 2, same_size: true, page_count: 1,
      adapter: { detect_content_box: content_box },
    })
    await svc.detect([0]).result()
    // Left grew to the right region's 70x260 size, anchored at its own detected top-left (20,20).
    expect(doc.crop_rects[0]).toEqual({ x0: 20, y0: 20, x1: 90, y1: 280 })
    // Right was already the largest — unchanged.
    expect(doc.crop_rects[1]).toEqual({ x0: 120, y0: 20, x1: 190, y1: 280 })
  })

  it('n=4: detects within each quadrant independently', async () => {
    const content_box = vi.fn((_i: unknown, _w: number, _h: number, _m: unknown, region: Box) =>
      Promise.resolve({ x0: region.x0 + 1, y0: region.y0 + 1, x1: region.x1 - 1, y1: region.y1 - 1 } as Box))
    const { svc, doc } = setup({
      mode: Mode.SCANNED, split_count: 4, page_count: 1,
      adapter: { detect_content_box: content_box },
    })
    await svc.detect([0]).result()
    expect(content_box).toHaveBeenCalledTimes(4)
    expect(doc.crop_rects).toHaveLength(4)
  })

  it('a region with no detected content on any page falls back to the full region box', async () => {
    // Left region always finds nothing; right always finds content.
    const content_box = vi.fn((_i: unknown, _w: number, _h: number, _m: unknown, region: Box) =>
      Promise.resolve(region.x0 === 0
        ? { x0: region.x0, y0: region.y0, x1: region.x1, y1: region.y1 }   // full-region -> excluded by FULL_PAGE_FRAC
        : { x0: region.x0 + 10, y0: region.y0 + 10, x1: region.x1 - 10, y1: region.y1 - 10 } as Box))
    const { svc, doc, region_detection } = setup({
      mode: Mode.SCANNED, split_count: 2, page_count: 1,
      adapter: { detect_content_box: content_box },
    })
    await svc.detect([0]).result()
    expect(region_detection.unions[0]).toBeNull()
    expect(doc.crop_rects[0]).toEqual({ x0: 0, y0: 0, x1: 100, y1: 300 })   // the raw left region
  })

  it('the current page has no detected box of its own -> region centered, not auto_crop_rect (bug #8/#9 parity)', async () => {
    // Only page 0 is detected (current_page is 1, outside the detected set), so cache[r] has no
    // entry for the current page -> _write_split_crop_rects falls back to centered_crop_rect.
    const content_box = vi.fn((_i: unknown, _w: number, _h: number, _m: unknown, region: Box) =>
      Promise.resolve({ x0: region.x0 + 10, y0: region.y0 + 10, x1: region.x1 - 10, y1: region.y1 - 10 } as Box))
    const { svc, doc } = setup({
      mode: Mode.SCANNED, split_count: 2, page_count: 2, current_page: 1,
      adapter: { detect_content_box: content_box },
    })
    await svc.detect([0]).result()
    // Centered in each 100x300 region: W=80,H=280 (union) -> x0=(100-80)/2=10, y0=(300-280)/2=10
    expect(doc.crop_rects[0]).toEqual({ x0: 10, y0: 10, x1: 90, y1: 290 })
  })

  it('no anchor on: leaves crop_rects untouched', async () => {
    const content_box = vi.fn((_i: unknown, _w: number, _h: number, _m: unknown, region: Box) =>
      Promise.resolve({ x0: region.x0 + 10, y0: region.y0 + 10, x1: region.x1 - 10, y1: region.y1 - 10 } as Box))
    const { svc, doc, anchor } = setup({
      mode: Mode.SCANNED, split_count: 2, page_count: 1,
      adapter: { detect_content_box: content_box },
    })
    anchor.left = false; anchor.top = false
    const before = doc.crop_rects
    await svc.detect([0]).result()
    expect(doc.crop_rects).toBe(before)   // never reassigned
  })

  it('cancelling mid-region-loop completes Cancelled without writing crop_rects', async () => {
    const { svc, doc } = setup({ mode: Mode.SCANNED, split_count: 2, page_count: 1 })
    const before = doc.crop_rects
    const job = svc.detect([0])
    job.cancel()
    const result = await job.result()
    expect(result).toBeInstanceOf(Cancelled)
    expect(doc.crop_rects).toBe(before)
  })

  it('refreshes already-committed split pages instead of dropping them', async () => {
    const content_box = vi.fn((_i: unknown, _w: number, _h: number, _m: unknown, region: Box) =>
      Promise.resolve({ x0: region.x0 + 10, y0: region.y0 + 10, x1: region.x1 - 10, y1: region.y1 - 10 } as Box))
    const { svc, doc, invalidated } = setup({
      mode: Mode.SCANNED, split_count: 2, page_count: 1,
      adapter: { detect_content_box: content_box },
    })
    doc.applied.set(0, [{ x0: 0, y0: 0, x1: 1, y1: 1 }, { x0: 0, y0: 0, x1: 1, y1: 1 }])
    await svc.detect([0]).result()
    expect(doc.applied.get(0)).toEqual(doc.crop_rects)
    expect(invalidated).toContain(0)
  })
})

describe('DetectionService.compute_union', () => {
  it('excludes full-page fallback boxes from the aggregate (spec-web §5)', () => {
    const { svc } = setup()
    const full_page = new Map<number, Box>([[0, { x0: 0, y0: 0, x1: 200, y1: 300 }]])   // 100% of page
    expect(svc.compute_union(full_page)).toBeNull()
  })

  it('anchors at the top-left min and sizes by the largest individual width/height (outlier=0)', () => {
    const { svc } = setup()
    const boxes = new Map<number, Box>([
      [0, { x0: 10, y0: 10, x1: 100, y1: 100 }],   // 90x90
      [1, { x0: 5, y0: 20, x1: 90, y1: 150 }],     // 85x130
    ])
    const union = svc.compute_union(boxes)
    // top-left = (min x0, min y0) = (5, 10); size = (largest width, largest height) = (90, 130)
    expect(union).toEqual({ x0: 5, y0: 10, x1: 95, y1: 140 })
  })
})
