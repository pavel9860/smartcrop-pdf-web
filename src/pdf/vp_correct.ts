// vp_correct.ts — one correction mechanism for both skew and trapezoid (§7.1b), from a vanishing
// point (vanishing_point.ts): a single matrix M = R * H, where H = [[1,0,0],[0,1,0],[gx,0,1]] is a
// rectifying homography that sends v (in anchor-centered coordinates) to infinity along its own
// x-axis, and R is the rotation that carries that x-axis to true horizontal — anchored so the
// page's own center point stays fixed. A pure skew (VP at infinity, vz=0) makes gx=0, i.e. H is
// the identity and only R corrects it; a pure keystone (vz finite, v already horizontal) makes
// theta=0 and only H corrects it — same formula either way, no branch on which case it is.
//
// ROOT-CAUSE FIX (2nd revision): the 1st revision (H alone, gx/gy chosen to send v to infinity in
// whatever direction it already pointed, without rotating) has zero rotational degrees of freedom
// — its top-left 2x2 block is fixed to identity, so it can only remove perspective convergence,
// never rotate a line to horizontal. Pure rotation is exactly the vz->0 degenerate case of that
// family, and in that limit gx=gy=0: a complete no-op (this was the reported bug — skew and
// top/bottom trapezoid got corrected only because those cases happened to leave a large residual
// perspective term alongside the rotation; a pure or near-pure left-right keystone has v already
// close to horizontal, so gx/gy solved without rotating collapsed to ~0 too). Composing a rotation
// (to horizontal) with the 1-DOF perspective term left over (gx, with gy fixed at 0 — the natural
// remaining DOF, equivalent to "a vertical line through the anchor stays vertical") fixes this:
// verified against both a pure-rotation case (theta alone corrects it, gx=0) and a finite-VP
// keystone case (theta=0, gx alone corrects it), same formula, no vz-based branching.
import { cv, type Mat } from './cv'
import type { Vp } from './vanishing_point'

// theta = rotation about the anchor that carries v's anchor-centered direction to horizontal;
// gx = the remaining perspective term, solved (in the now-rotated frame) so v maps to the point at
// infinity along that horizontal direction.
function solve_theta_gx(v: Vp, xc: number, yc: number): readonly [number, number] {
  const [vx, vy, vz] = v
  const vxp = vx - vz * xc
  const vyp = vy - vz * yc
  const theta = Math.atan2(-vyp, vxp)
  const vx_rot = Math.cos(theta) * vxp - Math.sin(theta) * vyp
  const gx = Math.abs(vx_rot) < 1e-9 ? 0 : -vz / vx_rot
  return [theta, gx]
}

// Consumes `mat` (matches apply_dewarp's convention, dewarp.ts) — caller must not reuse it after
// this call.
export function apply_vp_correction(mat: Mat, v: Vp, xc?: number, yc?: number): Mat {
  const w = mat.cols, h = mat.rows
  const cx = xc ?? w / 2
  const cy = yc ?? h / 2
  const [theta, gx] = solve_theta_gx(v, cx, cy)
  const c = Math.cos(theta), s = Math.sin(theta)

  const map_x = new cv.Mat(h, w, Number(cv.CV_32FC1))
  const map_y = new cv.Mat(h, w, Number(cv.CV_32FC1))
  const mx = map_x.data32F
  const my = map_y.data32F

  // For each CORRECTED-image pixel (x,y), the source (distorted) pixel is M^-1(x,y) = H^-1(R^-1
  // (x,y)): first undo the perspective term (1-DOF, along the rotated frame's x-axis), then rotate
  // back by -theta into the original (distorted) frame.
  for (let y = 0; y < h; y++) {
    const base = y * w
    const Yp = y - cy
    for (let x = 0; x < w; x++) {
      const Xp = x - cx
      let denom = 1 - gx * Xp
      if (Math.abs(denom) < 1e-6) denom = denom < 0 ? -1e-6 : 1e-6   // guard H's own vanishing line
      const X = Xp / denom, Y = Yp / denom
      mx[base + x] = c * X + s * Y + cx
      my[base + x] = -s * X + c * Y + cy
    }
  }

  const out = new cv.Mat()
  cv.remap(mat, out, map_x, map_y, Number(cv.INTER_LINEAR), Number(cv.BORDER_CONSTANT),
    new cv.Scalar(255, 255, 255, 255))
  map_x.delete(); map_y.delete()
  mat.delete()
  return out
}
