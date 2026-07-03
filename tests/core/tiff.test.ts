// Baseline TIFF encoder — container validity and pixel fidelity.
import { describe, it, expect } from 'vitest'
import { encode_tiff } from '@workers/tiff'

function rgba(w: number, h: number, fill: [number, number, number, number]): Uint8ClampedArray {
  const a = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < a.length; i += 4) { a[i] = fill[0]; a[i + 1] = fill[1]; a[i + 2] = fill[2]; a[i + 3] = fill[3] }
  return a
}

describe('encode_tiff', () => {
  it('emits a little-endian baseline header with a valid IFD', () => {
    const buf = encode_tiff(rgba(2, 2, [10, 20, 30, 255]), 2, 2)
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    expect([dv.getUint8(0), dv.getUint8(1)]).toEqual([0x49, 0x49])   // "II"
    expect(dv.getUint16(2, true)).toBe(42)
    const ifd = dv.getUint32(4, true)
    const nEntries = dv.getUint16(ifd, true)
    expect(nEntries).toBe(12)
    // ImageWidth (256) and ImageLength (257) are the first two tags
    expect(dv.getUint16(ifd + 2, true)).toBe(256)
    expect(dv.getUint32(ifd + 2 + 8, true)).toBe(2)
    expect(dv.getUint16(ifd + 2 + 12, true)).toBe(257)
    expect(dv.getUint32(ifd + 2 + 12 + 8, true)).toBe(2)
  })

  it('drops alpha and writes RGB pixels in order', () => {
    const buf = encode_tiff(rgba(1, 1, [11, 22, 33, 128]), 1, 1)
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const ifd = dv.getUint32(4, true)
    // StripOffsets is tag 273 at entry index 5 (0-based): offset ifd+2 + 5*12
    const stripOffset = dv.getUint32(ifd + 2 + 5 * 12 + 8, true)
    expect([buf[stripOffset], buf[stripOffset + 1], buf[stripOffset + 2]]).toEqual([11, 22, 33])
    expect(buf.byteLength).toBe(stripOffset + 3)   // exactly one RGB triplet
  })

  it('sizes the strip as w*h*3 bytes', () => {
    const w = 4, h = 3
    const buf = encode_tiff(rgba(w, h, [0, 0, 0, 255]), w, h)
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const ifd = dv.getUint32(4, true)
    const byteCounts = dv.getUint32(ifd + 2 + 8 * 12 + 8, true)   // tag 279 at entry index 8
    expect(byteCounts).toBe(w * h * 3)
  })
})
