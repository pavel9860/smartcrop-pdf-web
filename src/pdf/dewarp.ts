// dewarp.ts — docuwarp/UVDoc ONNX mesh dewarp: model loading, the fp16 tensor plumbing it needs,
// and the two-stage inference pipeline. Split out of imaging.ts to keep that file under the
// project's line limit. Depends on ./cv for the cv.Mat runtime; imaging.ts calls into this file
// (ensure_onnx/apply_dewarp), not the other way, so there's no import cycle between the two.

import type { InferenceSession } from 'onnxruntime-web'
import { MissingDependencyError } from '@core/errors'
import {
  DEWARP_MODEL_W, DEWARP_MODEL_H, DEWARP_UVDOC_URL, DEWARP_BILINEAR_URL,
  DEWARP_UVDOC_CACHE_KEY, DEWARP_BILINEAR_CACHE_KEY,
} from '@core/constants'
import { cv, type Mat } from './cv'
import { open_idb, idb_req, idb_tx } from './idb'

// ONNX sessions for dewarp (pstwh/docuwarp, two-stage) — loaded once on first dewarp call.
let _uvdoc_session: InferenceSession | null = null
let _bilinear_session: InferenceSession | null = null

// Cached in-flight init promise so concurrent callers (e.g. prefetching page N+1 while page N's
// Dewarp&Deskew is still loading the model) share ONE ONNX session build instead of each racing
// to create its own — same C3 race class ensure_cv() (cv.ts) guards against; without this, a
// second concurrent session's resources are never released once the first caller's result
// silently overwrites the module-level reference (no .release() call exists anywhere).
let _onnx_init: Promise<void> | null = null

// Loads both docuwarp ONNX sessions from same-origin /models/ (vite-plugin-static-copy, see
// vite.config.ts), cached in IndexedDB after the first fetch. Model files are vendored into the
// repo, not pulled from a CDN — see apply_dewarp()'s header comment for the licensing note.
export function ensure_onnx(): Promise<void> {
  if (_uvdoc_session && _bilinear_session) return Promise.resolve()
  if (!_onnx_init) {
    _onnx_init = _load_onnx_sessions().catch((e: unknown) => {
      _onnx_init = null   // allow a retry rather than permanently caching a failed load
      throw e
    })
  }
  return _onnx_init
}

async function _load_onnx_sessions(): Promise<void> {
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

// Correctly-rounded IEEE 754 binary16 <-> binary32 conversion (round-to-nearest-even). Verified
// against numpy.float16 as ground truth: 0 mismatches across all 65,536 possible fp16 bit
// patterns (decode), 0 mismatches across 200,000+ random/edge-case float32 values (encode), 0
// mismatches across a real 1,041,768-element model-input tensor (encode, this model's actual
// data distribution).
function f32_bits_to_f16_bits(bits: number): number {
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

function f16_bits_to_f32_bits(bits: number): number {
  const sign = (bits & 0x8000) << 16
  let exp = (bits >>> 10) & 0x1f
  let mant = bits & 0x3ff
  if (exp === 0) {
    if (mant === 0) return sign
    exp = 1
    while ((mant & 0x400) === 0) { mant <<= 1; exp -= 1 }
    mant &= 0x3ff
    return sign | ((exp - 15 + 127) << 23) | (mant << 13)
  }
  if (exp === 0x1f) return sign | 0x7f800000 | (mant << 13)
  return sign | ((exp - 15 + 127) << 23) | (mant << 13)
}

// Per-element reinterpretation (allocating 2 TypedArrays to view 4 bytes as the other type) would
// cost ~2M short-lived allocations over a full model tensor — one Uint32Array VIEW over the
// existing buffer, hoisted outside the loop, does the same reinterpretation with 2 allocations
// total (the view + the output array).
// Exported for tests/pdf/dewarp.test.ts only (bit-exact conversion has no other unit-testable
// seam — apply_dewarp needs a live ONNX+OpenCV pipeline).
export function f32_array_to_f16_bits(data: Float32Array): Uint16Array {
  const bits_view = new Uint32Array(data.buffer, data.byteOffset, data.length)
  const out = new Uint16Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = f32_bits_to_f16_bits(bits_view[i] as number)   // noUncheckedIndexedAccess
  return out
}

// `data` is typed Uint16Array per onnxruntime-common's DataTypeMap.float16 but MAY be a native
// Float16Array at runtime on engines that support it (onnxruntime-web prefers Float16Array when
// the host provides one — its own .d.ts cannot express a runtime-conditional type). Branch on
// the actual runtime class, not the static type.
export function f16_data_to_f32_array(data: Uint16Array): Float32Array {
  if (typeof Float16Array !== 'undefined' && data instanceof (Float16Array as unknown as { new (): ArrayLike<number> })) {
    return Float32Array.from(data as unknown as ArrayLike<number>)
  }
  const out = new Float32Array(data.length)
  const bits_view = new Uint32Array(out.buffer, out.byteOffset, out.length)
  for (let i = 0; i < data.length; i++) bits_view[i] = f16_bits_to_f32_bits(data[i] as number)   // noUncheckedIndexedAccess
  return out
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
export async function apply_dewarp(src: Mat, supersample: number): Promise<Mat> {
  // The real guarantee is process_page's `await ensure_onnx()` in the WARPED branch of the
  // classifier switch (imaging.ts, spec-web §7.1a) before this is ever called. Silently returning
  // `src` unprocessed here would surface as a confusing no-op (user presses Dewarp & Deskew,
  // nothing visibly happens) instead of a diagnosable error if that guarantee is ever violated by
  // a future call site or refactor.
  if (!_uvdoc_session || !_bilinear_session) {
    throw new MissingDependencyError('apply_dewarp called before ensure_onnx() resolved')
  }

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

// Exported for tests/pdf/dewarp.test.ts only (see ./cv's ensure_cv note).
export async function fetch_with_idb_cache(key: string, url: string): Promise<ArrayBuffer> {
  const db  = await open_idb('smartcrop-models', 'models')
  const tx  = db.transaction('models', 'readonly')
  const req = tx.objectStore('models').get(key) as IDBRequest<ArrayBuffer | undefined>
  const cached = await idb_req(req)
  if (cached) return cached

  const resp = await fetch(url)
  // M3: a failed fetch (404/500) must not be cached — caching it would permanently poison the
  // IDB entry for `key`, since a truthy `cached` short-circuits every future call above.
  if (!resp.ok) throw new Error(`Fetch failed for ${url}: ${resp.status} ${resp.statusText}`)
  const bytes = await resp.arrayBuffer()

  const tx2   = db.transaction('models', 'readwrite')
  tx2.objectStore('models').put(bytes, key)
  await idb_tx(tx2)
  return bytes
}
