// Pure decision logic for Dewarp & Deskew (spec-web §7.1a/§7.1b). Takes the already-computed
// numbers (src/pdf/deskew.ts, dbnet.ts, vanishing_point.ts do the OpenCV/DBNet work) and decides
// which path a page takes. No I/O, no OpenCV — same split as dewarp.ts's fp16 helpers vs. its
// ONNX-dependent apply_dewarp.
import { WARP_SHARPNESS_MIN, DESKEW_MIN_DEG, TRAP_DELTA_MIN_DEG } from './constants'

// §7.1a: a page whose row profile stays blurred even at its best rotation angle has a curl/fold
// no single rotation can fix — it needs the full ONNX mesh-unwarp pipeline.
export function classify_warp(sharpness: number): boolean {
  return sharpness < WARP_SHARPNESS_MIN
}

// §7.1b: correct if the line-direction vanishing-point fit's center angle (pure-skew component)
// or either edge delta (trapezoid component) clears its own noise-floor threshold, OR — the
// width-only-keystone case the line-direction VP structurally cannot see (a keystone tilted about
// an axis parallel to the text baselines changes each line's width but never its angle) — either
// edge delta of the stroke-direction vanishing-point fit does. An OR across all five, not
// requiring all of them, since a real page can carry just one of these distortions. The
// stroke-direction deltas are optional (undefined when too few regions had usable stroke signal)
// and only ever add a way to trigger correction, never a way to block it.
export function needs_skew_trapezoid_correction(
  center_angle_deg: number, lr_delta_deg: number, tb_delta_deg: number,
  stroke_lr_delta_deg?: number, stroke_tb_delta_deg?: number,
): boolean {
  return Math.abs(center_angle_deg) > DESKEW_MIN_DEG
    || Math.abs(lr_delta_deg) > TRAP_DELTA_MIN_DEG
    || Math.abs(tb_delta_deg) > TRAP_DELTA_MIN_DEG
    || Math.abs(stroke_lr_delta_deg ?? 0) > TRAP_DELTA_MIN_DEG
    || Math.abs(stroke_tb_delta_deg ?? 0) > TRAP_DELTA_MIN_DEG
}
