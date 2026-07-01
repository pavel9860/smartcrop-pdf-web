// imaging.ts — OpenCV.js scan processing (detect / filter / dewarp). Runs on the MAIN
// thread, not in a Worker — deliberate, not an oversight.
//
// This used to run inside a dedicated imaging.worker.ts. Root cause of moving it here:
// @techstark/opencv-js's own .d.ts re-exports `onRuntimeInitialized` as a NAMED EXPORT
// (dist/src/types/opencv/_hacks.d.ts), which collides with the runtime property of the
// same name Emscripten expects the embedder to set. `cvModule.onRuntimeInitialized = fn`
// is therefore an illegal import-binding reassignment — esbuild rejects it outright
// ("Cannot assign to import 'onRuntimeInitialized'; imports are immutable") whenever it
// analyses the import strictly (confirmed via `optimizeDeps.exclude` and via the
// dedicated-worker bundle, which does its own separate esbuild pass). Where a looser
// bundling path lets the assignment through silently instead of erroring (Vite's
// dev-time `optimizeDeps` pre-bundle for a plain main-thread import), the write still
// doesn't reach the real Emscripten module object, so onRuntimeInitialized never fires
// and every `cv.Mat`/etc. call throws "cv.Mat is not a constructor" forever. Confirmed
// with isolated minimal repros in both a Worker and a main-thread script.
//
// Fix: go through `cvModule.default` — the actual mutable Emscripten module object at
// runtime — instead of the namespace import itself. `cv` below is a local const, not an
// import specifier, so ordinary property assignment on it is legal and actually reaches
// the runtime object. Confirmed working in both contexts once fixed; kept execution on
// the main thread anyway (see loader.ts's equivalent pdf.js note) since a Worker-hosted
// nested esbuild pass for this exact package has its own separate strictness quirks
// (the "Cannot assign to import" build error above) that are simplest to avoid entirely
// by not re-bundling this package for a Worker target at all.
//
// Trade-off: detect/filter/dewarp now run on the UI thread instead of off it. Each call
// is a single bounded operation (one page's worth of Sauvola/connected-components work,
// spec §17 budgets ~150 ms), so this is a UX regression (brief UI block) rather than a
// correctness one — tracked as follow-up work, not silently accepted as fine.

import * as cvModule from '@techstark/opencv-js'
import type { Box } from '@core/geometry'
import { FilterMode } from '@core/enums'
import type { PageProcessIntent } from '@core/document_state'
import { Mode } from '@core/enums'
import {
  BORDER_FRAC, MIN_COMP_FRAC, DETECT_MAX_PX, CLEAN_AMOUNT,
  CC_CONNECTIVITY, BG_KERNEL_SIZE, SAUVOLA_WINDOW, SAUVOLA_R,
  BW_STRENGTH, SHARPEN_STRENGTH,
} from '@core/constants'

const cv = (cvModule as unknown as { default: typeof cvModule }).default

// `cv.Mat` cannot be used as a *type* (cv is a value, not a TS namespace) — alias it via
// ReturnType<typeof cv.matFromImageData>, as elsewhere in this file.
type Mat = ReturnType<typeof cv.matFromImageData>

let _cv_ready = false

// ONNX session for dewarp — loaded once on first dewarp call
let _onnx_session: unknown = null

async function ensure_cv(): Promise<void> {
  if (_cv_ready) return
  await new Promise<void>((resolve): void => {
    cv.onRuntimeInitialized = (): void => { _cv_ready = true; resolve() }
    // Fallback timeout in case the callback doesn't fire (matches prior behaviour)
    setTimeout(() => { if (!_cv_ready) { _cv_ready = true; resolve() } }, 10_000)
  })
}

async function ensure_onnx(): Promise<void> {
  if (_onnx_session) return
  try {
    const ort = await import('onnxruntime-web')
    // Try IndexedDB cache first, then CDN
    const MODEL_URL = 'https://cdn.jsdelivr.net/gh/janfrode/docuwarp@main/model.onnx'
    const bytes = await fetch_with_idb_cache('docuwarp-model-v1', MODEL_URL)
    _onnx_session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
    })
  } catch (e) {
    throw new Error(`Failed to load ONNX dewarp model: ${String(e)}`)
  }
}

// ---------------------------------------------------------------------------
// Public entry points (called directly from loader.ts — no postMessage RPC)
// ---------------------------------------------------------------------------

export async function detect_content_async(
  bitmap: ImageBitmap, page_w: number, page_h: number, _mode: Mode,
): Promise<Box> {
  await ensure_cv()
  return detect_content(bitmap, page_w, page_h)
}

export async function process_page_async(
  bitmap: ImageBitmap, intent: PageProcessIntent, supersample: number,
): Promise<ImageBitmap> {
  await ensure_cv()
  if (intent.dewarp) await ensure_onnx()
  return process_page(bitmap, intent, supersample)
}

// ---------------------------------------------------------------------------
// Detection (spec §8)
// ---------------------------------------------------------------------------

// Real Sauvola threshold: T = mean*(1 + k*(std/R - 1)) over a window x window box filter,
// computed with cv.boxFilter (O(N), integral-image based — same algorithm class as desktop's
// core/imaging.py `_sauvola_threshold`, spec §17). Returns an ink mask (uint8, 255 = ink).
// `flat` must be a single-channel CV_8U Mat (illumination-flattened grayscale). Caller owns
// and deletes `flat`; this function deletes all of its own intermediates.
function sauvola_ink_mask(flat: Mat, window: number, k: number): Mat {
  const win = window | 1
  const sz = new cv.Size(win, win)
  const anchor = new cv.Point(-1, -1)

  const f32 = new cv.Mat()
  flat.convertTo(f32, Number(cv.CV_32F))

  const mean = new cv.Mat()
  cv.boxFilter(f32, mean, Number(cv.CV_32F), sz, anchor, true, Number(cv.BORDER_REFLECT_101))

  const sq = new cv.Mat()
  cv.multiply(f32, f32, sq)
  f32.delete()
  const sq_mean = new cv.Mat()
  cv.boxFilter(sq, sq_mean, Number(cv.CV_32F), sz, anchor, true, Number(cv.BORDER_REFLECT_101))
  sq.delete()

  const mean_sq = new cv.Mat()
  cv.multiply(mean, mean, mean_sq)
  const variance = new cv.Mat()
  cv.subtract(sq_mean, mean_sq, variance)
  sq_mean.delete(); mean_sq.delete()
  cv.threshold(variance, variance, 0, 0, Number(cv.THRESH_TOZERO))   // clip(...,0,None)
  const std = new cv.Mat()
  cv.sqrt(variance, std)
  variance.delete()

  // T = mean*(1-k) + (k/R)*mean*std
  const term_a = new cv.Mat()
  mean.convertTo(term_a, Number(cv.CV_32F), 1 - k, 0)
  const mean_std = new cv.Mat()
  cv.multiply(mean, std, mean_std)
  std.delete(); mean.delete()
  const term_b = new cv.Mat()
  mean_std.convertTo(term_b, Number(cv.CV_32F), k / SAUVOLA_R, 0)
  mean_std.delete()
  const threshold = new cv.Mat()
  cv.add(term_a, term_b, threshold)
  term_a.delete(); term_b.delete()

  // ink = flat < T  <=>  (flat_f32 - T) <= 0
  const flat_f32 = new cv.Mat()
  flat.convertTo(flat_f32, Number(cv.CV_32F))
  const diff = new cv.Mat()
  cv.subtract(flat_f32, threshold, diff)
  flat_f32.delete(); threshold.delete()
  const mask = new cv.Mat()
  cv.threshold(diff, mask, 0, 255, Number(cv.THRESH_BINARY_INV))
  diff.delete()
  const mask_u8 = new cv.Mat()
  mask.convertTo(mask_u8, Number(cv.CV_8U))
  mask.delete()
  return mask_u8
}

// Illumination flatten: divide by a large-kernel morphological close (imaging.py:118-121),
// shared by detect and both filter modes.
function illumination_flatten(gray: Mat, kernel_size: number): Mat {
  const k = kernel_size | 1
  const se = cv.getStructuringElement(Number(cv.MORPH_ELLIPSE), new cv.Size(k, k))
  const bg = new cv.Mat()
  cv.morphologyEx(gray, bg, Number(cv.MORPH_CLOSE), se)
  se.delete()
  const gray_f = new cv.Mat(); gray.convertTo(gray_f, Number(cv.CV_32F))
  const bg_f = new cv.Mat(); bg.convertTo(bg_f, Number(cv.CV_32F), 1, 1e-6)
  bg.delete()
  const ratio = new cv.Mat()
  cv.divide(gray_f, bg_f, ratio, 255)
  gray_f.delete(); bg_f.delete()
  const flat = new cv.Mat()
  ratio.convertTo(flat, Number(cv.CV_8U))
  ratio.delete()
  return flat
}

// clean_document_bilevel equivalent (imaging.py:90-140), minus the 2x supersample refinement
// step (tracked as a residual, non-correctness fidelity note — see ARCHITECTURE.md §9).
// Returns a bilevel Mat: ink=0, background=255.
function clean_document_bilevel(gray: Mat, k: number, min_area: number, window: number,
  bg_kernel: number): Mat {
  const flat = illumination_flatten(gray, bg_kernel)
  const ink = sauvola_ink_mask(flat, window, k)
  flat.delete()

  let keep_mask = ink
  if (min_area > 0) {
    const labels = new cv.Mat(); const stats = new cv.Mat(); const ctroids = new cv.Mat()
    cv.connectedComponentsWithStats(ink, labels, stats, ctroids, CC_CONNECTIVITY, Number(cv.CV_32S))
    const n = stats.rows
    // Single-pass LUT over raw label data (O(pixels), not O(components * pixels) — despeckle
    // must stay fast per spec §17's "single-pass despeckle" performance target).
    const keep_label = new Uint8Array(n)
    for (let i = 1; i < n; i++) {
      keep_label[i] = stats.intAt(i, Number(cv.CC_STAT_AREA)) >= min_area ? 1 : 0
    }
    const label_data = labels.data32S
    const filtered = new cv.Mat(ink.rows, ink.cols, Number(cv.CV_8U))
    const out = filtered.data
    for (let p = 0; p < label_data.length; p++) {
      out[p] = keep_label[label_data[p] as number] ? 255 : 0   // noUncheckedIndexedAccess
    }
    labels.delete(); stats.delete(); ctroids.delete()
    ink.delete()
    keep_mask = filtered
  }

  // hi = 255 everywhere, 0 where keep_mask is set (ink)
  const hi = new cv.Mat(keep_mask.rows, keep_mask.cols, Number(cv.CV_8U), new cv.Scalar(255))
  hi.setTo(new cv.Scalar(0), keep_mask)
  keep_mask.delete()
  return hi
}

function detect_content(bitmap: ImageBitmap, page_w: number, page_h: number): Box {
  const scale  = Math.min(1, DETECT_MAX_PX / Math.max(page_w, page_h))
  const dw     = Math.round(page_w * scale)
  const dh     = Math.round(page_h * scale)

  const canvas = new OffscreenCanvas(dw, dh)
  const ctx    = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.drawImage(bitmap, 0, 0, dw, dh)
  const img_data = ctx.getImageData(0, 0, dw, dh)

  const src  = cv.matFromImageData(img_data)
  const gray = new cv.Mat()
  cv.cvtColor(src, gray, Number(cv.COLOR_RGBA2GRAY))
  src.delete()

  // Detection runs clean_document_bilevel at the default (strength 2) params, same as
  // desktop's detect path (spec §8: "content_box over a real Sauvola filter
  // (clean_document_bilevel)"), then bounds the kept ink like core/imaging.py content_box().
  const bilevel = clean_document_bilevel(gray, BW_STRENGTH[2].k, BW_STRENGTH[2].minArea,
    SAUVOLA_WINDOW, BG_KERNEL_SIZE)
  gray.delete()

  const ink = new cv.Mat()
  cv.threshold(bilevel, ink, 127, 255, Number(cv.THRESH_BINARY_INV))   // ink(0) -> 255
  bilevel.delete()

  const labels  = new cv.Mat()
  const stats   = new cv.Mat()
  const ctroids = new cv.Mat()
  cv.connectedComponentsWithStats(ink, labels, stats, ctroids, CC_CONNECTIVITY, Number(cv.CV_32S))
  ink.delete()

  const page_area = dw * dh
  const min_area  = Math.max(8, MIN_COMP_FRAC * page_area)
  const border_x  = Math.round(BORDER_FRAC * Math.min(dw, dh))
  const border_y  = border_x

  const keep: Array<{ x: number; y: number; w: number; h: number }> = []
  const n = stats.rows
  for (let i = 1; i < n; i++) {   // skip label 0 (background)
    const x = stats.intAt(i, Number(cv.CC_STAT_LEFT))
    const y = stats.intAt(i, Number(cv.CC_STAT_TOP))
    const w = stats.intAt(i, Number(cv.CC_STAT_WIDTH))
    const h = stats.intAt(i, Number(cv.CC_STAT_HEIGHT))
    const a = stats.intAt(i, Number(cv.CC_STAT_AREA))
    if (a < min_area) continue
    if (x <= border_x || y <= border_y || x + w >= dw - border_x || y + h >= dh - border_y) continue
    keep.push({ x, y, w, h })
  }

  // Fallback (content_box, imaging.py:206-212): border-touching components allowed if nothing
  // else survives.
  if (keep.length === 0) {
    for (let i = 1; i < n; i++) {
      const a = stats.intAt(i, Number(cv.CC_STAT_AREA))
      if (a < min_area) continue
      keep.push({
        x: stats.intAt(i, Number(cv.CC_STAT_LEFT)), y: stats.intAt(i, Number(cv.CC_STAT_TOP)),
        w: stats.intAt(i, Number(cv.CC_STAT_WIDTH)), h: stats.intAt(i, Number(cv.CC_STAT_HEIGHT)),
      })
    }
  }
  labels.delete(); stats.delete(); ctroids.delete()

  if (keep.length === 0) {
    return { x0: 0, y0: 0, x1: page_w, y1: page_h }   // no ink at all -> full page (spec §8)
  }

  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
  for (const c of keep) {
    if (c.x < bx0)         bx0 = c.x
    if (c.y < by0)         by0 = c.y
    if (c.x + c.w > bx1)  bx1 = c.x + c.w
    if (c.y + c.h > by1)  by1 = c.y + c.h
  }

  return {
    x0: bx0 / scale,
    y0: by0 / scale,
    x1: bx1 / scale,
    y1: by1 / scale,
  }
}

// ---------------------------------------------------------------------------
// Scan processing (spec §10)
// ---------------------------------------------------------------------------

function process_page(
  src_bitmap: ImageBitmap,
  intent: PageProcessIntent,
  supersample: number,
): ImageBitmap {
  const { dewarp, filter } = intent
  const w = src_bitmap.width, h = src_bitmap.height

  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.drawImage(src_bitmap, 0, 0)
  const img_data = ctx.getImageData(0, 0, w, h)
  let mat = cv.matFromImageData(img_data)

  if (dewarp && _onnx_session) {
    mat = apply_dewarp(mat, supersample)
  }

  if (filter) {
    const [mode, strength] = filter
    mat = apply_filter_mat(mat, mode, strength)
  }

  const out_canvas = new OffscreenCanvas(mat.cols, mat.rows)
  const out_ctx = out_canvas.getContext('2d')
  if (!out_ctx) throw new Error('2d context unavailable')
  const out_data = new ImageData(
    new Uint8ClampedArray(mat.data.buffer as ArrayBuffer),
    mat.cols, mat.rows)
  out_ctx.putImageData(out_data, 0, 0)
  mat.delete()

  return out_canvas.transferToImageBitmap()
}

function apply_filter_mat(
  src: ReturnType<typeof cv.matFromImageData>,
  mode: FilterMode,
  strength: number,
): ReturnType<typeof cv.matFromImageData> {
  const gray = new cv.Mat()
  cv.cvtColor(src, gray, Number(cv.COLOR_RGBA2GRAY))
  src.delete()

  if (mode === FilterMode.BW) {
    // Real Sauvola bilevel filter (imaging.py clean_document_bilevel), strength -> (k, minArea).
    const cfg = BW_STRENGTH[strength as 1 | 2 | 3]
    const binary = clean_document_bilevel(gray, cfg.k, cfg.minArea, SAUVOLA_WINDOW, BG_KERNEL_SIZE)
    gray.delete()
    const rgba = new cv.Mat()
    cv.cvtColor(binary, rgba, Number(cv.COLOR_GRAY2RGBA))
    binary.delete()
    return rgba
  }

  // Sharpen (imaging.py sharpen_grayscale, imaging.py:219-237): flatten -> bilateral denoise
  // (strength-scaled) -> Gaussian blur (strength-scaled radius) -> unsharp mask (CLEAN_AMOUNT
  // gain). Strength drives denoise/blur radius, not just the unsharp gain (regression fix —
  // a fixed-denoise Sharpen amplified scan noise at high strength).
  const cfg = SHARPEN_STRENGTH[strength as 1 | 2 | 3]
  const amount = CLEAN_AMOUNT[strength as 1 | 2 | 3]
  const flat = illumination_flatten(gray, BG_KERNEL_SIZE)
  gray.delete()
  const denoised = new cv.Mat()
  cv.bilateralFilter(flat, denoised, cfg.d, cfg.sigmaColor, cfg.sigmaSpace)
  flat.delete()
  const blurred = new cv.Mat()
  cv.GaussianBlur(denoised, blurred, new cv.Size(0, 0), cfg.blurSigma)
  const sharpened = new cv.Mat()
  cv.addWeighted(denoised, 1 + amount, blurred, -amount, 0, sharpened)
  denoised.delete(); blurred.delete()
  const rgba = new cv.Mat()
  cv.cvtColor(sharpened, rgba, Number(cv.COLOR_GRAY2RGBA))
  sharpened.delete()
  return rgba
}

function apply_dewarp(
  src: ReturnType<typeof cv.matFromImageData>,
  _supersample: number,
): ReturnType<typeof cv.matFromImageData> {
  // ONNX-based mesh dewarp — placeholder stub; full implementation in Phase 2
  // Currently returns the source unchanged if session is available
  // TODO: implement ort.InferenceSession.run() → mesh field → cv.remap
  return src
}

// ---------------------------------------------------------------------------
// IndexedDB cache for ONNX model
// ---------------------------------------------------------------------------

async function fetch_with_idb_cache(key: string, url: string): Promise<ArrayBuffer> {
  const db  = await open_idb()
  const tx  = db.transaction('models', 'readonly')
  const req = tx.objectStore('models').get(key) as IDBRequest<ArrayBuffer | undefined>
  const cached = await idb_req(req)
  if (cached) return cached

  const resp  = await fetch(url)
  const bytes = await resp.arrayBuffer()

  const tx2   = db.transaction('models', 'readwrite')
  tx2.objectStore('models').put(bytes, key)
  await idb_tx(tx2)
  return bytes
}

function open_idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('smartcrop-models', 1)
    req.onupgradeneeded = (): void => { req.result.createObjectStore('models') }
    req.onsuccess = (): void => { resolve(req.result) }
    req.onerror   = (): void => { reject(req.error ?? new Error('IndexedDB open failed')) }
  })
}

function idb_req<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = (): void => { resolve(req.result) }
    req.onerror   = (): void => { reject(req.error ?? new Error('IndexedDB request failed')) }
  })
}

function idb_tx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = (): void => { resolve() }
    tx.onerror    = (): void => { reject(tx.error ?? new Error('IndexedDB transaction failed')) }
  })
}
