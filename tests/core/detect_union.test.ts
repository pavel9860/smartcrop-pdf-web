// Auto-detect union regression tests (spec-web §W2 rows 5/13).
// 1. NORMAL-mode detection uses the PDF text-layer fast path (detect_text_box) ONLY — no raster
//    fallback. A page with no usable text layer simply gets no detected box.
// 2. The union rebuilds after rotate/delete must keep the FULL_PAGE_FRAC exclusion and
//    judge each box against its OWN page's post-reindex dimensions.
import { describe, it, expect } from 'vitest'
import { AppModel, type RendererAdapter, type DocInfo, type PageSize } from '@core/model'
import { Mode, PagesMode } from '@core/enums'
import type { Box } from '@core/geometry'

function make_bitmap(w = 100, h = 100): ImageBitmap {
  return { width: w, height: h, close: (): void => { /* no-op */ } }
}

const FILE = (name = 'a.pdf'): File => new File(['x'], name, { type: 'application/pdf' })

// Neither detect_content_box nor detect_text_box takes a page argument; detect processes
// resolve_pages() ascending, so a call-order queue maps 1:1 onto page order for a single detect run.
function make_adapter(page_sizes: PageSize[], detect_boxes: Box[]): {
  adapter: RendererAdapter
  calls: Record<string, number>
} {
  const calls: Record<string, number> = {}
  const bump = (k: string): void => { calls[k] = (calls[k] ?? 0) + 1 }
  const queue = [...detect_boxes]
  const adapter: RendererAdapter = {
    load_files: (files: File[]): Promise<DocInfo> => Promise.resolve({
      page_count: page_sizes.length,
      page_sizes,
      file_names: files.map(f => f.name),
      mode: Mode.NORMAL,
    }),
    get_source_image: () => Promise.resolve(make_bitmap()),
    get_work_image:   () => Promise.resolve(make_bitmap()),
    render_output_image: (_s, box) => Promise.resolve(
      make_bitmap(Math.max(1, Math.round(box.x1 - box.x0)), Math.max(1, Math.round(box.y1 - box.y0)))),
    detect_content_box: () => {
      bump('detect_content_box')
      const b = queue.shift()
      if (!b) throw new Error('detect queue exhausted')
      return Promise.resolve(b)
    },
    // mode is always NORMAL here (below), so this is the path actually exercised by default —
    // detect_content_box above stays reachable only via explicit overrides for the ink-path-not-
    // called assertions.
    detect_text_box: () => {
      bump('detect_text_box')
      const b = queue.shift()
      if (!b) throw new Error('detect queue exhausted')
      return Promise.resolve(b)
    },
    export_pdf:    () => Promise.resolve(new Uint8Array()),
    export_images: () => Promise.resolve(new Uint8Array()),
    make_synth_page: (_i, w, h) => Promise.resolve(make_bitmap(w, h)),
    close: (): void => { /* no-op */ },
  }
  return { adapter, calls }
}

describe('NORMAL-mode detection source (spec-web §W2 row 13)', () => {
  it('uses the PDF text-layer fast path when a usable text layer exists', async () => {
    const sizes = [{ width: 200, height: 300 }, { width: 200, height: 300 }]
    // Ink boxes the adapter would return IF the image path were taken — used here only to prove it
    // is NOT taken (the text-layer path short-circuits before detect_content_box).
    const ink = [
      { x0: 0, y0: 0, x1: 5, y1: 5 },
      { x0: 0, y0: 0, x1: 5, y1: 5 },
    ]
    const { adapter, calls } = make_adapter(sizes, ink)
    // The text layer returns a real content box per page (keyed by page index).
    const text_boxes: Record<number, Box> = {
      0: { x0: 20, y0: 20, x1: 120, y1: 280 },   // 100×260
      1: { x0: 30, y0: 30, x1: 110, y1: 260 },   // 80×230
    }
    const text_calls = { n: 0 }
    const with_text: RendererAdapter & {
      detect_text_box?: (i: number) => Promise<Box | null>
    } = {
      ...adapter,
      detect_text_box: (i: number): Promise<Box | null> => {
        text_calls.n += 1
        return Promise.resolve(text_boxes[i] ?? null)
      },
    }
    const model = new AppModel(with_text)
    await model.load_files([FILE()])
    model.set_detect_outlier_pages(0)   // this test is about the text-layer path, not outlier tolerance
    await model.detect_content().result()

    expect(text_calls.n).toBe(2)                    // text layer consulted for both NORMAL pages
    expect(calls['detect_content_box'] ?? 0).toBe(0) // ink path never touched in NORMAL mode
    // §8 aggregate over the text-layer boxes: gL=20, gT=20, W=max(100,80), H=max(260,230)
    expect(model.union).toEqual({ x0: 20, y0: 20, x1: 120, y1: 280 })
  })

  it('never falls back to the ink path — a page with no usable text gets no detected box', async () => {
    const sizes = [{ width: 200, height: 300 }, { width: 200, height: 300 }]
    // Ink boxes the adapter would return IF a raster fallback existed — used here only to prove
    // it is NEVER called, even for the page whose text layer yields nothing.
    const ink = [
      { x0: 20, y0: 20, x1: 120, y1: 280 },
      { x0: 30, y0: 30, x1: 110, y1: 260 },
    ]
    const { adapter, calls } = make_adapter(sizes, ink)
    const text_boxes: Record<number, Box | null> = {
      0: { x0: 20, y0: 20, x1: 120, y1: 280 },   // 100×260
      1: null,                                    // no usable text layer on this page
    }
    const with_text: RendererAdapter & {
      detect_text_box?: (i: number) => Promise<Box | null>
    } = {
      ...adapter,
      detect_text_box: (i: number): Promise<Box | null> => Promise.resolve(text_boxes[i] ?? null),
    }
    const model = new AppModel(with_text)
    await model.load_files([FILE()])
    await model.detect_content().result()

    expect(calls['detect_content_box'] ?? 0).toBe(0) // ink path never used, not even as a fallback
    // Only page 0 contributed a box — union reflects that single box.
    expect(model.union).toEqual({ x0: 20, y0: 20, x1: 120, y1: 280 })
  })
})

describe('union rebuild keeps FULL_PAGE_FRAC exclusion (spec §8)', () => {
  it('rotate: a full-page fallback box stays out of the rebuilt union', async () => {
    const sizes = Array.from({ length: 3 }, () => ({ width: 200, height: 300 }))
    const boxes = [
      { x0: 0,  y0: 0,  x1: 200, y1: 300 },   // p1: full-page fallback (no text) — excluded
      { x0: 20, y0: 20, x1: 120, y1: 280 },   // p2: 100×260
      { x0: 30, y0: 30, x1: 110, y1: 260 },   // p3: 80×230
    ]
    const { adapter } = make_adapter(sizes, boxes)
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    model.set_detect_outlier_pages(0)   // this test is about FULL_PAGE_FRAC exclusion, not outlier tolerance
    await model.detect_content().result()
    // sanity: detect-time union excludes the fallback: gL=20 gT=20 W=100 H=260
    expect(model.union).toEqual({ x0: 20, y0: 20, x1: 120, y1: 280 })

    model.set_select_pattern('2')
    model.set_pages_mode(PagesMode.SELECT)
    model.rotate_pages()
    // p2's box rotates to {20,20,280,120} (260×100). Rebuild must still exclude p1's
    // fallback: gL=min(20,30) gT=min(20,30) W=max(260,80)=260 H=max(100,230)=230.
    expect(model.union).toEqual({ x0: 20, y0: 20, x1: 280, y1: 250 })
  })

  it('delete: exclusion is judged against the post-reindex page dimensions', async () => {
    const sizes = [
      { width: 200, height: 300 },
      { width: 400, height: 300 },
      { width: 200, height: 300 },
    ]
    const boxes = [
      { x0: 20, y0: 20, x1: 120, y1: 280 },   // p1 (deleted below)
      { x0: 10, y0: 10, x1: 110, y1: 210 },   // p2: 100×200 on 400×300 — kept
      { x0: 0,  y0: 0,  x1: 198, y1: 295 },   // p3: fallback for its OWN 200×300 page — excluded
    ]
    const { adapter } = make_adapter(sizes, boxes)
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    model.set_detect_outlier_pages(0)   // this test is about the post-reindex rebuild, not outlier tolerance
    await model.detect_content().result()
    // sanity: p3 excluded at detect time: gL=10 gT=10 W=max(100,100) H=max(260,200)
    expect(model.union).toEqual({ x0: 10, y0: 10, x1: 110, y1: 270 })

    model.set_select_pattern('1')
    model.set_pages_mode(PagesMode.SELECT)
    model.delete_pages()
    // Remaining pages: old p2 (400×300, box kept) and old p3 (200×300, box is a fallback and
    // must STAY excluded — judged vs its own reindexed dims, not a stale page map).
    expect(model.union).toEqual({ x0: 10, y0: 10, x1: 110, y1: 210 })
  })
})

describe('settings.detect_outlier_pages routes into the union (spec-web §5, #11)', () => {
  it('detect_content() applies the current outlier setting', async () => {
    const sizes = Array.from({ length: 3 }, () => ({ width: 300, height: 400 }))
    const boxes = [
      { x0: 0,  y0: 0,  x1: 200, y1: 100 },   // w=200 h=100
      { x0: 0,  y0: 0,  x1: 150, y1: 300 },   // w=150 h=300
      { x0: 0,  y0: 0,  x1: 50,  y1: 60 },    // w=50  h=60
    ]
    const { adapter } = make_adapter(sizes, boxes)
    const model = new AppModel(adapter)
    await model.load_files([FILE()])

    model.set_detect_outlier_pages(1)
    expect(model.detect_outlier_pages).toBe(1)
    await model.detect_content().result()
    // widths desc 200,150,50 -> 2nd = 150; heights desc 300,100,60 -> 2nd = 100
    expect(model.union).toEqual({ x0: 0, y0: 0, x1: 150, y1: 100 })
  })

  it('the same outlier setting applies to the rotate union rebuild (one shared aggregation path)', async () => {
    const sizes = Array.from({ length: 3 }, () => ({ width: 300, height: 400 }))
    const boxes = [
      { x0: 0, y0: 0, x1: 200, y1: 100 },   // w=200 h=100
      { x0: 0, y0: 0, x1: 150, y1: 300 },   // w=150 h=300
      { x0: 0, y0: 0, x1: 10,  y1: 180 },   // w=10  h=180
    ]
    const { adapter } = make_adapter(sizes, boxes)
    const model = new AppModel(adapter)
    await model.load_files([FILE()])
    model.set_detect_outlier_pages(1)
    await model.detect_content().result()
    // widths desc 200,150,10 -> 2nd=150; heights desc 300,180,100 -> 2nd=180
    expect(model.union).toEqual({ x0: 0, y0: 0, x1: 150, y1: 180 })

    model.set_select_pattern('3')
    model.set_pages_mode(PagesMode.SELECT)
    model.rotate_pages()
    // p3's box (w=10,h=180) rotates to (w=180,h=10) — a 90° box rotation always swaps width and
    // height. That changes BOTH 2nd-place picks: widths desc now 200,180,150 -> 2nd=180 (p3
    // overtakes p2); heights desc now 300,100,10 -> 2nd=100 (p1 overtakes the now-tiny p3).
    // Recomputing this correctly after rotate (not just carrying the old picks forward) is the
    // point of routing rotate's union rebuild through the same _compute_detection_union.
    expect(model.union).toEqual({ x0: 0, y0: 0, x1: 180, y1: 100 })
  })

  it('defaults to 5, not Off (bug #4)', () => {
    const model = new AppModel(make_adapter([{ width: 100, height: 100 }], [
      { x0: 0, y0: 0, x1: 10, y1: 10 },
    ]).adapter)
    expect(model.detect_outlier_pages).toBe(5)
  })

  it('set_detect_outlier_pages clamps to a non-negative integer', () => {
    const model = new AppModel(make_adapter([{ width: 100, height: 100 }], [
      { x0: 0, y0: 0, x1: 10, y1: 10 },
    ]).adapter)
    model.set_detect_outlier_pages(-5)
    expect(model.detect_outlier_pages).toBe(0)
    model.set_detect_outlier_pages(2.7)
    expect(model.detect_outlier_pages).toBe(3)
  })
})

describe('a page with no detected content still gets cropped, centered (bug #8/#9)', () => {
  it('Crop commits the shared union box, centered, for a page with no usable text layer', async () => {
    const sizes = [{ width: 200, height: 300 }, { width: 200, height: 300 }]
    const { adapter } = make_adapter(sizes, [])
    const text_boxes: Record<number, Box | null> = {
      0: { x0: 20, y0: 20, x1: 120, y1: 280 },   // page 0: 100×260, has content
      1: null,                                    // page 1: no usable text layer
    }
    const with_text: RendererAdapter & { detect_text_box?: (i: number) => Promise<Box | null> } = {
      ...adapter,
      detect_text_box: (i: number): Promise<Box | null> => Promise.resolve(text_boxes[i] ?? null),
    }
    const model = new AppModel(with_text)
    await model.load_files([FILE()])
    model.set_detect_outlier_pages(0)
    await model.detect_content().result()
    expect(model.union).toEqual({ x0: 20, y0: 20, x1: 120, y1: 280 })   // W=100, H=260, from page 0 only

    model.apply_crop()   // default selection = All

    expect(model.document.applied.has(0)).toBe(true)
    expect(model.document.applied.has(1)).toBe(true)   // was left uncropped before the fix

    const box1 = model.document.applied.get(1)![0]!
    // page 1 is 200×300; union W=100 H=260 -> centered: x0=(200-100)/2=50, y0=(300-260)/2=20
    expect(box1).toEqual({ x0: 50, y0: 20, x1: 150, y1: 280 })
  })

  it('the live preview overlay for a not-yet-committed no-content page shows the same centered box', async () => {
    const sizes = [{ width: 200, height: 300 }, { width: 200, height: 300 }]
    const { adapter } = make_adapter(sizes, [])
    const text_boxes: Record<number, Box | null> = {
      0: { x0: 20, y0: 20, x1: 120, y1: 280 },
      1: null,
    }
    const with_text: RendererAdapter & { detect_text_box?: (i: number) => Promise<Box | null> } = {
      ...adapter,
      detect_text_box: (i: number): Promise<Box | null> => Promise.resolve(text_boxes[i] ?? null),
    }
    const model = new AppModel(with_text)
    await model.load_files([FILE()])
    model.set_detect_outlier_pages(0)
    await model.detect_content().result()

    model.jump_to_output_page(2)   // page 1 (1-indexed view position)
    await model.prepare_current_view()
    const overlay = model.view_snapshot().overlay
    expect(overlay).toEqual([{ kind: 'auto', box: { x0: 50, y0: 20, x1: 150, y1: 280 } }])
  })

  it('turning both anchors off still leaves the no-content page uncropped (no anchor = no auto-crop at all)', async () => {
    const sizes = [{ width: 200, height: 300 }, { width: 200, height: 300 }]
    const { adapter } = make_adapter(sizes, [])
    const text_boxes: Record<number, Box | null> = { 0: { x0: 20, y0: 20, x1: 120, y1: 280 }, 1: null }
    const with_text: RendererAdapter & { detect_text_box?: (i: number) => Promise<Box | null> } = {
      ...adapter,
      detect_text_box: (i: number): Promise<Box | null> => Promise.resolve(text_boxes[i] ?? null),
    }
    const model = new AppModel(with_text)
    await model.load_files([FILE()])
    model.set_detect_outlier_pages(0)
    await model.detect_content().result()
    model.set_anchor(false, false)

    model.apply_crop()

    expect(model.document.applied.has(1)).toBe(false)
  })
})
