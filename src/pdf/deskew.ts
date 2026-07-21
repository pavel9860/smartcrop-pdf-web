// deskew.ts — classic-CV, no-ONNX/DBNet warp classifier (spec-web §7.1a). Decides whether a page
// needs the full ONNX mesh-unwarp pass (dewarp.ts) at all, before the more precise but heavier
// text-line-detection-based angle estimate (dbnet.ts, vanishing_point.ts, §7.1b) ever runs — a
// page that's already flat or only incidentally skewed would otherwise be needlessly re-warped by
// ONNX, which can introduce its own small residual distortion. This module no longer performs any
// correction itself (§7.1b's vanishing-point-based estimate is more precise) — only classification.
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

  // Coarse pass over the full search range, then one refinement pass at 1/10th the step — this
  // angle is only a byproduct of locating the sharpness peak (§7.1a); the precise skew angle
  // actually used for correction comes from §7.1b's text-line-detection-based estimate.
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

