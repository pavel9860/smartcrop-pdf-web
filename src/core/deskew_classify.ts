// Pure decision tree for the Dewarp & Deskew warp classifier (spec-web §7.1a). Takes the already-
// computed angle/sharpness numbers (src/pdf/deskew.ts does the OpenCV work) and decides which of
// the three correction paths a page takes. No I/O, no OpenCV — same split as dewarp.ts's fp16
// helpers vs. its ONNX-dependent apply_dewarp.
import { DESKEW_MIN_DEG, WARP_SHARPNESS_MIN } from './constants'

export type DeskewClass = 'warped' | 'skewed' | 'flat'

export function classify_deskew(angle_deg: number, sharpness: number): DeskewClass {
  if (sharpness < WARP_SHARPNESS_MIN) return 'warped'
  return Math.abs(angle_deg) > DESKEW_MIN_DEG ? 'skewed' : 'flat'
}
