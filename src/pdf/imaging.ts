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
import { MissingDependencyError } from '@core/errors'
import {
  BORDER_FRAC, MIN_COMP_FRAC, DETECT_MAX_PX, CLEAN_AMOUNT,
  CC_CONNECTIVITY, BG_KERNEL_SIZE, SAUVOLA_WINDOW, SAUVOLA_R,
  BW_STRENGTH, SHARPEN_STRENGTH,
  DEWARP_MODEL_W, DEWARP_MODEL_H, DEWARP_UVDOC_URL, DEWARP_BILINEAR_URL,
  DEWARP_UVDOC_CACHE_KEY, DEWARP_BILINEAR_CACHE_KEY,
} from '@core/constants'
// Type-only: erased at compile time, so this does NOT defeat the lazy dynamic import() below —
// onnxruntime-web's real module code is only ever loaded inside ensure_onnx()/apply_dewarp().
import type { InferenceSession } from 'onnxruntime-web'

const cv = (cvModule as unknown as { default: typeof cvModule }).default

// `cv.Mat` cannot be used as a *type* (cv is a value, not a TS namespace) — alias it via
// ReturnType<typeof cv.matFromImageData>, as elsewhere in this file.
type Mat = ReturnType<typeof cv.matFromImageData>

let _cv_ready = false

// ONNX sessions for dewarp (pstwh/docuwarp, two-stage) — loaded once on first dewarp call.
let _uvdoc_session: InferenceSession | null = null
let _bilinear_session: InferenceSession | null = null

async function ensure_cv(): Promise<void> {
  if (_cv_ready) return
  await new Promise<void>((resolve): void => {
    cv.onRuntimeInitialized = (): void => { _cv_ready = true; resolve() }
    // Fallback timeout in case the callback doesn't fire (matches prior behaviour)
    setTimeout(() => { if (!_cv_ready) { _cv_ready = true; resolve() } }, 10_000)
  })
}

// Loads both docuwarp ONNX sessions from same-origin /models/ (vite-plugin-static-copy, see
// vite.config.ts), cached in IndexedDB after the first fetch. Model files are vendored into the
// repo, not pulled from a CDN — see apply_dewarp()'s header comment for the licensing note.
async function ensure_onnx(): Promise<void> {
  if (_uvdoc_session && _bilinear_session) return
  try {
    const ort = await import('onnxruntime-web/webgpu')
    // GH Pages cannot send COOP/COEP, so SharedArrayBuffer (multi-threaded WASM) is
    // unavailable — force the single-thread WASM build. WebGPU needs no SAB either and is
    // tried first where the browser exposes it; single-thread WASM+SIMD is the fallback.
    ort.env.wasm.numThreads = 1
    // Only request WebGPU when the browser exposes it; otherwise ORT would have to fall back
    // internally. Explicit selection keeps behaviour deterministic across Firefox/Safari.
    const has_webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator
    const execution_providers = has_webgpu ? ['webgpu', 'wasm'] : ['wasm']
    // One-time diagnostic (TODO §17): dewarp on the 1-thread WASM EP costs seconds/page — this
    // line lets a user verify in the console whether WebGPU was even requested on their machine.
    console.info('[smartcrop] ONNX EPs requested:', execution_providers.join(','),
      '— webgpu available:', has_webgpu)
    // Prefix with the deployment base so the vendored model weights resolve under a GH Pages
    // project-page subpath (see vite.config.ts base / constants.ts note). Does not change ORT
    // execution behaviour — same weights, same providers, only the fetch URL adapts.
    const base = import.meta.env.BASE_URL
    const [uvdoc_bytes, bilinear_bytes] = await Promise.all([
      fetch_with_idb_cache(DEWARP_UVDOC_CACHE_KEY, base + DEWARP_UVDOC_URL),
      fetch_with_idb_cache(DEWARP_BILINEAR_CACHE_KEY, base + DEWARP_BILINEAR_URL),
    ])
    const [uvdoc_session, bilinear_session] = await Promise.all([
      ort.InferenceSession.create(new Uint8Array(uvdoc_bytes), { executionProviders: execution_providers }),
      ort.InferenceSession.create(new Uint8Array(bilinear_bytes), { executionProviders: execution_providers }),
    ])
    _uvdoc_session = uvdoc_session
    _bilinear_session = bilinear_session
  } catch (e) {
    throw new MissingDependencyError(`Failed to load the dewarp model: ${String(e)}`)
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

// Native Float16Array support cannot be assumed even on current-generation engines (empirically
// absent from this repo's own CI Node runtime despite broad browser-support claims) — do not
// gate behaviour on `typeof Float16Array`. onnxruntime-web's published types (DataTypeMap.
// float16 = Uint16Array) are treated as authoritative; the constructor.name check below is
// defensive only, for the engines where onnxruntime-web itself substitutes a native
// Float16Array at runtime despite what its own .d.ts promises the caller.
//
// Correctly-rounded IEEE 754 binary16 <-> binary32 conversion (round-to-nearest-even). Verified
// against numpy.float16 as ground truth: 0 mismatches across all 65,536 possible fp16 bit
// patterns (decode), 0 mismatches across 200,000+ random/edge-case float32 values (encode), 0
// mismatches across a real 1,041,768-element model-input tensor (encode, this model's actual
// data distribution) — see docs/SmartCrop_PDF_Specification_Web.md §W2 row 1 for the
// verification method.
function f32_to_f16_bits(val: number): number {
  const f32 = new Float32Array(1); f32[0] = val
  const bits = new Uint32Array(f32.buffer)[0] as number
  const sign = (bits >>> 16) & 0x8000
  const mant32 = bits & 0x007fffff
  const exp = (bits >>> 23) & 0xff
  if (exp === 0xff) return sign | 0x7c00 | (mant32 ? 0x0200 : 0)   // Inf / NaN
  if (exp === 0) return sign   // +-0 or subnormal float32 -> 0 in fp16 (magnitude far below fp16 min)
  const e = exp - 127 + 15
  if (e >= 0x1f) return sign | 0x7c00                              // overflow -> Inf
  if (e <= 0) {
    if (e < -10) return sign                                       // underflow -> 0
    const m = (mant32 | 0x00800000) >>> (14 - e)                   // implicit leading 1, shift into 10-bit mantissa + guard
    const rem = (mant32 | 0x00800000) & ((1 << (14 - e)) - 1)
    const halfway = 1 << (13 - e)
    let out = sign | m
    if (rem > halfway || (rem === halfway && (m & 1))) out += 1
    return out
  }
  const m = mant32 >>> 13
  const rem = mant32 & 0x1fff
  let out = sign | (e << 10) | m
  if (rem > 0x1000 || (rem === 0x1000 && (m & 1))) out += 1
  return out
}

function f16_bits_to_f32(bits: number): number {
  const sign = (bits & 0x8000) << 16
  let exp = (bits >>> 10) & 0x1f
  let mant = bits & 0x3ff
  let u32: number
  if (exp === 0) {
    if (mant === 0) {
      u32 = sign
    } else {
      exp = 1
      while ((mant & 0x400) === 0) { mant <<= 1; exp -= 1 }
      mant &= 0x3ff
      u32 = sign | ((exp - 15 + 127) << 23) | (mant << 13)
    }
  } else if (exp === 0x1f) {
    u32 = sign | 0x7f800000 | (mant << 13)
  } else {
    u32 = sign | ((exp - 15 + 127) << 23) | (mant << 13)
  }
  return new Float32Array(new Uint32Array([u32]).buffer)[0] as number
}

function f32_array_to_f16_bits(data: Float32Array): Uint16Array {
  const out = new Uint16Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = f32_to_f16_bits(data[i] as number)   // noUncheckedIndexedAccess
  return out
}

// `data` is typed Uint16Array per onnxruntime-common's DataTypeMap.float16 but MAY be a native
// Float16Array at runtime on engines that support it (onnxruntime-web prefers Float16Array when
// the host provides one — its own .d.ts cannot express a runtime-conditional type). Branch on
// the actual runtime class, not the static type.
function f16_data_to_f32_array(data: Uint16Array): Float32Array {
  if (typeof Float16Array !== 'undefined' && data instanceof (Float16Array as unknown as { new (): ArrayLike<number> })) {
    return Float32Array.from(data as unknown as ArrayLike<number>)
  }
  const out = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = f16_bits_to_f32(data[i] as number)   // noUncheckedIndexedAccess
  return out
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

async function process_page(
  src_bitmap: ImageBitmap,
  intent: PageProcessIntent,
  supersample: number,
): Promise<ImageBitmap> {
  const { dewarp, filter } = intent
  const w = src_bitmap.width, h = src_bitmap.height

  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.drawImage(src_bitmap, 0, 0)
  const img_data = ctx.getImageData(0, 0, w, h)
  let mat = cv.matFromImageData(img_data)

  if (dewarp && _uvdoc_session && _bilinear_session) {
    mat = await apply_dewarp(mat, supersample)
  }

  if (filter) {
    const [mode, strength] = filter
    mat = apply_filter_mat(mat, mode, strength)
  }

  const out_canvas = new OffscreenCanvas(mat.cols, mat.rows)
  const out_ctx = out_canvas.getContext('2d')
  if (!out_ctx) throw new Error('2d context unavailable')
  // mat.data is a subarray view onto the whole WASM heap, so mat.data.buffer is that ENTIRE heap
  // (length ≠ 4*cols*rows) — `new ImageData(...)` on it threw IndexSizeError and hung dewarp &
  // filters (bug 3). Copy only the mat's own bytes; both filter and dewarp outputs are 8-bit RGBA.
  const out_data = new ImageData(new Uint8ClampedArray(mat.data), mat.cols, mat.rows)
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

// Real docuwarp/UVDoc mesh dewarp (spec §10.1) — two ONNX stages, ported from the actual
// docuwarp package source (github.com/pstwh/docuwarp, unwarp.py Unwarp.prepare_input/
// inference — same tensor names, dtypes, shapes and call order verified against that source):
//  1. uvdoc.onnx: a CNN predicts a coarse (1,2,45,31) warp-field grid from the page downscaled
//     to a FIXED DEWARP_MODEL_W x DEWARP_MODEL_H (a property of the trained weights, not
//     tunable). Runs in fp16 (the model's native input dtype).
//  2. bilinear_unwarping.onnx: upsamples that grid to the target resolution (bilinear,
//     align_corners) and uses it to resample the FULL-resolution source via ONNX GridSample
//     (bilinear, zero padding, align_corners) — no learned weights in this stage.
// `supersample` (spec §15 Dewarp-supersample) requests stage 2's output at supersample x the
// source resolution, then downsamples back via cv.INTER_AREA — this is a deliberate
// reinterpretation of desktop's "renders the page larger before the mesh remap, downsamples
// after" (core/imaging.py docstring): the CNN's input is fixed-size regardless of supersample
// in both ports, so here supersample instead controls the fidelity of stage 2's grid
// upsampling/resample before the final downscale. Not a literal port of the desktop code path —
// flagged as a design adaptation, not a verified parity claim.
//
// Licensing: pstwh/docuwarp itself ships no LICENSE file; the underlying UVDoc weights are
// MIT-licensed (github.com/tanguymagne/UVDoc). Desktop's core/imaging.py already depends on
// this exact PyPI package at runtime — this port carries the same pre-existing exposure
// forward, not a new one.
//
// Numerically cross-checked against a real Python docuwarp reference run on a synthetic test
// image (same two .onnx files, same tensor plumbing): stage 2 alone reproduces the Python
// reference bit-for-bit (0.0 max abs diff) when fed the same grid; the full end-to-end path
// (uvdoc.onnx run under onnxruntime-web/WASM vs Python onnxruntime/CPU) diverges by
// maxAbsDiff=3.5e-2 / meanAbsDiff=6.5e-6 on a [0,1] scale — consistent with expected benign
// cross-engine floating-point noise through a 16M-parameter CNN, not an algorithmic error.
async function apply_dewarp(src: Mat, supersample: number): Promise<Mat> {
  if (!_uvdoc_session || !_bilinear_session) return src   // caller already gates on this; defensive only

  const ort = await import('onnxruntime-web/webgpu')
  const w = src.cols, h = src.rows

  // Stage 1: predict the coarse warp-field grid from a fixed-size downscale of the page.
  // cv.INTER_CUBIC, not canvas smoothing: matches PIL's Image.resize() default filter for
  // RGB images (Resampling.BICUBIC, verified against the pinned pillow==10.4.0 source) more
  // closely than a canvas 2D drawImage downscale would.
  const resized_chw = mat_to_resized_chw_f32(src, DEWARP_MODEL_W, DEWARP_MODEL_H)
  const input_tensor = new ort.Tensor('float16', f32_array_to_f16_bits(resized_chw),
    [1, 3, DEWARP_MODEL_H, DEWARP_MODEL_W])
  const cnn_out = await _uvdoc_session.run({ input: input_tensor })
  const points_raw = cnn_out['output']
  if (!points_raw) throw new MissingDependencyError('Dewarp model returned no "output" tensor')
  // ORT ≥1.19 decodes a float16 output into the new Float16Array (elements are already real
  // floats); older/other builds return a Uint16Array of raw f16 bits. Handle BOTH — the prior
  // code accepted only Uint16Array and threw on Float16Array, breaking dewarp entirely (bug 21).
  const points_bits = points_raw.data
  let points_f32: Float32Array
  if (points_bits instanceof Uint16Array) {
    points_f32 = f16_data_to_f32_array(points_bits)
  } else if (ArrayBuffer.isView(points_bits) && points_bits.constructor.name === 'Float16Array') {
    points_f32 = Float32Array.from(points_bits as unknown as ArrayLike<number>)
  } else {
    throw new MissingDependencyError(`Dewarp model "output" has unexpected dtype: ${points_raw.type}`)
  }
  const points_tensor = new ort.Tensor('float32', points_f32, points_raw.dims)

  // Stage 2: resample the full-resolution source through the (upsampled) grid.
  const target_w = Math.max(1, Math.round(w * supersample))
  const target_h = Math.max(1, Math.round(h * supersample))
  const warped_tensor = new ort.Tensor('float32', mat_to_chw_f32(src), [1, 3, h, w])
  // img_size is (width, height), matching docuwarp's `np.array(image.size)` (PIL .size order) —
  // verified against the actual reference source and its ONNX graph's `img_size` consumer.
  const img_size_tensor = new ort.Tensor('int64',
    BigInt64Array.from([BigInt(target_w), BigInt(target_h)]), [2])

  const bl_out = await _bilinear_session.run({
    warped_img: warped_tensor, point_positions: points_tensor, img_size: img_size_tensor,
  })
  const out_raw = bl_out['output']
  if (!out_raw) throw new MissingDependencyError('Unwarp model returned no "output" tensor')
  const out_data = out_raw.data
  if (!(out_data instanceof Float32Array)) {
    throw new MissingDependencyError(`Unwarp model "output" has unexpected dtype: ${out_raw.type}`)
  }

  let result = chw_f32_to_rgba_mat(out_data, target_w, target_h)
  if (target_w !== w || target_h !== h) {
    const downsampled = new cv.Mat()
    cv.resize(result, downsampled, new cv.Size(w, h), 0, 0, Number(cv.INTER_AREA))
    result.delete()
    result = downsampled
  }
  src.delete()
  return result
}

// RGBA uint8 Mat, native resolution -> planar RGB float32 in [0,1] (mirrors docuwarp's
// `image_array.transpose(2,0,1)/255` on the ORIGINAL, unresized image — alpha dropped, this
// pipeline's alpha channel is always opaque filler, never real data).
function mat_to_chw_f32(mat: Mat): Float32Array {
  const h = mat.rows, w = mat.cols
  const src = mat.data
  const plane = h * w
  const out = new Float32Array(3 * plane)
  for (let p = 0; p < plane; p++) {
    const o = p * 4
    out[p]             = (src[o]     as number) / 255   // noUncheckedIndexedAccess
    out[plane + p]      = (src[o + 1] as number) / 255   // noUncheckedIndexedAccess
    out[2 * plane + p]  = (src[o + 2] as number) / 255   // noUncheckedIndexedAccess
  }
  return out
}

// RGBA uint8 Mat, resized to (target_w, target_h) via bicubic, then -> planar RGB float32 in
// [0,1]. Mirrors docuwarp's `resized_array.transpose(2,0,1)/255`.
function mat_to_resized_chw_f32(mat: Mat, target_w: number, target_h: number): Float32Array {
  const resized = new cv.Mat()
  cv.resize(mat, resized, new cv.Size(target_w, target_h), 0, 0, Number(cv.INTER_CUBIC))
  const out = mat_to_chw_f32(resized)
  resized.delete()
  return out
}

// Planar RGB float32 in [0,1] -> RGBA uint8 Mat (alpha fully opaque).
function chw_f32_to_rgba_mat(data: Float32Array, w: number, h: number): Mat {
  const plane = w * h
  const out = new cv.Mat(h, w, Number(cv.CV_8UC4))
  const dst = out.data
  for (let p = 0; p < plane; p++) {
    const o = p * 4
    dst[o]     = clamp_u8((data[p]            as number) * 255)   // noUncheckedIndexedAccess
    dst[o + 1] = clamp_u8((data[plane + p]     as number) * 255)   // noUncheckedIndexedAccess
    dst[o + 2] = clamp_u8((data[2 * plane + p] as number) * 255)   // noUncheckedIndexedAccess
    dst[o + 3] = 255
  }
  return out
}

function clamp_u8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
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
