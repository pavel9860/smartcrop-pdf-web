// vp_correct.ts — one correction mechanism for skew and both trapezoid axes (§7.1b), from up to
// two vanishing points (vanishing_point.ts): `v_h` (text-LINE direction) and `v_s` (character-
// STROKE direction). A single VP can only ever rectify convergence in ITS OWN family of
// originally-parallel lines — `v_h` alone (the only signal a prior revision used) is structurally
// blind to a keystone tilted about an axis parallel to the text baselines, since that distortion
// changes each line's WIDTH with height but never its ANGLE (proven analytically: the true VP of
// originally-horizontal lines under that exact homography has vz=0 identically, independent of how
// strong the keystone is). `v_s` carries the missing signal (verified the same way, and against
// real pixels): rectifying against BOTH sends `v_h` to horizontal infinity and `v_s` to vertical
// infinity in one composed map, not two passes — degrading gracefully to the `v_h`-only correction
// when `v_s` isn't available (too few regions had usable stroke signal).
//
// ROOT-CAUSE FIX (3rd revision, over the 2nd's rotation+1-DOF-perspective form): two more bugs
// found this way. (a) using `v_h` alone can only ever fix the ONE keystone axis line angle can see
// — the width-only axis (above) needed the second VP, not a better formula for the first. (b) the
// 2nd revision's rotation angle was unbounded: a page whose real content is itself rotated a
// multiple of 90° (fed sideways) got that whole reorientation undone by Dewarp & Deskew, which is
// `Rotate`'s job, not this feature's (confirmed via the `trap_90.png` fixture, and via spec-web
// §7.1's own "runs against the page's own content, independent of its current display rotation").
// Fixed by splitting the ideal full derotation angle into the nearest multiple of 90° (never
// applied — folded back in at the end) plus a small residual (always applied, alongside the
// perspective/shear terms) — verified this reduces EXACTLY to the shipped 2nd-revision formula
// when no fold is needed and no `v_s` is available, and independently verified (point-based, no
// image-warp-direction ambiguity) that a keystone rotated 90° as a whole image gets fully
// rectified while its 90° orientation is left alone.
import { cv, type Mat } from './cv'
import type { Vp } from './vanishing_point'

interface Solved {
  readonly theta_raw: number
  readonly theta_coarse: number
  readonly gx: number
  readonly gy: number
  readonly b: number
}

// theta_raw = rotation about the anchor that would carry v_h's anchor-centered direction exactly
// to horizontal. theta_coarse = the nearest multiple of 90° to that (never actually applied as a
// rotation — see file header); only the residual is. gx, gy, b are solved (in the theta_raw-
// rotated frame) so that v_h maps to horizontal infinity and — when v_s is available — v_s maps to
// vertical infinity, via the 2x2 linear system derived in the file header's fix (b): both
// constraints' Z=0 conditions give `[[vhx_rot, 0], [vvx_rot, vvy_rot]] * [gx, gy] = [-vhz, -vvz]`
// (v_h's own Y=0 is automatic since theta_raw was chosen exactly for that), plus v_s's X=0
// condition giving b independently.
function solve(v_h: Vp, v_s: Vp | null, xc: number, yc: number): Solved {
  const [vhx, vhy, vhz] = v_h
  const vhxp = vhx - vhz * xc
  const vhyp = vhy - vhz * yc
  const theta_raw = Math.atan2(-vhyp, vhxp)
  const theta_coarse = (Math.PI / 180) * 90 * Math.round((theta_raw * 180) / Math.PI / 90)

  const c = Math.cos(theta_raw), s = Math.sin(theta_raw)
  const vhx_rot = c * vhxp - s * vhyp   // = hypot(vhxp, vhyp), always >= 0

  if (Math.abs(vhx_rot) < 1e-9) return { theta_raw, theta_coarse, gx: 0, gy: 0, b: 0 }
  const gx0 = -vhz / vhx_rot

  if (!v_s) return { theta_raw, theta_coarse, gx: gx0, gy: 0, b: 0 }
  const [vvx, vvy, vvz] = v_s
  const vvxp = vvx - vvz * xc
  const vvyp = vvy - vvz * yc
  const vvx_rot = c * vvxp - s * vvyp
  const vvy_rot = s * vvxp + c * vvyp
  if (Math.abs(vvy_rot) < 1e-9) return { theta_raw, theta_coarse, gx: gx0, gy: 0, b: 0 }

  const b = -vvx_rot / vvy_rot
  const gy = (-vvz - vvx_rot * gx0) / vvy_rot
  return { theta_raw, theta_coarse, gx: gx0, gy, b }
}

// Consumes `mat` (matches apply_dewarp's convention, dewarp.ts) — caller must not reuse it after
// this call. `v_s` (the stroke-direction VP) is optional — omit it for a line-direction-only
// correction (e.g. a caller that hasn't computed it, or found it unreliable).
export function apply_vp_correction(mat: Mat, v_h: Vp, v_s?: Vp | null, xc?: number, yc?: number): Mat {
  const w = mat.cols, h = mat.rows
  const cx = xc ?? w / 2
  const cy = yc ?? h / 2
  const { theta_raw, theta_coarse, gx, gy, b } = solve(v_h, v_s ?? null, cx, cy)
  const c = Math.cos(theta_raw), s = Math.sin(theta_raw)
  const cc = Math.cos(theta_coarse), sc = Math.sin(theta_coarse)

  const map_x = new cv.Mat(h, w, Number(cv.CV_32FC1))
  const map_y = new cv.Mat(h, w, Number(cv.CV_32FC1))
  const mx = map_x.data32F
  const my = map_y.data32F

  // For each CORRECTED-image pixel (x,y), the source (distorted) pixel is the inverse of
  // R(-theta_coarse) . N(gx,gy,b) . R(theta_raw) [source -> corrected: fully derotate+rectify via
  // N.R(theta_raw), then rotate the result BACK by -theta_coarse to reintroduce just the coarse
  // orientation this correction never actually applies — see file header], applied in reverse:
  //   A) rotate by +theta_coarse (undo step A's own "rotate back by -theta_coarse")
  //   B) apply N^-1 (the perspective+shear terms; closed form, N^-1 = [[1,-b,0],[0,1,0],
  //      [-gx, b*gx-gy, 1]], derived from N's own adjugate)
  //   C) rotate by -theta_raw, back into the original (distorted) frame
  // Sanity check baked into the derivation: theta_raw == theta_coarse (a pure coarse rotation,
  // zero residual) must give the identity map — R(-theta_raw).R(theta_coarse) = R(0) confirms the
  // signs below, not R(-theta_coarse) in step A (which would double the coarse rotation instead of
  // cancelling it).
  for (let y = 0; y < h; y++) {
    const base = y * w
    const Yp = y - cy
    for (let x = 0; x < w; x++) {
      const Xp = x - cx
      const X1 = cc * Xp - sc * Yp
      const Y1 = sc * Xp + cc * Yp

      let t = -gx * X1 + (b * gx - gy) * Y1 + 1
      if (Math.abs(t) < 1e-6) t = t < 0 ? -1e-6 : 1e-6   // guard N's own vanishing line
      const X2 = (X1 - b * Y1) / t
      const Y2 = Y1 / t

      mx[base + x] = c * X2 + s * Y2 + cx
      my[base + x] = -s * X2 + c * Y2 + cy
    }
  }

  const out = new cv.Mat()
  cv.remap(mat, out, map_x, map_y, Number(cv.INTER_LINEAR), Number(cv.BORDER_CONSTANT),
    new cv.Scalar(255, 255, 255, 255))
  map_x.delete(); map_y.delete()
  mat.delete()
  return out
}
