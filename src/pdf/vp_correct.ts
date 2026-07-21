// vp_correct.ts — skew (rotation) correction for §7.1b, from the vanishing point (vanishing_point.
// ts): a single rotation that carries the vanishing point's implied text-line angle to horizontal,
// anchored so the page's own center point stays fixed. Deliberately rotation-only — automatic
// trapezoid/keystone correction was investigated at length and abandoned; see
// docs/detrapezoid_research.md (gitignored, local reference only) for why.
//
// The rotation angle is split into the nearest multiple of 90° (`theta_coarse`, never applied) plus
// a small residual (always applied) — a page whose real content is itself rotated a multiple of 90°
// (fed sideways) must keep that orientation; only its fine skew, if any, is this feature's job.
// Reorienting a whole multiple of 90° is `Rotate`'s job (spec-web §12), independent of the page's
// current display rotation (§7.1's own "runs against the page's own content" invariant). Verified
// (point-based, no image-warp-direction ambiguity) that this reduces to an ordinary rotation when no
// fold is needed, and that a page genuinely rotated ~90° gets only its small residual skew corrected.
import { cv, type Mat } from './cv'
import type { Vp } from './vanishing_point'

// theta_raw = rotation about the anchor that would carry v's anchor-centered direction exactly to
// horizontal. theta_coarse = the nearest multiple of 90° to that (never actually applied — see file
// header); only the residual is.
function solve(v: Vp, xc: number, yc: number): readonly [number, number] {
  const [vx, vy, vz] = v
  const vxp = vx - vz * xc
  const vyp = vy - vz * yc
  const theta_raw = Math.atan2(-vyp, vxp)
  const theta_coarse = (Math.PI / 180) * 90 * Math.round((theta_raw * 180) / Math.PI / 90)
  return [theta_raw, theta_coarse]
}

// Consumes `mat` (matches apply_dewarp's convention, dewarp.ts) — caller must not reuse it after
// this call.
export function apply_vp_correction(mat: Mat, v: Vp, xc?: number, yc?: number): Mat {
  const w = mat.cols, h = mat.rows
  const cx = xc ?? w / 2
  const cy = yc ?? h / 2
  const [theta_raw, theta_coarse] = solve(v, cx, cy)
  // Net rotation applied = theta_raw - theta_coarse (the residual): rotate by +theta_coarse first
  // (reintroducing the coarse orientation this correction never actually removes), then by
  // -theta_raw (the inverse of the full derotation) — sanity check baked into the derivation:
  // theta_raw == theta_coarse (a pure coarse rotation, zero residual) must give the identity map.
  const theta = theta_coarse - theta_raw
  const c = Math.cos(theta), s = Math.sin(theta)

  const map_x = new cv.Mat(h, w, Number(cv.CV_32FC1))
  const map_y = new cv.Mat(h, w, Number(cv.CV_32FC1))
  const mx = map_x.data32F
  const my = map_y.data32F

  for (let y = 0; y < h; y++) {
    const base = y * w
    const Yp = y - cy
    for (let x = 0; x < w; x++) {
      const Xp = x - cx
      mx[base + x] = c * Xp - s * Yp + cx
      my[base + x] = s * Xp + c * Yp + cy
    }
  }

  const out = new cv.Mat()
  cv.remap(mat, out, map_x, map_y, Number(cv.INTER_LINEAR), Number(cv.BORDER_CONSTANT),
    new cv.Scalar(255, 255, 255, 255))
  map_x.delete(); map_y.delete()
  mat.delete()
  return out
}
