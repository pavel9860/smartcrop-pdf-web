// Same-size split = LIVE mirror symmetry about the page centre line(s), and split keep-ratio
// initial ratio = split CELL aspect (spec-web §W2 rows 9 and 11).
// Page 200×300 → centre lines x=100, y=150; grid order n=2 [left,right], n=4 [TL,BL,TR,BR].
import { describe, it, expect } from 'vitest'
import { AppModel, type RendererAdapter, type DocInfo } from '@core/model'
import { Mode } from '@core/enums'
import { mirror_x, mirror_y, type Box } from '@core/geometry'

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

describe('geometry.mirror_x / mirror_y', () => {
  const b: Box = { x0: 10, y0: 20, x1: 60, y1: 120 }
  it('mirror_x reflects about x = page_w/2 and is an involution', () => {
    expect(mirror_x(b, 200)).toEqual({ x0: 140, y0: 20, x1: 190, y1: 120 })
    expect(mirror_x(mirror_x(b, 200), 200)).toEqual(b)
  })
  it('mirror_y reflects about y = page_h/2 and is an involution', () => {
    expect(mirror_y(b, 300)).toEqual({ x0: 10, y0: 180, x1: 60, y1: 280 })
    expect(mirror_y(mirror_y(b, 300), 300)).toEqual(b)
  })
})

describe('same-size 2-split: mirror about x = page_w/2 (spec-web §W2 row 11)', () => {
  it('dragging the LEFT edge of the left window moves the RIGHT edge of the right window opposite', async () => {
    const model = await split_model(2)
    model.begin_drag(0, 150, TOL)          // L handle of window[0] {0,0,100,300}
    model.update_drag(10, 150)             // LIVE — assert before release
    expect(model.document.crop_rects[0]).toEqual({ x0: 10, y0: 0, x1: 100, y1: 300 })
    expect(model.document.crop_rects[1]).toEqual({ x0: 100, y0: 0, x1: 190, y1: 300 })
    model.end_drag()
  })

  it('dragging the TOP edge of the left window moves the right window TOP the same direction', async () => {
    const model = await split_model(2)
    model.begin_drag(50, 0, TOL)           // T handle of window[0]
    model.update_drag(50, 20)
    expect(model.document.crop_rects[0]).toEqual({ x0: 0, y0: 20, x1: 100, y1: 300 })
    expect(model.document.crop_rects[1]).toEqual({ x0: 100, y0: 20, x1: 200, y1: 300 })
    model.end_drag()
  })

  it('dragging the RIGHT window mirrors back onto the LEFT window (master mapped to TL frame)', async () => {
    const model = await split_model(2)
    model.begin_drag(200, 150, TOL)        // R handle of window[1] {100,0,200,300}
    model.update_drag(180, 150)
    expect(model.document.crop_rects[1]).toEqual({ x0: 100, y0: 0, x1: 180, y1: 300 })
    expect(model.document.crop_rects[0]).toEqual({ x0: 20, y0: 0, x1: 100, y1: 300 })
    model.end_drag()
  })

  it('a MOVE translates the partner window mirrored', async () => {
    const model = await split_model(2)
    model.begin_drag(50, 150, TOL)         // interior of window[0] → move
    model.update_drag(60, 150)             // +10 in x
    expect(model.document.crop_rects[0]).toEqual({ x0: 10, y0: 0, x1: 110, y1: 300 })
    expect(model.document.crop_rects[1]).toEqual({ x0: 90, y0: 0, x1: 190, y1: 300 })
    model.end_drag()
  })

  it('windows may OVERLAP — symmetry is the only constraint', async () => {
    const model = await split_model(2)
    model.begin_drag(100, 150, TOL)        // R handle of window[0] (idx 0 wins the shared edge)
    model.update_drag(150, 150)            // pull past the centre line
    expect(model.document.crop_rects[0]).toEqual({ x0: 0, y0: 0, x1: 150, y1: 300 })
    expect(model.document.crop_rects[1]).toEqual({ x0: 50, y0: 0, x1: 200, y1: 300 })
    model.end_drag()
  })
})

describe('same-size 4-split: mirror about both centre lines', () => {
  // Initial grid: [0]TL{0,0,100,150} [1]BL{0,150,100,300} [2]TR{100,0,200,150} [3]BR{100,150,200,300}
  it('dragging TOP of TL moves BL BOTTOM opposite, TR TOP the same, BR BOTTOM opposite', async () => {
    const model = await split_model(4)
    model.begin_drag(50, 0, TOL)           // T handle of TL
    model.update_drag(50, 10)
    expect(model.document.crop_rects[0]).toEqual({ x0: 0,   y0: 10,  x1: 100, y1: 150 })
    expect(model.document.crop_rects[1]).toEqual({ x0: 0,   y0: 150, x1: 100, y1: 290 })
    expect(model.document.crop_rects[2]).toEqual({ x0: 100, y0: 10,  x1: 200, y1: 150 })
    expect(model.document.crop_rects[3]).toEqual({ x0: 100, y0: 150, x1: 200, y1: 290 })
    model.end_drag()
  })

  it('dragging LEFT of TL moves TR RIGHT edge opposite', async () => {
    const model = await split_model(4)
    model.begin_drag(0, 75, TOL)           // L handle of TL
    model.update_drag(10, 75)
    expect(model.document.crop_rects[0]).toEqual({ x0: 10,  y0: 0,   x1: 100, y1: 150 })
    expect(model.document.crop_rects[2]).toEqual({ x0: 100, y0: 0,   x1: 190, y1: 150 })
    expect(model.document.crop_rects[1]).toEqual({ x0: 10,  y0: 150, x1: 100, y1: 300 })
    expect(model.document.crop_rects[3]).toEqual({ x0: 100, y0: 150, x1: 190, y1: 300 })
    model.end_drag()
  })

  it('dragging a non-TL window (BR) maps through the TL master onto all four', async () => {
    const model = await split_model(4)
    model.begin_drag(200, 225, TOL)        // R handle of BR {100,150,200,300}
    model.update_drag(180, 225)
    expect(model.document.crop_rects[3]).toEqual({ x0: 100, y0: 150, x1: 180, y1: 300 })
    expect(model.document.crop_rects[0]).toEqual({ x0: 20,  y0: 0,   x1: 100, y1: 150 })
    expect(model.document.crop_rects[1]).toEqual({ x0: 20,  y0: 150, x1: 100, y1: 300 })
    expect(model.document.crop_rects[2]).toEqual({ x0: 100, y0: 0,   x1: 180, y1: 150 })
    model.end_drag()
  })
})

describe('keep-ratio on splits (spec-web §W2 row 9)', () => {
  it('enabling keep-ratio at split 2 pre-populates the CELL aspect (w/2)/h, not the page aspect', async () => {
    const model = await split_model(2, false)
    model.set_keep_ratio(true)
    expect(model.ratio).toBeCloseTo(100 / 300)   // page aspect would be 200/300
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
    await model.detect_content().result()        // union 100×260 at split 1
    model.set_split(2)
    model.set_keep_ratio(true)
    expect(model.ratio).toBeCloseTo(100 / 300)   // union aspect would be 100/260
  })

  it('keep-ratio holds LIVE on the dragged split window and its mirrors', async () => {
    const model = await split_model(2)
    model.set_keep_ratio(true, 0.5)
    model.begin_drag(200, 150, TOL)        // R handle of window[1]
    model.update_drag(180, 150)            // w=80 → h=160, centred about y=150
    expect(model.document.crop_rects[1]).toEqual({ x0: 100, y0: 70, x1: 180, y1: 230 })
    expect(model.document.crop_rects[0]).toEqual({ x0: 20,  y0: 70, x1: 100, y1: 230 })
    model.end_drag()
  })
})
