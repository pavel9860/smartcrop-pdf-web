// Auto-detect union regression tests (spec §8, spec-web §W2 rows 5/13).
// 1. NORMAL-mode detection uses the PDF text-layer fast path (detect_text_box) when a usable text
//    layer exists — desktop parity with detect.py normal_page_box (spec-web §W2 row 13). It only
//    falls back to the ink path (detect_content_box) when there is no text layer.
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

// detect_content_box has no page argument; detect processes resolve_pages() ascending, so a
// call-order queue maps 1:1 onto page order for a single detect run.
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
    export_pdf:    () => Promise.resolve(new Uint8Array()),
    export_images: () => Promise.resolve(new Uint8Array()),
    make_synth_page: (_i, w, h) => Promise.resolve(make_bitmap(w, h)),
    close: (): void => { /* no-op */ },
  }
  return { adapter, calls }
}

describe('NORMAL-mode detection source (spec-web §W2 row 13)', () => {
  it('uses the PDF text-layer fast path when a usable text layer exists (desktop parity)', async () => {
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
    await model.detect_content().result()

    expect(text_calls.n).toBe(2)                    // text layer consulted for both NORMAL pages
    expect(calls['detect_content_box'] ?? 0).toBe(0) // ink path short-circuited (text layer sufficed)
    // §8 aggregate over the text-layer boxes: gL=20, gT=20, W=max(100,80), H=max(260,230)
    expect(model.document.union).toEqual({ x0: 20, y0: 20, x1: 120, y1: 280 })
  })

  it('falls back to the ink path when the text layer yields nothing', async () => {
    const sizes = [{ width: 200, height: 300 }, { width: 200, height: 300 }]
    const ink = [
      { x0: 20, y0: 20, x1: 120, y1: 280 },
      { x0: 30, y0: 30, x1: 110, y1: 260 },
    ]
    const { adapter, calls } = make_adapter(sizes, ink)
    const with_text: RendererAdapter & {
      detect_text_box?: (i: number) => Promise<Box | null>
    } = {
      ...adapter,
      detect_text_box: (): Promise<Box | null> => Promise.resolve(null),   // no usable text layer
    }
    const model = new AppModel(with_text)
    await model.load_files([FILE()])
    await model.detect_content().result()

    expect(calls['detect_content_box']).toBe(2)     // ink path used for every page
    expect(model.document.union).toEqual({ x0: 20, y0: 20, x1: 120, y1: 280 })
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
    await model.detect_content().result()
    // sanity: detect-time union excludes the fallback: gL=20 gT=20 W=100 H=260
    expect(model.document.union).toEqual({ x0: 20, y0: 20, x1: 120, y1: 280 })

    model.set_select_pattern('2')
    model.set_pages_mode(PagesMode.SELECT)
    model.rotate_pages()
    // p2's box rotates to {20,20,280,120} (260×100). Rebuild must still exclude p1's
    // fallback: gL=min(20,30) gT=min(20,30) W=max(260,80)=260 H=max(100,230)=230.
    expect(model.document.union).toEqual({ x0: 20, y0: 20, x1: 280, y1: 250 })
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
    await model.detect_content().result()
    // sanity: p3 excluded at detect time: gL=10 gT=10 W=max(100,100) H=max(260,200)
    expect(model.document.union).toEqual({ x0: 10, y0: 10, x1: 110, y1: 270 })

    model.set_select_pattern('1')
    model.set_pages_mode(PagesMode.SELECT)
    model.delete_pages()
    // Remaining pages: old p2 (400×300, box kept) and old p3 (200×300, box is a fallback and
    // must STAY excluded — judged vs its own reindexed dims, not a stale page map).
    expect(model.document.union).toEqual({ x0: 10, y0: 10, x1: 110, y1: 210 })
  })
})
