// vp_correct.ts — one correction mechanism for both skew and trapezoid (§7.1b), from a vanishing
// point (vanishing_point.ts). The VP implies a local tangent-slope field over the whole page;
// integrating it from a reference column gives a smooth per-pixel vertical-shift remap. A pure
// skew (VP at infinity) integrates to an ordinary shear; a real keystone integrates to a
// position-varying correction — same formula either way, not two code paths (no need for a
// separate "just rotate" path once trapezoid is handled).
import { cv, type Mat } from './cv'
import type { Vp } from './vanishing_point'

// Consumes `mat` (matches apply_dewarp's convention, dewarp.ts) — caller must not reuse it after
// this call.
export function apply_vp_correction(mat: Mat, v: Vp, x_ref?: number): Mat {
  const w = mat.cols, h = mat.rows
  const ref = x_ref ?? w / 2
  const [vx, vy, vz0] = v
  const vz = Math.abs(vz0) > 1e-12 ? vz0 : (vz0 >= 0 ? 1e-12 : -1e-12)
  const px = vx / vz, py = vy / vz
  const ref_i = Math.min(w - 1, Math.max(0, Math.round(ref)))

  const map_x = new cv.Mat(h, w, Number(cv.CV_32FC1))
  const map_y = new cv.Mat(h, w, Number(cv.CV_32FC1))
  const mx = map_x.data32F
  const my = map_y.data32F

  const row_cum = new Float64Array(w)
  for (let y = 0; y < h; y++) {
    const dy = py - y
    let cum = 0
    for (let x = 0; x < w; x++) {
      let dx = px - x
      // guard the VP-inside-frame singularity (dx -> 0): only relevant for a keystone severe
      // enough to put the vanishing point ON the visible page, not the mild/moderate distortion
      // this pipeline targets — clamp rather than let a near-zero denominator blow up.
      if (Math.abs(dx) < 1) dx = dx === 0 ? 1 : Math.sign(dx)
      cum += dy / dx   // integral_{x_ref}^{x} tan(angle(t, y)) dt, Riemann sum with 1px step
      row_cum[x] = cum
    }
    const cum_at_ref = row_cum[ref_i] as number
    const base = y * w
    for (let x = 0; x < w; x++) {
      mx[base + x] = x
      my[base + x] = y + ((row_cum[x] as number) - cum_at_ref)
    }
  }

  const out = new cv.Mat()
  cv.remap(mat, out, map_x, map_y, Number(cv.INTER_LINEAR), Number(cv.BORDER_CONSTANT),
    new cv.Scalar(255, 255, 255, 255))
  map_x.delete(); map_y.delete()
  mat.delete()
  return out
}
