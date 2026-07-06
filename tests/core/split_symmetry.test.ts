// Same-size split v2 — DIRECTIONAL edge symmetry (spec-web §W2 row 10): windows keep their own
// positions; only the dragged window's per-edge deltas propagate, mirrored by grid parity, onto
// each partner's drag-start rectangle. Cancel restores every window (frozen §9.6).
// Also: split keep-ratio initial ratio = split CELL aspect (spec-web §W2 row 9).
// Page 200×300; grid order n=2 [left,right], n=4 [TL,BL,TR,BR].
import { describe, it, expect } from 'vitest'
import { AppModel, type RendererAdapter, type DocInfo } from '@core/model'
import { Mode } from '@core/enums'
import type { Box } from '@core/geometry'

function make_bitmap(w = 100, h = 100): ImageBitmap {
  return { width: w, height: h, close: (): void => { /* no-op */ } }
}

const FILE = (): File => new File(['x'], 'a.pdf', { type: 'application/pdf' })

function make_adapter(detect_boxes: Box[] = []): RendererAdapter {
  const queue = [...detect_boxes]
  return {
    load_files: (files: File[]): Promise<DocInfo> => Promise.resolve({
      page_count: 2,
      page_sizes: [{ width: 200, height: 300 }, { width: 200, height: 300 }],
      file_names: files.map(f => f.name),
      mode: Mode.NORMAL,
    }),
    get_source_image: () => Promise.resolve(make_bitmap()),
    get_work_image:   () => Promise.resolve(make_bitmap()),
    render_output_image: () => Promise.resolve(make_bitmap()),
    detect_content_box: () => {
      const b = queue.shift()
      if (!b) throw new Error('detect queue exhausted')
      return Promise.resolve(b)
    },
    export_pdf:    () => Promise.resolve(new Uint8Array()),
    export_images: () => Promise.resolve(new Uint8Array()),
    make_synth_page: (_i, w, h) => Promise.resolve(make_bitmap(w, h)),
    close: (): void => { /* no-op */ },
  }
}

async function split_model(n: 2 | 4, same_size = true): Promise<AppModel> {
  const model = new AppModel(make_adapter())
  await model.load_files([FILE()])
  model.set_split(n)
  model.set_same_size(same_size)
  return model
}

const TOL = 5
const drag = (m: AppModel, from: [number, number], to: [number, number]): void => {
  m.begin_drag(from[0], from[1], TOL)
  m.update_drag(to[0], to[1])
  m.end_drag()
}

describe('same-size 2-split: directional edge symmetry', () => {
  it('LEFT edge of the left window → RIGHT edge of the right window moves opposite; nothing else', async () => {
    const model = await split_model(2)
    model.begin_drag(0, 150, TOL)               // L handle of window[0] {0,0,100,300}
    model.update_drag(10, 150)                  // LIVE — assert before release
    expect(model.document.crop_rects[0]).toEqual({ x0: 10,  y0: 0, x1: 100, y1: 300 })
    expect(model.document.crop_rects[1]).toEqual({ x0: 100, y0: 0, x1: 190, y1: 300 })
    model.end_drag()
  })

  it('windows KEEP their own placement — deltas apply to the partner where it is (not v1 snapping)', async () => {
    const model = await split_model(2, false)
    drag(model, [150, 150], [140, 150])         // move window[1] to {90,0,190,300} first
    expect(model.document.crop_rects[1]).toEqual({ x0: 90, y0: 0, x1: 190, y1: 300 })
    model.set_same_size(true)
    model.begin_drag(50, 0, TOL)                // T handle of window[0]
    model.update_drag(50, 20)
    expect(model.document.crop_rects[0]).toEqual({ x0: 0,  y0: 20, x1: 100, y1: 300 })
    // partner: ΔT copies (same row), x untouched — stays at its own x0=90, no snap to 100
    expect(model.document.crop_rects[1]).toEqual({ x0: 90, y0: 20, x1: 190, y1: 300 })
    model.end_drag()
  })

  it('a MOVE propagates mirrored translation', async () => {
    const model = await split_model(2)
    model.begin_drag(50, 150, TOL)              // interior of window[0] → move
    model.update_drag(60, 150)                  // +10 in x
    expect(model.document.crop_rects[0]).toEqual({ x0: 10, y0: 0, x1: 110, y1: 300 })
    expect(model.document.crop_rects[1]).toEqual({ x0: 90, y0: 0, x1: 190, y1: 300 })
    model.end_drag()
  })

  it('windows may OVERLAP — no anti-overlap clamping', async () => {
    const model = await split_model(2)
    model.begin_drag(100, 150, TOL)             // R handle of window[0] (idx 0 wins the shared edge)
    model.update_drag(150, 150)
    expect(model.document.crop_rects[0]).toEqual({ x0: 0,  y0: 0, x1: 150, y1: 300 })
    expect(model.document.crop_rects[1]).toEqual({ x0: 50, y0: 0, x1: 200, y1: 300 })
    model.end_drag()
  })

  it('a partner pinned at the page border clamps independently', async () => {
    const model = await split_model(2, false)
    drag(model, [0, 150], [20, 150])            // window[0] → {20,0,100,300}
    model.set_same_size(true)
    model.begin_drag(20, 150, TOL)              // L handle of window[0] again
    model.update_drag(5, 150)                   // ΔL=−15 → partner ΔR′=+15, but x1 already 200
    expect(model.document.crop_rects[0]).toEqual({ x0: 5,   y0: 0, x1: 100, y1: 300 })
    expect(model.document.crop_rects[1]).toEqual({ x0: 100, y0: 0, x1: 200, y1: 300 })
    model.end_drag()
  })

  it('Esc/cancel during the drag restores EVERY window (frozen §9.6)', async () => {
    const model = await split_model(2)
    const before = model.document.crop_rects.map(r => ({ ...r }))
    model.begin_drag(0, 150, TOL)
    model.update_drag(30, 150)                  // both windows changed live
    model.cancel_drag()
    expect(model.document.crop_rects).toEqual(before)
  })
})

describe('same-size 4-split: column/row parity', () => {
  // Initial grid: [0]TL{0,0,100,150} [1]BL{0,150,100,300} [2]TR{100,0,200,150} [3]BR{100,150,200,300}
  it('TOP of TL → BL bottom opposite, TR top same, BR bottom opposite', async () => {
    const model = await split_model(4)
    model.begin_drag(50, 0, TOL)                // T handle of TL
    model.update_drag(50, 10)
    expect(model.document.crop_rects[0]).toEqual({ x0: 0,   y0: 10,  x1: 100, y1: 150 })
    expect(model.document.crop_rects[1]).toEqual({ x0: 0,   y0: 150, x1: 100, y1: 290 })
    expect(model.document.crop_rects[2]).toEqual({ x0: 100, y0: 10,  x1: 200, y1: 150 })
    expect(model.document.crop_rects[3]).toEqual({ x0: 100, y0: 150, x1: 200, y1: 290 })
    model.end_drag()
  })

  it('dragging a non-TL window (R edge of BR) propagates to all four', async () => {
    const model = await split_model(4)
    model.begin_drag(200, 225, TOL)             // R handle of BR
    model.update_drag(180, 225)                 // ΔR=−20
    expect(model.document.crop_rects[3]).toEqual({ x0: 100, y0: 150, x1: 180, y1: 300 })
    expect(model.document.crop_rects[1]).toEqual({ x0: 20,  y0: 150, x1: 100, y1: 300 })  // x-mirror
    expect(model.document.crop_rects[2]).toEqual({ x0: 100, y0: 0,   x1: 180, y1: 150 })  // y-mirror
    expect(model.document.crop_rects[0]).toEqual({ x0: 20,  y0: 0,   x1: 100, y1: 150 })  // both
    model.end_drag()
  })
})

describe('keep-ratio on splits (spec-web §W2 row 9)', () => {
  it('enabling keep-ratio at split 2 pre-populates the CELL aspect (w/2)/h', async () => {
    const model = await split_model(2, false)
    model.set_keep_ratio(true)
    expect(model.ratio).toBeCloseTo(100 / 300)  // page aspect would be 200/300
  })

  it('enabling keep-ratio at split 4 pre-populates (w/2)/(h/2)', async () => {
    const model = await split_model(4, false)
    model.set_keep_ratio(true)
    expect(model.ratio).toBeCloseTo(100 / 150)
  })

  it('the cell aspect wins over a cached detection union at split 2/4', async () => {
    const model = new AppModel(make_adapter([
      { x0: 20, y0: 20, x1: 120, y1: 280 },
      { x0: 20, y0: 20, x1: 120, y1: 280 },
    ]))
    await model.load_files([FILE()])
    await model.detect_content().result()       // union 100×260 at split 1
    model.set_split(2)
    model.set_keep_ratio(true)
    expect(model.ratio).toBeCloseTo(100 / 300)  // union aspect would be 100/260
  })

  it('keep-ratio holds live on the dragged window; partners receive the resulting deltas', async () => {
    const model = await split_model(2)
    model.set_keep_ratio(true, 0.5)
    model.begin_drag(200, 150, TOL)             // R handle of window[1]
    model.update_drag(180, 150)                 // w=80 → h=160 centred: {100,70,180,230}
    expect(model.document.crop_rects[1]).toEqual({ x0: 100, y0: 70, x1: 180, y1: 230 })
    expect(model.document.crop_rects[0]).toEqual({ x0: 20,  y0: 70, x1: 100, y1: 230 })
    model.end_drag()
  })
})
