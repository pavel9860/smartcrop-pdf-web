// dbnet.ts — DBNet (PaddleOCR PP-OCRv4 mobile det, ONNX) text-line detection for §7.1b (skew
// correction). Model loading follows the exact same lazy-fetch-once + IndexedDB-cache
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
} from '@core/constants'
import { cv, type Mat } from './cv'
import { fetch_with_idb_cache, resolve_onnx_execution_providers } from './dewarp'
import type { Point } from './vanishing_point'

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
  }
  full_mask.delete(); contours.delete(); prob.delete()

  return { segments, confidences, weights }
}
