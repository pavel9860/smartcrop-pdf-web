// raster.ts — docuwarp's second stage (grid upsample + GridSample) on a plain RGBA byte array.
// Replaces the weightless bilinear_unwarping.onnx graph: same math (linear align_corners Resize,
// then bilinear align_corners GridSample with zero padding), ~6× faster than running it in ONNX.

const u8 = (v: number): number => v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0

// Bilinear sample of channel ch at (sx, sy); taps outside the image read `border`.
function sample(s: Uint8Array, w: number, h: number, c: number, sx: number, sy: number, out: Uint8Array, o: number, nch: number, border: number): void {
  const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy
  if (x0 >= 0 && y0 >= 0 && x0 < w - 1 && y0 < h - 1) {
    const p = (y0 * w + x0) * c, q = p + w * c
    for (let ch = 0; ch < nch; ch++) {
      out[o + ch] = u8((s[p + ch] as number) * w00 + (s[p + c + ch] as number) * w10 + (s[q + ch] as number) * w01 + (s[q + c + ch] as number) * w11)
    }
    return
  }
  const in_x0 = x0 >= 0 && x0 < w, in_x1 = x0 + 1 >= 0 && x0 + 1 < w, in_y0 = y0 >= 0 && y0 < h, in_y1 = y0 + 1 >= 0 && y0 + 1 < h
  for (let ch = 0; ch < nch; ch++) {
    const v00 = in_x0 && in_y0 ? s[(y0 * w + x0) * c + ch] as number : border
    const v10 = in_x1 && in_y0 ? s[(y0 * w + x0 + 1) * c + ch] as number : border
    const v01 = in_x0 && in_y1 ? s[((y0 + 1) * w + x0) * c + ch] as number : border
    const v11 = in_x1 && in_y1 ? s[((y0 + 1) * w + x0 + 1) * c + ch] as number : border
    out[o + ch] = u8(v00 * w00 + v10 * w10 + v01 * w01 + v11 * w11)
  }
}

// The (gh × gw) [-1,1] coordinate grid (CHW: x plane, then y plane) is upsampled to (h × w), then
// the RGBA source (sw × sh) is sampled through it. Output RGBA (w × h), alpha opaque.
export function grid_unwarp(src: Uint8Array, sw: number, sh: number, grid: Float32Array, gw: number, gh: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4).fill(255), gp = gw * gh
  const gx_scale = w > 1 ? (gw - 1) / (w - 1) : 0, gy_scale = h > 1 ? (gh - 1) / (h - 1) : 0
  const gxi = new Int32Array(w), gxf = new Float64Array(w), rx = new Float64Array(gw), ry = new Float64Array(gw)
  for (let x = 0; x < w; x++) { const g = x * gx_scale, i = Math.min(Math.floor(g), gw - 2); gxi[x] = Math.max(0, i); gxf[x] = g - Math.max(0, i) }
  for (let y = 0; y < h; y++) {
    const g = y * gy_scale, i = Math.max(0, Math.min(Math.floor(g), gh - 2)), f = gh > 1 ? g - i : 0, i1 = Math.min(i + 1, gh - 1)
    for (let k = 0; k < gw; k++) {
      rx[k] = (grid[i * gw + k] as number) * (1 - f) + (grid[i1 * gw + k] as number) * f
      ry[k] = (grid[gp + i * gw + k] as number) * (1 - f) + (grid[gp + i1 * gw + k] as number) * f
    }
    for (let x = 0; x < w; x++) {
      const k = gxi[x] as number, f2 = gxf[x] as number, k1 = Math.min(k + 1, gw - 1)
      const gx = (rx[k] as number) * (1 - f2) + (rx[k1] as number) * f2, gy = (ry[k] as number) * (1 - f2) + (ry[k1] as number) * f2
      sample(src, sw, sh, 4, (gx + 1) / 2 * (sw - 1), (gy + 1) / 2 * (sh - 1), out, (y * w + x) * 4, 3, 0)
    }
  }
  return out
}
