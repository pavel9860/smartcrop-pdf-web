// AppModel gesture branch coverage: auto-drag (resize/move/cancel), split-drag (+same_size,
// +keep_ratio release), crop-edit resize, keep-ratio draw commit. Handle coordinates are read
// from the live overlay so the hit-tests are exact. Public interface only.
import { describe, it, expect } from 'vitest'
import { AppModel } from '@core/model'
import { clamp_edge_deltas, type Box, type EdgeDeltas } from '@core/geometry'
import { Mode, PagesMode } from '@core/enums'
import { EmptySelectionError } from '@core/errors'
import { make_adapter, FILE } from './harness'

async function loaded(pc = 4, mode = Mode.NORMAL, w = 200, h = 300): Promise<AppModel> {
  const m = new AppModel(make_adapter(pc, mode, w, h)); await m.load_files([FILE()]); return m
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

// Same-size RESIZE restored to directional edge symmetry (spec-web §W2 row 10, 2026-07-10): a
// per-window-independent-position design ("each anchored at its own corner", read literally from
// frozen §7.3) broke row/column visual alignment — a 2-split's two windows no longer shared a
// top/bottom edge, a 4-split's rows/columns drifted apart (bug #5). Page is 200x300 (loaded()'s
// default): 2-split -> [0]{0,0,100,300} [1]{100,0,200,300}; 4-split -> [0]TL{0,0,100,150}
// [1]BL{0,150,100,300} [2]TR{100,0,200,150} [3]BR{100,150,200,300}.
describe('same-size resize mirroring (2-split)', () => {
  it('LEFT edge of window0 moves the RIGHT edge of window1 the opposite direction', async () => {
    const m = await loaded()
    m.set_split(2); m.set_same_size(true)
    m.begin_drag(0, 150, 8)              // L handle of window0
    m.update_drag(10, 150)
    expect(m.document.crop_rects[0]).toEqual({ x0: 10, y0: 0, x1: 100, y1: 300 })
    expect(m.document.crop_rects[1]).toEqual({ x0: 100, y0: 0, x1: 190, y1: 300 })
    m.end_drag()
  })

  it('TOP edge of window0 moves window1\'s TOP the SAME direction (shared row)', async () => {
    const m = await loaded()
    m.set_split(2); m.set_same_size(true)
    m.begin_drag(50, 0, 8)                // T handle of window0
    m.update_drag(50, 20)
    expect(m.document.crop_rects[0]).toEqual({ x0: 0, y0: 20, x1: 100, y1: 300 })
    expect(m.document.crop_rects[1]).toEqual({ x0: 100, y0: 20, x1: 200, y1: 300 })
    m.end_drag()
  })

  it('a MOVE (interior drag) never propagates to the other window, even with same-size on', async () => {
    const m = await loaded()
    m.set_split(2); m.set_same_size(true)
    const before1 = { ...m.document.crop_rects[1] }
    m.begin_drag(50, 150, 8)              // interior of window0 -> move
    m.update_drag(60, 150)
    expect(m.document.crop_rects[0]).toEqual({ x0: 10, y0: 0, x1: 110, y1: 300 })
    expect(m.document.crop_rects[1]).toEqual(before1)   // untouched
    m.end_drag()
  })

  it('Esc/cancel during the drag restores every window (frozen §9.6)', async () => {
    const m = await loaded()
    m.set_split(2); m.set_same_size(true)
    const before = m.document.crop_rects.map(r => ({ ...r }))
    m.begin_drag(0, 150, 8)
    m.update_drag(30, 150)
    m.cancel_drag()
    expect(m.document.crop_rects).toEqual(before)
  })

  it('growth is capped at the tightest window\'s headroom instead of a partner deforming (bug #2)', async () => {
    const m = await loaded()
    m.set_split(2); m.set_same_size(true)
    // Move window0 (independent — a move never propagates) so it sits with only 120 of headroom
    // to the right edge, while window1 is dragged far enough on its own that, unclamped, it would
    // reach the full page width (200) — a naive per-window clamp would then leave window0 at 120
    // and window1 at 200: same-size broken. The fix caps BOTH at window0's tighter headroom.
    m.begin_drag(50, 150, 8)
    m.update_drag(130, 150)               // window0 -> {80,0,180,300}
    m.end_drag()
    expect(m.document.crop_rects[0]).toEqual({ x0: 80, y0: 0, x1: 180, y1: 300 })
    expect(m.document.crop_rects[1]).toEqual({ x0: 100, y0: 0, x1: 200, y1: 300 })

    m.begin_drag(100, 150, 8)             // L handle of window1
    m.update_drag(-50, 150)               // dragged far past what window1 alone could take
    const w0 = m.document.crop_rects[0]!, w1 = m.document.crop_rects[1]!
    expect(w1.x1 - w1.x0).toBeCloseTo(w0.x1 - w0.x0)   // still equal size — not deformed apart
    expect(w0.x1).toBeLessThanOrEqual(200)             // window0 never exceeds the page
    expect(w1.x0).toBeGreaterThanOrEqual(0)
    m.end_drag()
  })
})

describe('same-size resize mirroring (4-split)', () => {
  it('TOP of TL: BL bottom opposite, TR top same, BR bottom opposite', async () => {
    const m = await loaded()
    m.set_split(4); m.set_same_size(true)
    m.begin_drag(50, 0, 8)                // T handle of TL
    m.update_drag(50, 10)
    expect(m.document.crop_rects[0]).toEqual({ x0: 0,   y0: 10,  x1: 100, y1: 150 })
    expect(m.document.crop_rects[1]).toEqual({ x0: 0,   y0: 150, x1: 100, y1: 290 })
    expect(m.document.crop_rects[2]).toEqual({ x0: 100, y0: 10,  x1: 200, y1: 150 })
    expect(m.document.crop_rects[3]).toEqual({ x0: 100, y0: 150, x1: 200, y1: 290 })
    m.end_drag()
  })

  it('a MOVE of one 4-split window leaves the other three untouched', async () => {
    const m = await loaded()
    m.set_split(4); m.set_same_size(true)
    const before = m.document.crop_rects.slice(1).map(r => ({ ...r }))
    m.begin_drag(50, 75, 8)               // interior of TL -> move
    m.update_drag(60, 85)
    expect(m.document.crop_rects.slice(1)).toEqual(before)
    m.end_drag()
  })
})

describe('same-size toggle normalization (bug #2: same size at all times)', () => {
  it('turning Same-size ON immediately snaps every window to the first window\'s size', async () => {
    const m = await loaded()
    m.set_split(2)                        // same-size still off
    m.begin_drag(200, 150, 8)             // R handle of window1 (x=100 would ambiguously also hit
    m.update_drag(170, 150)               // window0's R handle, since the two windows share that edge)
    m.end_drag()
    expect(m.document.crop_rects[1]).toEqual({ x0: 100, y0: 0, x1: 170, y1: 300 })   // width 70, differs

    m.set_same_size(true)
    // window0 (first) is untouched at {0,0,100,300}; window1 SNAPS to that width, own origin kept.
    expect(m.document.crop_rects[0]).toEqual({ x0: 0,   y0: 0, x1: 100, y1: 300 })
    expect(m.document.crop_rects[1]).toEqual({ x0: 100, y0: 0, x1: 200, y1: 300 })
  })

  it('normalization caps to whatever fits every window\'s own origin, without moving it', async () => {
    const m = await loaded()
    m.set_split(2)                        // same-size still off
    m.begin_drag(100, 150, 8)             // R handle of window0
    m.update_drag(150, 150)               // window0 -> {0,0,150,300}
    m.end_drag()
    expect(m.document.crop_rects[0]).toEqual({ x0: 0, y0: 0, x1: 150, y1: 300 })

    m.set_same_size(true)
    // window1's own origin (x0=100) has only 100 of headroom to the page edge (200) — the shared
    // size is capped to THAT, not window0's 150; neither window's own origin moves.
    expect(m.document.crop_rects[0]).toEqual({ x0: 0,   y0: 0, x1: 100, y1: 300 })
    expect(m.document.crop_rects[1]).toEqual({ x0: 100, y0: 0, x1: 200, y1: 300 })
  })
})

// Pure geometry unit for the bug #2 cap, isolated from apply_handle_drag's own clamping so the
// bound is checked directly against each window's headroom, not incidentally.
describe('geometry.clamp_edge_deltas', () => {
  const rects0: Box[] = [{ x0: 0, y0: 0, x1: 100, y1: 300 }, { x0: 100, y0: 0, x1: 200, y1: 300 }]

  it('caps a same-column delta to the tightest window\'s own headroom', () => {
    const raw: EdgeDeltas = { dl: 0, dt: 0, dr: 150, db: 0 }   // window0 wants x1 = 250
    const out = clamp_edge_deltas(raw, rects0, [false, true], [false, false], 200, 300)
    expect(out.dr).toBe(100)   // both window0's own x1<=200 and mirrored window1's x0>=0 bound it to 100
    expect(out.dl).toBe(0)
  })

  it('a delta already within every window\'s headroom passes through unchanged', () => {
    const raw: EdgeDeltas = { dl: 5, dt: 5, dr: 20, db: -5 }
    const out = clamp_edge_deltas(raw, rects0, [false, true], [false, false], 200, 300)
    expect(out).toEqual(raw)
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

  it('set_filter_strength throws EmptySelectionError on an empty selection (M4)', async () => {
    const m = await loaded(4, Mode.SCANNED)
    m.set_select_pattern('999'); m.set_pages_mode(PagesMode.SELECT)
    expect(() => { m.set_filter_strength(2) }).toThrow(EmptySelectionError)
  })
})
