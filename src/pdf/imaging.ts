// imaging.ts — OpenCV.js scan processing: detect (Sauvola/connected-components) and the B/W and
// Sharpen filters. Dewarp (ONNX) lives in ./dewarp.ts; the cv.Mat runtime access point (and why
// this all runs on the main thread, not a Worker) lives in ./cv.ts.

import type { Box } from '@core/geometry'
import { FilterMode } from '@core/enums'
import type { PageProcessIntent } from '@core/document_state'
import { Mode } from '@core/enums'
import { CONTEXT_2D_UNAVAILABLE } from '@core/errors'
import {
  BORDER_FRAC, MIN_COMP_FRAC, DETECT_MAX_PX, CLEAN_AMOUNT,
  CC_CONNECTIVITY, BG_KERNEL_SIZE, BG_DOWNSCALE, SAUVOLA_WINDOW, SAUVOLA_R,
  BW_STRENGTH, SHARPEN_STRENGTH, DETECT_CLOSE_W, DETECT_CLOSE_H,
  DESKEW_MAX_DEG, DESKEW_CLASSIFY_DOWNSCALE_PX, DBNET_MAX_SIDE_PX,
} from '@core/constants'
import { classify_warp, needs_skew_trapezoid_correction } from '@core/deskew_classify'
import { cv, type Mat, ensure_cv } from './cv'
import { ensure_onnx, apply_dewarp } from './dewarp'
import { estimate_deskew } from './deskew'
import { ensure_dbnet, detect_text_lines } from './dbnet'
import { estimate_vanishing_point, vp_edge_angles } from './vanishing_point'
import { apply_vp_correction } from './vp_correct'

// ---------------------------------------------------------------------------
// Public entry points (called directly from loader.ts — no postMessage RPC)
// ---------------------------------------------------------------------------

export async function detect_content_async(
  bitmap: ImageBitmap, page_w: number, page_h: number, _mode: Mode, region?: Box,
): Promise<Box> {
  await ensure_cv()
  return detect_content(bitmap, page_w, page_h, region)
}

export async function process_page_async(
  bitmap: ImageBitmap, intent: PageProcessIntent, supersample: number,
): Promise<ImageBitmap> {
  await ensure_cv()
  // ensure_onnx() is no longer unconditional here (spec-web §7.1a) — the classic-CV classifier
  // inside process_page decides per page whether ONNX is even needed, and calls ensure_onnx()
  // itself only for a page that classifies WARPED. A page that's flat or only skewed never pays
  // the ONNX model fetch/init cost at all.
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
//
// The morphological-close background is estimated on a 1/BG_DOWNSCALE copy then upscaled, NOT at
// full resolution (spec-web §W2 row 12): opencv.js's single-thread WASM `morphologyEx` with a 51×51
// kernel is O(pixels × kernel²) with no large-kernel/parallel optimization — full-res it is the
// single dominant cost of the B/W filter and Auto-detect (0.6–9 s/page) and SIMD does not help it.
// The background is low-frequency so the downscale is near-lossless: the flat image differs by up to
// ~78/255 at a few high-contrast edges but the final bilevel (after Sauvola) is ~95% identical to
// the full-res result — the same agreement opencv.js already has vs opencv-python. ~36× faster.
function illumination_flatten(gray: Mat, kernel_size: number): Mat {
  const bg = morph_close_background(gray, kernel_size | 1)
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

// Morphological-close background estimate on a downscaled copy (see illumination_flatten's note).
// Falls back to a full-resolution close only when the page is already small enough that the
// downscaled morphology kernel would degenerate (< 3 px) — there the full close is already cheap.
function morph_close_background(gray: Mat, kernel: number): Mat {
  const scale: number = BG_DOWNSCALE
  const sw = Math.round(gray.cols / scale)
  const sh = Math.round(gray.rows / scale)
  const k_small = Math.round(kernel / scale) | 1
  if (scale <= 1 || k_small < 3 || sw < 1 || sh < 1) {
    const se = cv.getStructuringElement(Number(cv.MORPH_ELLIPSE), new cv.Size(kernel, kernel))
    const bg = new cv.Mat()
    cv.morphologyEx(gray, bg, Number(cv.MORPH_CLOSE), se)
    se.delete()
    return bg
  }
  const small = new cv.Mat()
  cv.resize(gray, small, new cv.Size(sw, sh), 0, 0, Number(cv.INTER_AREA))
  const se = cv.getStructuringElement(Number(cv.MORPH_ELLIPSE), new cv.Size(k_small, k_small))
  const bg_small = new cv.Mat()
  cv.morphologyEx(small, bg_small, Number(cv.MORPH_CLOSE), se)
  se.delete(); small.delete()
  const bg = new cv.Mat()
  cv.resize(bg_small, bg, new cv.Size(gray.cols, gray.rows), 0, 0, Number(cv.INTER_LINEAR))
  bg_small.delete()
  return bg
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

// `region`, if given (split-mode per-region detect, spec §5a), scopes detection to that
// page-unit sub-rectangle instead of the whole page: only that slice of `bitmap` is sampled, and
// the returned box is translated back into page (not region-local) coordinates. Absent = whole
// page, the pre-split-detect behaviour.
function detect_content(bitmap: ImageBitmap, page_w: number, page_h: number, region?: Box): Box {
  const rx0 = region?.x0 ?? 0, ry0 = region?.y0 ?? 0
  const rw  = region ? region.x1 - region.x0 : page_w
  const rh  = region ? region.y1 - region.y0 : page_h
  const scale_full_x = bitmap.width / page_w, scale_full_y = bitmap.height / page_h

  const scale  = Math.min(1, DETECT_MAX_PX / Math.max(rw, rh))
  const dw     = Math.round(rw * scale)
  const dh     = Math.round(rh * scale)

  const canvas = new OffscreenCanvas(dw, dh)
  const ctx    = canvas.getContext('2d')
  if (!ctx) throw new Error(CONTEXT_2D_UNAVAILABLE)
  ctx.drawImage(bitmap, rx0 * scale_full_x, ry0 * scale_full_y, rw * scale_full_x, rh * scale_full_y,
    0, 0, dw, dh)
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

  // Bridge inter-letter/inter-word gaps so a text LINE forms one connected component (see
  // DETECT_CLOSE_W/H) — without this, individual glyphs never clear MIN_COMP_FRAC and real text
  // is discarded from the content box entirely.
  const se = cv.getStructuringElement(Number(cv.MORPH_ELLIPSE), new cv.Size(DETECT_CLOSE_W, DETECT_CLOSE_H))
  const closed = new cv.Mat()
  cv.morphologyEx(ink, closed, Number(cv.MORPH_CLOSE), se)
  se.delete(); ink.delete()

  const labels  = new cv.Mat()
  const stats   = new cv.Mat()
  const ctroids = new cv.Mat()
  cv.connectedComponentsWithStats(closed, labels, stats, ctroids, CC_CONNECTIVITY, Number(cv.CV_32S))
  closed.delete()

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
    // no ink at all -> the whole detected area (region, or full page — spec §8)
    return { x0: rx0, y0: ry0, x1: rx0 + rw, y1: ry0 + rh }
  }

  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
  for (const c of keep) {
    if (c.x < bx0)         bx0 = c.x
    if (c.y < by0)         by0 = c.y
    if (c.x + c.w > bx1)  bx1 = c.x + c.w
    if (c.y + c.h > by1)  by1 = c.y + c.h
  }

  return {
    x0: rx0 + bx0 / scale,
    y0: ry0 + by0 / scale,
    x1: rx0 + bx1 / scale,
    y1: ry0 + by1 / scale,
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
  if (!ctx) throw new Error(CONTEXT_2D_UNAVAILABLE)
  ctx.drawImage(src_bitmap, 0, 0)
  const img_data = ctx.getImageData(0, 0, w, h)
  let mat = cv.matFromImageData(img_data)

  // Dewarp & Deskew (spec-web §7.1): a page that's already flat or only incidentally skewed/
  // keystoned would otherwise be needlessly re-warped by ONNX, which can introduce its own small
  // residual distortion. §7.1a's cheap classic-CV classifier decides WARPED (full ONNX mesh-
  // unwarp, unchanged) vs not — a not-warped page then gets §7.1b's text-line-detection +
  // vanishing-point estimate, which corrects skew AND trapezoid via ONE mechanism (vp_correct.ts)
  // or no-ops if neither clears its threshold. ensure_onnx/ensure_dbnet are called here, not
  // eagerly in process_page_async, so a page never pays for a model it doesn't end up needing.
  if (dewarp) {
    const { sharpness } = estimate_deskew(mat, DESKEW_CLASSIFY_DOWNSCALE_PX, DESKEW_MAX_DEG)
    if (classify_warp(sharpness)) {
      await ensure_onnx()
      mat = await apply_dewarp(mat, supersample)
    } else {
      await ensure_dbnet()
      const { segments, confidences, weights } = await detect_text_lines(mat, DBNET_MAX_SIDE_PX)
      const vp = estimate_vanishing_point(segments, confidences, weights)
      // vp === null (too few detected text lines, e.g. a near-blank page) -> safe no-op, same as
      // a page whose fit clears neither threshold below.
      if (vp) {
        const { center, lr_delta, tb_delta } = vp_edge_angles(vp.v, segments)
        if (needs_skew_trapezoid_correction(center, lr_delta, tb_delta)) {
          mat = apply_vp_correction(mat, vp.v)
        }
      }
    }
  }

  if (filter) {
    const [mode, strength] = filter
    mat = apply_filter_mat(mat, mode, strength)
  }

  const out_canvas = new OffscreenCanvas(mat.cols, mat.rows)
  const out_ctx = out_canvas.getContext('2d')
  if (!out_ctx) throw new Error(CONTEXT_2D_UNAVAILABLE)
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
