// Pure geometry (spec-web §5, §6, §12): seeded invariants over random boxes, plus the examples
// that pin down each function's own convention.
import { describe, it, expect } from 'vitest'
import {
  hit_handle, clamp_box_shift, apply_handle_drag, auto_crop_rect, centered_crop_rect, offsets_from_rect,
  drawn_offset_rect, offsets_from_drawn_rect, detection_union, union_box, keep_ratio_normalise,
  keep_ratio_anchored, rotate_box_cw, rotate_box_ccw, to_native_frame, clamp_edge_deltas, split_rects_grid,
  box_width as bw, box_height as bh, MIN_RECT, type Box, type HandleId,
} from '@core/geometry'
import type { Offsets } from '@core/document_state'
import { rng } from './harness'

const box = (x0: number, y0: number, x1: number, y1: number): Box => ({ x0, y0, x1, y1 })
const ZERO: Offsets = { left: 0, top: 0, right: 0, bottom: 0 }
const HANDLES: HandleId[] = ['TL', 'TR', 'BL', 'BR', 'T', 'B', 'L', 'R', 'move']
const EPS = 1e-9
const N = 2000

// A random page and a box inside it at least MIN_RECT on each side — the state every gesture starts from.
function scene(r: () => number): { W: number; H: number; b: Box } {
  const W = 50 + r() * 1000, H = 50 + r() * 1000
  const x0 = r() * (W - MIN_RECT), y0 = r() * (H - MIN_RECT)
  return { W, H, b: box(x0, y0, x0 + MIN_RECT + r() * (W - x0 - MIN_RECT), y0 + MIN_RECT + r() * (H - y0 - MIN_RECT)) }
}
const inside = (b: Box, W: number, H: number): boolean =>
  b.x0 >= -EPS && b.y0 >= -EPS && b.x1 <= W + EPS && b.y1 <= H + EPS
const close_to = (a: Box, b: Box, eps = 1e-6): boolean =>
  Math.abs(a.x0 - b.x0) < eps && Math.abs(a.y0 - b.y0) < eps && Math.abs(a.x1 - b.x1) < eps && Math.abs(a.y1 - b.y1) < eps

function forall(name: string, check: (r: () => number) => string | null): void {
  it(`${name} (${N} seeded cases)`, () => {
    const fails: string[] = []
    for (let seed = 1; seed <= N && fails.length < 3; seed++) {
      const msg = check(rng(seed))
      if (msg) fails.push(`seed ${seed}: ${msg}`)
    }
    expect(fails).toEqual([])
  })
}

describe('invariants', () => {
  forall('clamp_box_shift keeps a box on the page at min(size, page) without moving more than needed', r => {
    const W = 50 + r() * 500, H = 50 + r() * 500
    const x0 = -300 + r() * 900, y0 = -300 + r() * 900
    const b = box(x0, y0, x0 + r() * 800, y0 + r() * 800)
    const c = clamp_box_shift(b, W, H)
    const ok = inside(c, W, H) && Math.abs(bw(c) - Math.min(bw(b), W)) < 1e-6 && Math.abs(bh(c) - Math.min(bh(b), H)) < 1e-6
      && (!inside(b, W, H) || close_to(b, c))
    return ok ? null : `${JSON.stringify(b)} on ${W}x${H} -> ${JSON.stringify(c)}`
  })

  forall('a handle drag stays on the page, never below MIN_RECT, and never moves an undragged edge', r => {
    const { W, H, b } = scene(r)
    const h = HANDLES[Math.floor(r() * HANDLES.length)]!
    const c = apply_handle_drag(h, b, [0, 0], [(r() - 0.5) * 3 * W, (r() - 0.5) * 3 * H], W, H)
    const fixed = h === 'move' ? [] : (['x0', 'y0', 'x1', 'y1'] as const).filter(k =>
      !({ x0: /L/, y0: /T/, x1: /R/, y1: /B/ })[k].test(h))
    const ok = inside(c, W, H) && bw(c) >= MIN_RECT - 1e-6 && bh(c) >= MIN_RECT - 1e-6
      && fixed.every(k => c[k] === b[k]) && (h !== 'move' || (Math.abs(bw(c) - bw(b)) < 1e-6 && Math.abs(bh(c) - bh(b)) < 1e-6))
    return ok ? null : `${h} ${JSON.stringify(b)} on ${W}x${H} -> ${JSON.stringify(c)}`
  })

  forall('keep_ratio_anchored holds the ratio inside the page, anchored opposite the dragged handle', r => {
    const { W, H, b } = scene(r)
    const ratio = 0.25 + r() * 4
    const h = HANDLES[Math.floor(r() * HANDLES.length)]!
    const c = keep_ratio_anchored(b, ratio, h, W, H)
    if (!inside(c, W, H)) return `${h} left the page: ${JSON.stringify(c)}`
    if (h === 'move') return close_to(c, b) ? null : 'move changed the box'
    if (Math.min(bw(c), bh(c)) > MIN_RECT + 1e-6 && Math.abs(bw(c) / bh(c) - ratio) > 1e-6) return `${h} ratio ${bw(c) / bh(c)} != ${ratio}`
    const anchor = { TL: ['x1', 'y1'], TR: ['x0', 'y1'], BL: ['x1', 'y0'], BR: ['x0', 'y0'], T: ['y1'], B: ['y0'], L: ['x1'], R: ['x0'] }[h] as (keyof Box)[]
    return anchor.every(k => Math.abs(c[k] - b[k]) < 1e-6) ? null : `${h} moved its anchor: ${JSON.stringify(b)} -> ${JSON.stringify(c)}`
  })

  forall('keep_ratio_normalise holds the ratio from the top-left corner, inside the page', r => {
    const { W, H, b } = scene(r)
    const ratio = 0.25 + r() * 4
    const c = keep_ratio_normalise(b, ratio, W, H)
    const ok = inside(c, W, H) && c.x0 === b.x0 && c.y0 === b.y0 && Math.abs(bw(c) / bh(c) - ratio) < 1e-6
    return ok ? null : `${JSON.stringify(b)} r=${ratio} -> ${JSON.stringify(c)}`
  })

  forall('rotate cw/ccw invert each other, four cw steps are the identity, to_native_frame undoes k steps', r => {
    const { W, H, b } = scene(r)
    let cur = b, w = W, h = H
    for (let k = 1; k <= 4; k++) {
      const prev = cur
      cur = rotate_box_cw(cur, h); [w, h] = [h, w]
      if (!inside(cur, w, h)) return `rotated box left the page at step ${k}`
      if (!close_to(rotate_box_ccw(cur, w), prev)) return `ccw does not undo cw at step ${k}`
      if (!close_to(to_native_frame(cur, w, h, k * 90), b)) return `to_native_frame at ${k * 90}`
    }
    return close_to(cur, b) && close_to(to_native_frame(b, W, H, -360), b) ? null : 'four rotations changed the box'
  })

  forall('auto_crop_rect and offsets_from_rect invert each other while the frame stays on the page', r => {
    const W = 400 + r() * 600, H = 400 + r() * 600
    const ux = 50 + r() * 100, uy = 50 + r() * 100
    const union = box(ux, uy, ux + 100 + r() * 200, uy + 100 + r() * 200)
    const dx = ux + r() * 50, dy = uy + r() * 50
    const detected = box(dx, dy, dx + 50, dy + 50)
    const o: Offsets = { left: r() * 5, top: r() * 5, right: r() * 5 - 2, bottom: r() * 5 - 2 }
    const [al, at] = [r() < 0.5, r() < 0.5]
    const rect = auto_crop_rect(detected, union, o, W, H, al, at)
    if (rect.x0 <= 0 || rect.y0 <= 0 || rect.x1 >= W || rect.y1 >= H) return null
    const back = offsets_from_rect(rect, detected, union, W, H, al, at)
    const ok = (['left', 'top', 'right', 'bottom'] as const).every(k => Math.abs(back[k] - o[k]) < 1e-9)
    return ok ? null : `${JSON.stringify(o)} -> ${JSON.stringify(back)}`
  })

  forall('drawn-window edge fields and the drawn rectangle convert both ways', r => {
    const { W, H, b } = scene(r)
    return close_to(drawn_offset_rect(offsets_from_drawn_rect(b, W, H), W, H), b) ? null : JSON.stringify(b)
  })

  forall('detection_union anchors at the min corner and sizes by the (outlier+1)-th largest width/height', r => {
    const n = 1 + Math.floor(r() * 8), k = Math.floor(r() * 10)
    const boxes = Array.from({ length: n }, () => { const x = r() * 100, y = r() * 100; return box(x, y, x + 1 + r() * 300, y + 1 + r() * 300) })
    const u = detection_union(boxes, k)
    const nth = (v: number[]): number => v.sort((a, c) => c - a)[Math.min(k, n - 1)]!
    const ok = u.x0 === Math.min(...boxes.map(b => b.x0)) && u.y0 === Math.min(...boxes.map(b => b.y0))
      && Math.abs(bw(u) - nth(boxes.map(bw))) < 1e-9 && Math.abs(bh(u) - nth(boxes.map(bh))) < 1e-9
    return ok ? null : JSON.stringify({ boxes, k, u })
  })

  forall('split grids tile the page exactly', r => {
    const W = 1 + r() * 1000, H = 1 + r() * 1000
    for (const n of [1, 2, 4] as const) {
      const g = split_rects_grid(n, W, H)
      const area = g.reduce((s, b) => s + bw(b) * bh(b), 0)
      if (g.length !== n || Math.abs(area - W * H) > 1e-6 || !close_to(union_box(g), box(0, 0, W, H))) return `n=${n} on ${W}x${H}`
    }
    return null
  })
})

describe('conventions', () => {
  it('hit_handle: corners before edge midpoints before interior, within the tolerance only', () => {
    const b = box(100, 100, 200, 200)
    const at = (pts: [number, number][], tol = 5): (HandleId | null)[] => pts.map(([x, y]) => hit_handle(b, x, y, tol))
    expect(at([[100, 100], [200, 100], [100, 200], [200, 200], [150, 100], [150, 200], [100, 150], [200, 150], [150, 150], [500, 500]]))
      .toEqual(['TL', 'TR', 'BL', 'BR', 'T', 'B', 'L', 'R', 'move', null])
    expect(at([[104, 100], [106, 100]])).toEqual(['TL', 'move'])
    expect(hit_handle(box(0, 0, 8, 8), 4, 0, 5)).toBe('TL')
  })

  it('auto_crop_rect: an anchored axis starts at the page content edge, an unanchored one at the union edge; size is the union\'s', () => {
    const union = box(10, 10, 110, 60), detected = box(30, 5, 999, 999)
    expect(auto_crop_rect(detected, union, ZERO, 1000, 1000, true, true)).toEqual(box(30, 5, 130, 55))
    expect(auto_crop_rect(detected, union, ZERO, 1000, 1000, false, false)).toEqual(box(10, 10, 110, 60))
    expect(auto_crop_rect(detected, union, { left: 0.5, top: 0, right: 0, bottom: 0 }, 1000, 1000, false, false)).toEqual(box(5, 10, 110, 60))
    expect(auto_crop_rect(box(180, 180, 999, 999), union, ZERO, 200, 200, true, true)).toEqual(box(100, 150, 200, 200))
  })

  it('auto_crop_rect: shrinking offsets past the union stop at MIN_RECT instead of inverting', () => {
    const r = auto_crop_rect(box(50, 50, 60, 60), box(50, 50, 60, 60), { left: -40, top: -40, right: -40, bottom: -40 }, 200, 300, true, true)
    expect([bw(r), bh(r)]).toEqual([MIN_RECT, MIN_RECT])
  })

  it('offsets_from_rect clamps each edge offset to ±OFFSET_LIMIT', () => {
    const o = offsets_from_rect(box(-50, -50, 100, 100), box(0, 0, 5, 5), box(0, 0, 5, 5), 10, 10, false, false)
    expect(o).toEqual({ left: 100, top: 100, right: 100, bottom: 100 })
  })

  it('centered_crop_rect centres the union size on the page', () => {
    expect(centered_crop_rect(box(20, 20, 120, 280), 200, 300)).toEqual(box(50, 20, 150, 280))
  })

  it('detection_union is not a bounding box; union_box is; both reject an empty list', () => {
    const boxes = [box(0, 0, 100, 40), box(10, 10, 60, 90)]
    expect(detection_union(boxes)).toEqual(box(0, 0, 100, 80))
    expect(union_box(boxes)).toEqual(box(0, 0, 100, 90))
    expect(() => detection_union([])).toThrow(RangeError)
    expect(() => union_box([])).toThrow(RangeError)
  })

  it('rotate_box_cw maps (x, y) to (h - y, x) on the rotated page', () => {
    expect(rotate_box_cw(box(10, 20, 30, 40), 100)).toEqual(box(60, 10, 80, 30))
  })

  it('split_rects_grid orders windows TL, BL, TR, BR', () => {
    expect(split_rects_grid(4, 200, 100)).toEqual([box(0, 0, 100, 50), box(0, 50, 100, 100), box(100, 0, 200, 50), box(100, 50, 200, 100)])
    expect(split_rects_grid(2, 200, 100)).toEqual([box(0, 0, 100, 100), box(100, 0, 200, 100)])
  })

  it('keep_ratio_anchored: an edge drag grows the other axis symmetrically about the centre, capped by the page', () => {
    expect(keep_ratio_anchored(box(100, 100, 300, 260), 2, 'R', 1000, 1000)).toEqual(box(100, 130, 300, 230))
    expect(keep_ratio_anchored(box(0, 40, 150, 60), 1, 'R', 200, 120)).toEqual(box(0, 0, 100, 100))
    expect(keep_ratio_anchored(box(0, 0, 150, 100), 1, 'BR', 200, 120)).toEqual(box(0, 0, 120, 120))
  })

  it('keep_ratio_normalise caps a box wider than the page at the page width, height following', () => {
    expect(keep_ratio_normalise(box(0, 0, 200, 0), 1, 50, 100)).toEqual(box(0, 0, 50, 50))
  })

  it('clamp_edge_deltas caps a same-size resize at the tightest window\'s own headroom', () => {
    const rects = [box(0, 0, 100, 300), box(100, 0, 200, 300)]
    expect(clamp_edge_deltas({ dl: 0, dt: 0, dr: 150, db: 0 }, rects, [false, true], [false, false], 200, 300))
      .toEqual({ dl: 0, dt: 0, dr: 100, db: 0 })
    const within = { dl: 5, dt: 5, dr: 20, db: -5 }
    expect(clamp_edge_deltas(within, rects, [false, true], [false, false], 200, 300)).toEqual(within)
  })
})
