// deskew.ts — classic-CV, no-ONNX warp classifier + rotate-only correction (spec-web §7.1a). Runs
// BEFORE the ONNX dewarp path (dewarp.ts) so a page that's already flat or only incidentally
// rotated gets a cheap affine rotation instead of the full mesh-unwarp pass, which can introduce
// its own small residual distortion on input that didn't need it.
import { cv, type Mat } from './cv'

export interface DeskewEstimate {
  readonly angle_deg: number
  readonly sharpness: number
}

// Coarse-to-fine projection-profile search: binarize a downscaled copy, then find the rotation
// angle that makes the row-sum profile sharpest (text lines aligning into rows). The same search's
// peak row-variance, normalized by ink density, IS the warp signal (returned as `sharpness`) — a
// curl/fold that no single rotation can flatten stays blurred even at its best angle, while a flat
// or purely-rotated page's profile sharpens right up at the correct angle. One search pass produces
// both numbers, no separate cost for the classification.
export function estimate_deskew(mat: Mat, downscale_px: number, max_deg: number): DeskewEstimate {
  const gray = new cv.Mat()
  cv.cvtColor(mat, gray, Number(cv.COLOR_RGBA2GRAY))

  const scale = Math.min(1, downscale_px / Math.max(gray.cols, gray.rows))
  const small = new cv.Mat()
  if (scale < 1) {
    cv.resize(gray, small,
      new cv.Size(Math.round(gray.cols * scale), Math.round(gray.rows * scale)),
      0, 0, Number(cv.INTER_AREA))
  } else {
    gray.copyTo(small)
  }
  gray.delete()

  const bw = new cv.Mat()
  cv.threshold(small, bw, 0, 255, Number(cv.THRESH_BINARY_INV) + Number(cv.THRESH_OTSU))
  small.delete()

  // Coarse pass over the full search range, then one refinement pass at 1/10th the step — the
  // spec's DESKEW_MIN_DEG cutoff (0.2deg) doesn't need finer resolution than this affords (~0.1deg).
  let best_angle = 0, best_variance = -1
  const coarse_step = 1.0
  for (let a = -max_deg; a <= max_deg + 1e-9; a += coarse_step) {
    const v = _row_variance_at_angle(bw, a)
    if (v > best_variance) { best_variance = v; best_angle = a }
  }
  const refine_step = coarse_step / 10
  for (let a = best_angle - coarse_step; a <= best_angle + coarse_step + 1e-9; a += refine_step) {
    const v = _row_variance_at_angle(bw, a)
    if (v > best_variance) { best_variance = v; best_angle = a }
  }

  // cv.mean returns the whole-image mean pixel value; row-sum-per-row's own mean is that times
  // the row width — equivalent to averaging the row-sum profile directly, without a separate pass.
  const mean_ink_per_row = (cv.mean(bw)[0] as number) * bw.cols   // noUncheckedIndexedAccess
  bw.delete()

  const sharpness = best_variance / (mean_ink_per_row * mean_ink_per_row + 1e-9)
  return { angle_deg: best_angle, sharpness }
}

// cv.REDUCE_SUM exists at runtime (verified) but is missing from @techstark/opencv-js's .d.ts —
// same class of gap as dewarp.ts's Float16Array runtime-vs-typing workaround.
const REDUCE_SUM = (cv as unknown as { REDUCE_SUM: number }).REDUCE_SUM

function _row_variance_at_angle(bw: Mat, angle_deg: number): number {
  const w = bw.cols, h = bw.rows
  const m = cv.getRotationMatrix2D(new cv.Point(w / 2, h / 2), angle_deg, 1.0)
  const rotated = new cv.Mat()
  cv.warpAffine(bw, rotated, m, new cv.Size(w, h), Number(cv.INTER_NEAREST),
    Number(cv.BORDER_CONSTANT), new cv.Scalar(0, 0, 0, 0))
  m.delete()

  const row_sums = new cv.Mat()
  cv.reduce(rotated, row_sums, 1, REDUCE_SUM, Number(cv.CV_64F))
  rotated.delete()

  const mean = new cv.Mat(), stddev = new cv.Mat()
  cv.meanStdDev(row_sums, mean, stddev)
  row_sums.delete()
  const std = stddev.doubleAt(0, 0)
  mean.delete(); stddev.delete()
  return std * std
}

// Applies the angle from estimate_deskew AS-IS (not negated) — getRotationMatrix2D(angle_deg) is
// the same transform the search itself applies when it finds the sharpest-profile angle, so it is
// already the correct correction, not its inverse. Consumes `mat` (matches apply_dewarp's
// convention, dewarp.ts) — caller must not reuse it after this call.
export function rotate_mat(mat: Mat, angle_deg: number): Mat {
  const w = mat.cols, h = mat.rows
  const m = cv.getRotationMatrix2D(new cv.Point(w / 2, h / 2), angle_deg, 1.0)
  const out = new cv.Mat()
  cv.warpAffine(mat, out, m, new cv.Size(w, h), Number(cv.INTER_LINEAR),
    Number(cv.BORDER_CONSTANT), new cv.Scalar(255, 255, 255, 255))
  m.delete()
  mat.delete()
  return out
}
