// AppModel gesture branch coverage: auto-drag (resize/move/cancel), split-drag (+same_size,
// +keep_ratio release), crop-edit resize, keep-ratio draw commit. Handle coordinates are read
// from the live overlay so the hit-tests are exact. Public interface only.
import { describe, it, expect } from 'vitest'
import { AppModel, type RendererAdapter, type DocInfo } from '@core/model'
import type { Box } from '@core/geometry'
import { Mode, PagesMode } from '@core/enums'

function bmp(w = 100, h = 100): ImageBitmap { return { width: w, height: h, close: (): void => {} } }
function adapter(pc = 4, mode = Mode.NORMAL, w = 200, h = 300): RendererAdapter {
  return {
    load_files: (f: File[]): Promise<DocInfo> => Promise.resolve({
      page_count: pc, page_sizes: Array.from({ length: pc }, () => ({ width: w, height: h })),
      file_names: f.map(x => x.name), mode }),
    get_source_image: () => Promise.resolve(bmp(w, h)),
    get_work_image: () => Promise.resolve(bmp(w, h)),
    render_output_image: (_s, b) => Promise.resolve(bmp(Math.max(1, Math.round(b.x1 - b.x0)), Math.max(1, Math.round(b.y1 - b.y0)))),
    detect_content_box: (_i, pw, ph) => Promise.resolve({ x0: 20, y0: 20, x1: pw - 20, y1: ph - 20 }),
    export_pdf: () => Promise.resolve(new Uint8Array([1])),
    export_images: () => Promise.resolve(new Uint8Array([4])),
    make_synth_page: (_i, w2, h2) => Promise.resolve(bmp(w2, h2)),
    close: (): void => {},
  }
}
const FILE = (): File => new File(['x'], 'a.pdf', { type: 'application/pdf' })
async function loaded(pc = 4, mode = Mode.NORMAL, w = 200, h = 300): Promise<AppModel> {
  const m = new AppModel(adapter(pc, mode, w, h)); await m.load_files([FILE()]); return m
}
function overlay_box(m: AppModel, kind: string): Box {
  const o = m.view_snapshot().overlay.find(x => x.kind === kind)
  if (!o) throw new Error(`no ${kind} overlay`)
  return o.box
}

describe('auto-drag', () => {
  it('resizes via a corner handle and keeps auto active', async () => {
    const m = await loaded()
    await m.detect_content().result()
    const b = overlay_box(m, 'auto')
    m.begin_drag(b.x0, b.y0, 8)
    m.update_drag(b.x0 + 15, b.y0 + 15)
    m.end_drag()
    expect(m.auto_active).toBe(true)
  })

  it('moves via the interior handle', async () => {
    const m = await loaded()
    await m.detect_content().result()
    const b = overlay_box(m, 'auto')
    m.begin_drag((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, 8)
    m.update_drag((b.x0 + b.x1) / 2 + 10, (b.y0 + b.y1) / 2 + 10)
    m.end_drag()
    expect(m.auto_active).toBe(true)
  })

  it('cancel restores the offsets captured at drag start', async () => {
    const m = await loaded()
    await m.detect_content().result()
    const before = m.offsets
    const b = overlay_box(m, 'auto')
    m.begin_drag(b.x0, b.y0, 8)
    m.update_drag(b.x0 + 30, b.y0 + 30)
    m.cancel_drag()
    expect(m.offsets).toEqual(before)
  })
})

describe('split-drag', () => {
  it('resizes one rect and same_size propagates the shape', async () => {
    const m = await loaded()
    m.set_split(2)
    m.set_same_size(true)
    const r = overlay_box(m, 'split')
    m.begin_drag(r.x0, r.y0, 8)
    m.update_drag(r.x0 + 5, r.y0 + 5)
    m.end_drag()
    expect(m.view_snapshot().overlay).toHaveLength(2)
    expect(m.can_apply).toBe(true)
  })

  it('keep-ratio snaps split rects on release', async () => {
    const m = await loaded()
    m.set_split(2)
    m.set_keep_ratio(true, 1.5)
    const r = overlay_box(m, 'split')
    m.begin_drag(r.x0, r.y0, 8)
    m.update_drag(r.x0 + 8, r.y0 + 8)
    m.end_drag()
    expect(m.view_snapshot().overlay).toHaveLength(2)
  })
})

describe('crop-edit drag', () => {
  it('resizes a committed box and commits the new geometry', async () => {
    const m = await loaded(4, Mode.NORMAL, 200, 300)
    m.begin_drag(10, 10, 5); m.update_drag(150, 250); m.end_drag()   // commit {10,10,150,250}
    const before = overlay_box(m, 'committed')
    m.begin_drag(before.x1, before.y1, 6)                            // BR handle
    m.update_drag(before.x1 - 20, before.y1 - 20)
    m.end_drag()
    const after = overlay_box(m, 'committed')
    expect(after).not.toEqual(before)
  })

  it('keep-ratio applies during a committed-box edit', async () => {
    const m = await loaded(4, Mode.NORMAL, 200, 300)
    m.begin_drag(10, 10, 5); m.update_drag(150, 250); m.end_drag()
    m.set_keep_ratio(true, 1.0)
    const b = overlay_box(m, 'committed')
    m.begin_drag(b.x1, b.y1, 6)
    m.update_drag(b.x1 + 20, b.y1 + 20)
    m.end_drag()
    expect(m.view_snapshot().overlay.some(o => o.kind === 'committed')).toBe(true)
  })
})

// Committed-page (split=1) crop-window behavior (frozen spec §9.3, batch C tasks 6-8): a committed
// page stays zoomed to its crop; a drag draws a NEW window OVER the cropped view (never flips back
// to the full page); the committed crop itself is not a drag target; only Crop commits.
describe('committed-page draw (spec §9.3)', () => {
  // Draw a window then commit it → the page is shown cropped to that box.
  async function committed(mode = Mode.NORMAL): Promise<AppModel> {
    const m = await loaded(4, mode, 200, 300)
    m.begin_drag(10, 10, 5); m.update_drag(150, 250); m.end_drag()   // draw {10,10,150,250}
    m.apply_crop()                                                   // Crop commits it to applied
    return m
  }

  it('committed page exposes crop_origin at the box top-left and crop dims', async () => {
    const m = await committed()
    await m.prepare_current_view()
    const s = m.view_snapshot()
    expect(s.crop_origin).toEqual({ x: 10, y: 10 })
    expect([s.page_w, s.page_h]).toEqual([140, 240])
    expect(s.image).not.toBeNull()          // cropped output bitmap rendered, not "loading"
  })

  it('a full page reports crop_origin {0,0}', async () => {
    const m = await loaded(4, Mode.NORMAL, 200, 300)
    const s = m.view_snapshot()
    expect(s.crop_origin).toEqual({ x: 0, y: 0 })
    expect([s.page_w, s.page_h]).toEqual([200, 300])
  })

  it('drawing on a committed page stays cropped and shows the window over it (no flip to full page)', async () => {
    const m = await committed()
    m.begin_drag(30, 40, 5); m.update_drag(120, 200); m.end_drag()
    const s = m.view_snapshot()
    expect([s.page_w, s.page_h]).toEqual([140, 240])   // STILL the committed crop, not 200×300
    expect(s.crop_origin).toEqual({ x: 10, y: 10 })
    const win = s.overlay.find(o => o.kind === 'committed')
    expect(win?.box).toEqual({ x0: 30, y0: 40, x1: 120, y1: 200 })  // drawn window over the crop
  })

  it('only Crop commits — a draw does not change applied (crop dims unchanged until Crop)', async () => {
    const m = await committed()
    m.begin_drag(30, 40, 5); m.update_drag(120, 200); m.end_drag()
    expect([m.view_snapshot().page_w, m.view_snapshot().page_h]).toEqual([140, 240])
    m.apply_crop()                                     // now commit the drawn window
    await m.prepare_current_view()
    expect([m.view_snapshot().page_w, m.view_snapshot().page_h]).toEqual([90, 160])
  })

  it('the committed crop is not a drag target — a grab at its corner draws, never resizes applied', async () => {
    const m = await committed()
    m.begin_drag(150, 250, 6); m.update_drag(140, 240); m.end_drag()   // at the crop corner
    expect([m.view_snapshot().page_w, m.view_snapshot().page_h]).toEqual([140, 240])  // applied intact
  })

  it('Esc / right-click mid-draw drops the window but leaves the committed crop', async () => {
    const m = await committed()
    m.begin_drag(30, 40, 5); m.update_drag(120, 200)
    m.cancel_drag()
    const s = m.view_snapshot()
    expect([s.page_w, s.page_h]).toEqual([140, 240])   // crop intact
    expect(s.overlay).toHaveLength(0)                  // drawn window gone, no outline
  })

  it('a sub-2·MIN_RECT draw on a committed page is a no-op', async () => {
    const m = await committed()
    m.begin_drag(60, 60, 5); m.update_drag(62, 62); m.end_drag()
    const s = m.view_snapshot()
    expect([s.page_w, s.page_h]).toEqual([140, 240])
    expect(s.overlay).toHaveLength(0)                  // discarded, no window
  })

  it('cross-mode (task 7): the same sequence yields identical geometry in NORMAL and SCANNED', async () => {
    const run = async (mode: Mode): Promise<{ o: { x: number; y: number }; w: number; h: number; box: Box | undefined }> => {
      const m = await committed(mode)
      m.begin_drag(30, 40, 5); m.update_drag(120, 200); m.end_drag()
      const s = m.view_snapshot()
      return { o: s.crop_origin, w: s.page_w, h: s.page_h, box: s.overlay.find(x => x.kind === 'committed')?.box }
    }
    const a = await run(Mode.NORMAL)
    const b = await run(Mode.SCANNED)
    expect(a).toEqual(b)
  })

  it('permutability (task 8): draw→Crop and Crop-committed→draw→Crop reach the same tightened crop', async () => {
    // Path 1: draw a tighter window on the committed page, then Crop.
    const m1 = await committed()
    m1.begin_drag(30, 40, 5); m1.update_drag(120, 200); m1.end_drag()
    m1.apply_crop(); await m1.prepare_current_view()
    // Path 2: draw the final box directly on a fresh page, then Crop (no intermediate commit).
    const m2 = await loaded(4, Mode.NORMAL, 200, 300)
    m2.begin_drag(30, 40, 5); m2.update_drag(120, 200); m2.end_drag()
    m2.apply_crop(); await m2.prepare_current_view()
    expect([m1.view_snapshot().page_w, m1.view_snapshot().page_h])
      .toEqual([m2.view_snapshot().page_w, m2.view_snapshot().page_h])
  })
})

describe('draw with keep-ratio + misc', () => {
  it('a keep-ratio draw commits a ratio-normalised box', async () => {
    const m = await loaded(4, Mode.NORMAL, 200, 300)
    m.set_keep_ratio(true, 2.0)
    m.begin_drag(10, 10, 5); m.update_drag(150, 250); m.end_drag()
    const b = overlay_box(m, 'committed')
    expect((b.x1 - b.x0) / (b.y1 - b.y0)).toBeCloseTo(2.0, 1)
  })

  it('set_split to the same count is a no-op', async () => {
    const m = await loaded()
    m.set_split(2)
    m.set_split(2)
    expect(m.split_count).toBe(2)
  })

  it('set_keep_ratio with an explicit positive ratio overrides pre-populate', async () => {
    const m = await loaded()
    m.set_keep_ratio(true, 1.75)
    expect(m.ratio).toBeCloseTo(1.75, 5)
  })

  it('set_offset writes each edge', async () => {
    const m = await loaded()
    m.set_offset('L', 5); m.set_offset('T', 6)
    expect(m.offsets.left).toBeCloseTo(5, 5)
    expect(m.offsets.top).toBeCloseTo(6, 5)
  })

  it('filter strength on an empty selection still completes', async () => {
    const m = await loaded(4, Mode.SCANNED)
    m.set_select_pattern('999'); m.set_pages_mode(PagesMode.SELECT)
    expect(() => { m.set_filter_strength(2) }).not.toThrow()
    expect(m.filter_strength).toBe(2)
  })
})
