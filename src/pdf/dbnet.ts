// dbnet.ts — DBNet (PaddleOCR PP-OCRv4 mobile det, ONNX) text-line detection for §7.1b (skew &
// trapezoid correction). Model loading follows the exact same lazy-fetch-once + IndexedDB-cache
// pattern as dewarp.ts's UVDoc sessions (fetch_with_idb_cache, resolve_onnx_execution_providers —
// both reused from there, not duplicated). Runs only for a page the warp classifier (deskew.ts)
// found not warped; imaging.ts calls into this file, not the other way, so there's no import cycle.
//
// Licensing: PaddleOCR is Apache-2.0 (github.com/PaddlePaddle/PaddleOCR). The vendored weights
// (public/models/ch_PP-OCRv4_det.onnx) are a pre-converted export of the official PP-OCRv4 mobile
// detector, sourced from a community ONNX mirror (huggingface.co/Heliosoph/paddleocr-v4-det-onnx)
// rather than converted in this repo — same weights, same Apache-2.0 terms, only the conversion
// tooling differs from running Paddle2ONNX locally.
import type { InferenceSession } from 'onnxruntime-web'
import { MissingDependencyError } from '@core/errors'
import {
  DBNET_MODEL_URL, DBNET_MODEL_CACHE_KEY, DBNET_PROB_THRESH, DBNET_UNCLIP_RATIO,
  DBNET_MIN_AREA_PX, DBNET_MIN_WIDTH_PX, DBNET_MIN_ASPECT_RATIO,
  STROKE_INK_GRAY_MAX, STROKE_EDGE_MAG2_MIN, STROKE_MIN_EDGE_PIXELS,
} from '@core/constants'
import { cv, type Mat } from './cv'
import { fetch_with_idb_cache, resolve_onnx_execution_providers } from './dewarp'
import { fold_line_angle, type Point } from './vanishing_point'

let _session: InferenceSession | null = null
let _dbnet_init: Promise<void> | null = null

// Cached in-flight init promise so concurrent callers share ONE session build, same rationale as
// dewarp.ts's ensure_onnx (a second concurrent build's resources would otherwise leak — no
// .release() call exists anywhere in this codebase's ONNX usage).
export function ensure_dbnet(): Promise<void> {
  if (_session) return Promise.resolve()
  if (!_dbnet_init) {
    _dbnet_init = _load_session().catch((e: unknown) => {
      _dbnet_init = null   // allow a retry rather than permanently caching a failed load
      throw e
    })
  }
  return _dbnet_init
}

async function _load_session(): Promise<void> {
  try {
    const ort = await import('onnxruntime-web/webgpu')
    const execution_providers = resolve_onnx_execution_providers(ort)
    const base = import.meta.env.BASE_URL
    const bytes = await fetch_with_idb_cache(DBNET_MODEL_CACHE_KEY, base + DBNET_MODEL_URL)
    _session = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: execution_providers })
  } catch (e) {
    throw new MissingDependencyError(`Failed to load the text-line detection model: ${String(e)}`)
  }
}

export interface TextLineDetections {
  readonly segments: ReadonlyArray<readonly [Point, Point]>
  readonly confidences: readonly number[]
  // Per-detection ANGLE-precision leverage weight (width^2) — see vanishing_point.ts's
  // estimate_vanishing_point docstring for why this is required alongside confidence.
  readonly weights: readonly number[]
  // Second vanishing-point signal (§7.1b step 2): one synthetic segment per detection with usable
  // stroke-orientation signal, through its centroid, in the measured local stroke direction.
  readonly stroke_segments: ReadonlyArray<readonly [Point, Point]>
  readonly stroke_confidences: readonly number[]
  readonly stroke_weights: readonly number[]
}

const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const
const IMAGENET_STD = [0.229, 0.224, 0.225] as const

// RGBA Mat -> resized-to-multiple-of-32 CHW float32 tensor data, ImageNet-normalized (standard
// PP-OCRv4 det preprocessing).
function preprocess(mat: Mat, max_side: number): { chw: Float32Array; rw: number; rh: number } {
  const w0 = mat.cols, h0 = mat.rows
  const scale = Math.min(1, max_side / Math.max(w0, h0))
  const rw = Math.max(32, Math.round((w0 * scale) / 32) * 32)
  const rh = Math.max(32, Math.round((h0 * scale) / 32) * 32)

  const resized = new cv.Mat()
  cv.resize(mat, resized, new cv.Size(rw, rh), 0, 0, Number(cv.INTER_LINEAR))
  const rgb = new cv.Mat()
  cv.cvtColor(resized, rgb, Number(cv.COLOR_RGBA2RGB))
  resized.delete()

  const plane = rw * rh
  const chw = new Float32Array(3 * plane)
  const data = rgb.data   // Uint8Array, HWC RGB
  for (let p = 0; p < plane; p++) {
    const o = p * 3
    chw[p]             = ((data[o]     as number) / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0]   // noUncheckedIndexedAccess
    chw[plane + p]     = ((data[o + 1] as number) / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1]    // noUncheckedIndexedAccess
    chw[2 * plane + p] = ((data[o + 2] as number) / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2]    // noUncheckedIndexedAccess
  }
  rgb.delete()
  return { chw, rw, rh }
}

// cv.js has no boxPoints() binding — compute a RotatedRect's 4 corners directly from
// (center, size, angle) via standard rotation, verified empirically against a known-rotated
// rectangle (this formula, no sign flip, matches cv.js's angle convention exactly).
function rotated_rect_corners(cx: number, cy: number, w: number, h: number, angle_deg: number): Point[] {
  const rad = (angle_deg * Math.PI) / 180
  const cos_a = Math.cos(rad), sin_a = Math.sin(rad)
  const hw = w / 2, hh = h / 2
  const local: Array<readonly [number, number]> = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
  return local.map(([lx, ly]) => ({
    x: cx + lx * cos_a - ly * sin_a,
    y: cy + lx * sin_a + ly * cos_a,
  }))
}

// Each kept detection's own long-axis endpoints (midpoints of its two SHORT edges) + width/aspect
// for the DBNET_MIN_WIDTH_PX/DBNET_MIN_ASPECT_RATIO filter — a near-square region (most often a
// short page-number box) has no reliable long axis and corrupts the fit with a spurious
// near-zero-angle reading if kept.
function quad_to_segment(corners: readonly Point[]): { p1: Point; p2: Point; width: number } | null {
  const [c0, c1, c2, c3] = corners as [Point, Point, Point, Point]
  const d01 = Math.hypot(c1.x - c0.x, c1.y - c0.y)
  const d12 = Math.hypot(c2.x - c1.x, c2.y - c1.y)
  const width = Math.max(d01, d12), height = Math.min(d01, d12)
  const aspect_ratio = width / Math.max(height, 1e-6)
  if (width < DBNET_MIN_WIDTH_PX || aspect_ratio < DBNET_MIN_ASPECT_RATIO) return null
  const [p1, p2] = d01 >= d12
    ? [{ x: (c0.x + c3.x) / 2, y: (c0.y + c3.y) / 2 }, { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 }]
    : [{ x: (c0.x + c1.x) / 2, y: (c0.y + c1.y) / 2 }, { x: (c2.x + c3.x) / 2, y: (c2.y + c3.y) / 2 }]
  return { p1, p2, width }
}

// Local character-stroke orientation within one detected region, via a gradient structure tensor
// over ink/edge pixels — independent of the region's fitted long-axis angle (a rotated bounding
// rect's short axis is always exactly perpendicular to its long axis by construction, so it
// carries no separate information; this instead looks at the actual pixel content). This is the
// second vanishing-point signal (§7.1b step 2): a keystone tilted about an axis parallel to the
// text baselines changes each line's WIDTH with height but never its ANGLE — invisible to
// line-direction VP estimation no matter how strong (the true VP of originally-horizontal lines
// under that exact homography has vz=0 identically) — but stroke angle DOES vary measurably across
// the page in that same case (verified both analytically and against real pixels via this same
// structure-tensor approach).
//
// De-rotates the region to its OWN local (long-axis-horizontal) frame first via warpAffine, then
// crops tightly to the region's actual (unclipped) width/height, rather than taking an axis-
// aligned bounding box of the (possibly steeply tilted) quad directly — validated bug: for a
// region whose long axis is itself near-vertical (e.g. a page whose real content is rotated
// ~90deg), an axis-aligned box is nearly as tall/wide as the box's own diagonal and routinely pulls
// in neighboring text lines, corrupting the structure tensor with a second, unrelated orientation
// (measured: a spurious ~30deg edge-angle delta on real content whose actual stroke-angle swing,
// measured the de-rotated way, is a couple of degrees — consistent with the un-rotated case). The
// measured angle is in the LOCAL (de-rotated) frame; `angle_deg` is added back to return it in the
// original image frame.
function measure_stroke_angle(
  mat: Mat, center: Point, region_angle_deg: number, width: number, height: number,
): { angle_deg: number; weight: number } | null {
  const half_diag = Math.hypot(width, height) / 2 + 2
  const x0 = Math.max(0, Math.floor(center.x - half_diag))
  const y0 = Math.max(0, Math.floor(center.y - half_diag))
  const x1 = Math.min(mat.cols, Math.ceil(center.x + half_diag))
  const y1 = Math.min(mat.rows, Math.ceil(center.y + half_diag))
  if (x1 - x0 < 3 || y1 - y0 < 3) return null

  const patch = mat.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0))
  const local_center = new cv.Point(center.x - x0, center.y - y0)
  // rotated_rect_corners builds GLOBAL = R(region_angle_deg) . LOCAL — de-rotating back to LOCAL
  // (straightening the region) is the inverse, R(-region_angle_deg).
  const rot_m = cv.getRotationMatrix2D(local_center, -region_angle_deg, 1.0)
  const straightened = new cv.Mat()
  cv.warpAffine(patch, straightened, rot_m, new cv.Size(patch.cols, patch.rows),
    Number(cv.INTER_LINEAR), Number(cv.BORDER_CONSTANT), new cv.Scalar(255, 255, 255, 255))
  rot_m.delete(); patch.delete()

  const cx0 = Math.max(0, Math.floor(local_center.x - width / 2))
  const cy0 = Math.max(0, Math.floor(local_center.y - height / 2))
  const cx1 = Math.min(straightened.cols, Math.ceil(local_center.x + width / 2))
  const cy1 = Math.min(straightened.rows, Math.ceil(local_center.y + height / 2))
  if (cx1 - cx0 < 3 || cy1 - cy0 < 3) { straightened.delete(); return null }
  const roi = straightened.roi(new cv.Rect(cx0, cy0, cx1 - cx0, cy1 - cy0))
  const gray = new cv.Mat()
  cv.cvtColor(roi, gray, Number(cv.COLOR_RGBA2GRAY))
  roi.delete(); straightened.delete()

  const dx = new cv.Mat(), dy = new cv.Mat()
  cv.Sobel(gray, dx, Number(cv.CV_32F), 1, 0, 3)
  cv.Sobel(gray, dy, Number(cv.CV_32F), 0, 1, 3)

  const ink_mask = new cv.Mat()
  cv.threshold(gray, ink_mask, STROKE_INK_GRAY_MAX, 255, Number(cv.THRESH_BINARY_INV))
  gray.delete()

  const dx2 = new cv.Mat(), dy2 = new cv.Mat(), dxdy = new cv.Mat()
  cv.multiply(dx, dx, dx2)
  cv.multiply(dy, dy, dy2)
  cv.multiply(dx, dy, dxdy)
  const mag2 = new cv.Mat()
  cv.add(dx2, dy2, mag2)
  dx.delete(); dy.delete()

  const edge_mask_f = new cv.Mat()
  cv.threshold(mag2, edge_mask_f, STROKE_EDGE_MAG2_MIN, 255, Number(cv.THRESH_BINARY))
  mag2.delete()
  const edge_mask = new cv.Mat()
  edge_mask_f.convertTo(edge_mask, Number(cv.CV_8U))
  edge_mask_f.delete()

  const mask = new cv.Mat()
  cv.bitwise_and(ink_mask, edge_mask, mask)
  ink_mask.delete(); edge_mask.delete()

  const n = cv.countNonZero(mask)
  if (n < STROKE_MIN_EDGE_PIXELS) { dx2.delete(); dy2.delete(); dxdy.delete(); mask.delete(); return null }

  // Structure tensor [[sxx,sxy],[sxy,syy]] — mean, not sum, over masked pixels (the eigenvector
  // direction is scale-invariant, so mean vs. sum doesn't change the resulting angle).
  const sxx = cv.mean(dx2, mask)[0] as number
  const syy = cv.mean(dy2, mask)[0] as number
  const sxy = cv.mean(dxdy, mask)[0] as number
  dx2.delete(); dy2.delete(); dxdy.delete(); mask.delete()

  const tr = sxx + syy, det = sxx * syy - sxy * sxy
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det))
  const lambda_max = tr / 2 + disc
  let ex: number, ey: number
  if (Math.abs(sxy) > 1e-9) { ex = lambda_max - syy; ey = sxy }
  else { ex = sxx >= syy ? 1 : 0; ey = sxx >= syy ? 0 : 1 }
  const norm = Math.hypot(ex, ey)
  if (norm < 1e-12) return null
  // (ex,ey) is the dominant GRADIENT direction (strongest intensity change), which for a set of
  // near-parallel strokes is perpendicular to the strokes themselves — rotate 90deg to recover the
  // stroke direction. Folded mod 180 (fold_line_angle), same convention as line angles: a LINE's
  // orientation, not a vector, so +/-90deg off is the same stroke.
  const grad_angle = Math.atan2(ey, ex) * 180 / Math.PI
  // Measured in the de-rotated LOCAL frame — add the region's own angle back to express it in the
  // original image frame (inverse of the -region_angle_deg de-rotation above).
  const angle_deg = fold_line_angle(grad_angle + 90 + region_angle_deg)
  return { angle_deg, weight: n }
}

// Synthetic 2-point segment through (cx,cy) in the measured stroke direction — feeds the same
// line-based estimate_vanishing_point()/vp_edge_angles() machinery used for text-line direction,
// reused rather than duplicated for this second signal.
function stroke_segment(cx: number, cy: number, angle_deg: number, half_len: number): readonly [Point, Point] {
  const rad = (angle_deg * Math.PI) / 180
  const ux = Math.cos(rad), uy = Math.sin(rad)
  return [{ x: cx - ux * half_len, y: cy - uy * half_len }, { x: cx + ux * half_len, y: cy + uy * half_len }]
}

export async function detect_text_lines(mat: Mat, max_side: number): Promise<TextLineDetections> {
  if (!_session) throw new MissingDependencyError('detect_text_lines called before ensure_dbnet() resolved')
  const ort = await import('onnxruntime-web/webgpu')

  const w0 = mat.cols, h0 = mat.rows
  const { chw, rw, rh } = preprocess(mat, max_side)
  const input_tensor = new ort.Tensor('float32', chw, [1, 3, rh, rw])
  const input_name = _session.inputNames[0]
  if (!input_name) throw new MissingDependencyError('Text-line detection model has no declared input')
  const outputs = await _session.run({ [input_name]: input_tensor })
  const output_name = _session.outputNames[0]
  const prob_raw = output_name ? outputs[output_name] : undefined
  if (!prob_raw) throw new MissingDependencyError('Text-line detection model returned no output tensor')
  const prob_data = prob_raw.data
  if (!(prob_data instanceof Float32Array)) {
    throw new MissingDependencyError(`Text-line detection model output has unexpected dtype: ${prob_raw.type}`)
  }

  const prob = new cv.Mat(rh, rw, Number(cv.CV_32FC1))
  prob.data32F.set(prob_data)

  const bitmap_f = new cv.Mat()
  cv.threshold(prob, bitmap_f, DBNET_PROB_THRESH, 255, Number(cv.THRESH_BINARY))
  const bitmap = new cv.Mat()
  bitmap_f.convertTo(bitmap, Number(cv.CV_8U))
  bitmap_f.delete()

  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  cv.findContours(bitmap, contours, hierarchy, Number(cv.RETR_LIST), Number(cv.CHAIN_APPROX_SIMPLE))
  hierarchy.delete(); bitmap.delete()

  const scale_x = w0 / rw, scale_y = h0 / rh
  const segments: Array<readonly [Point, Point]> = []
  const confidences: number[] = []
  const weights: number[] = []
  const stroke_segments: Array<readonly [Point, Point]> = []
  const stroke_confidences: number[] = []
  const stroke_weights: number[] = []

  const full_mask = new cv.Mat(rh, rw, Number(cv.CV_8UC1), new cv.Scalar(0))
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i)
    const area = cv.contourArea(cnt)
    if (area < DBNET_MIN_AREA_PX) { cnt.delete(); continue }

    // Mean detection probability under the contour's own (pre-unclip) region — confidence
    // answers "is this text"; leverage weight (below) separately answers "how precisely is its
    // angle known". Full-frame mask reused per contour rather than allocated fresh (still O(area)
    // scanned by cv.mean regardless — only the allocation itself is saved).
    full_mask.setTo(new cv.Scalar(0))
    const single = new cv.MatVector(); single.push_back(cnt)
    cv.drawContours(full_mask, single, 0, new cv.Scalar(255), Number(cv.FILLED))
    single.delete()
    const confidence = cv.mean(prob, full_mask)[0] as number

    const rect = cv.minAreaRect(cnt)
    cnt.delete()
    const { width: rw_, height: rh_ } = rect.size
    const peri = 2 * (rw_ + rh_)
    if (peri === 0) continue
    // DB unclip: expand the box outward by a scale-derived offset (standard Vatti-clipping
    // approximation), same formula as the desktop/Python reference.
    const expand = (rw_ * rh_ * DBNET_UNCLIP_RATIO) / peri
    const corners = rotated_rect_corners(rect.center.x, rect.center.y, rw_ + 2 * expand, rh_ + 2 * expand, rect.angle)
    const scaled = corners.map((p) => ({ x: p.x * scale_x, y: p.y * scale_y }))

    const seg = quad_to_segment(scaled)
    if (!seg) continue
    segments.push([seg.p1, seg.p2])
    confidences.push(confidence)
    weights.push(seg.width * seg.width)

    const full_res_center = { x: rect.center.x * scale_x, y: rect.center.y * scale_y }
    const stroke = measure_stroke_angle(
      mat, full_res_center, rect.angle, (rw_ + 2 * expand) * scale_x, (rh_ + 2 * expand) * scale_y,
    )
    if (stroke) {
      stroke_segments.push(
        stroke_segment(full_res_center.x, full_res_center.y, stroke.angle_deg, Math.max(10, seg.width / 4)),
      )
      stroke_confidences.push(confidence)
      stroke_weights.push(stroke.weight)
    }
  }
  full_mask.delete(); contours.delete(); prob.delete()

  return { segments, confidences, weights, stroke_segments, stroke_confidences, stroke_weights }
}
