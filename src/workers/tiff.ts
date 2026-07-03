// Minimal baseline TIFF encoder — uncompressed, 8-bit RGB, single strip, little-endian.
// Canvas has no native TIFF path (convertToBlob rejects image/tiff), so export must
// hand-assemble the container. Alpha is dropped: SmartCrop output pages are opaque
// (spec §21 export is a flattened raster). Structure per TIFF 6.0 §2.

const HEADER = 8
const IFD_ENTRY = 12
const ENTRY_COUNT = 12
// 2 (entry count) + N*12 + 4 (next-IFD offset)
const IFD_BYTES = 2 + ENTRY_COUNT * IFD_ENTRY + 4
const IFD_OFFSET = HEADER
const EXT_OFFSET = IFD_OFFSET + IFD_BYTES        // BitsPerSample(6) + X/YResolution(8+8)
const BITS_OFFSET = EXT_OFFSET
const XRES_OFFSET = BITS_OFFSET + 6
const YRES_OFFSET = XRES_OFFSET + 8
const PIXEL_OFFSET = YRES_OFFSET + 8

const T_SHORT = 3
const T_LONG = 4
const T_RATIONAL = 5

/** Encode RGBA pixels (row-major, 4 bytes/px) as a baseline RGB TIFF. */
export function encode_tiff(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8Array {
  const data_len = w * h * 3
  const buf = new ArrayBuffer(PIXEL_OFFSET + data_len)
  const dv = new DataView(buf)
  const u8 = new Uint8Array(buf)

  // Header (little-endian)
  dv.setUint8(0, 0x49); dv.setUint8(1, 0x49)  // "II"
  dv.setUint16(2, 42, true)
  dv.setUint32(4, IFD_OFFSET, true)

  dv.setUint16(IFD_OFFSET, ENTRY_COUNT, true)
  let p = IFD_OFFSET + 2
  const entry = (tag: number, type: number, count: number, value: number): void => {
    dv.setUint16(p, tag, true); dv.setUint16(p + 2, type, true)
    dv.setUint32(p + 4, count, true); dv.setUint32(p + 8, value, true)
    p += IFD_ENTRY
  }
  entry(256, T_LONG, 1, w)                 // ImageWidth
  entry(257, T_LONG, 1, h)                 // ImageLength
  entry(258, T_SHORT, 3, BITS_OFFSET)      // BitsPerSample → external [8,8,8]
  entry(259, T_SHORT, 1, 1)                // Compression = none
  entry(262, T_SHORT, 1, 2)                // Photometric = RGB
  entry(273, T_LONG, 1, PIXEL_OFFSET)      // StripOffsets
  entry(277, T_SHORT, 1, 3)                // SamplesPerPixel
  entry(278, T_LONG, 1, h)                 // RowsPerStrip
  entry(279, T_LONG, 1, data_len)          // StripByteCounts
  entry(282, T_RATIONAL, 1, XRES_OFFSET)   // XResolution → external
  entry(283, T_RATIONAL, 1, YRES_OFFSET)   // YResolution → external
  entry(296, T_SHORT, 1, 2)                // ResolutionUnit = inch
  dv.setUint32(p, 0, true)                 // next IFD = 0

  // External values
  dv.setUint16(BITS_OFFSET, 8, true)
  dv.setUint16(BITS_OFFSET + 2, 8, true)
  dv.setUint16(BITS_OFFSET + 4, 8, true)
  dv.setUint32(XRES_OFFSET, 72, true); dv.setUint32(XRES_OFFSET + 4, 1, true)
  dv.setUint32(YRES_OFFSET, 72, true); dv.setUint32(YRES_OFFSET + 4, 1, true)

  // Pixel data: strip alpha
  let dst = PIXEL_OFFSET
  for (let i = 0; i < rgba.length; i += 4) {
    u8[dst++] = rgba[i] ?? 0; u8[dst++] = rgba[i + 1] ?? 0; u8[dst++] = rgba[i + 2] ?? 0
  }
  return u8
}
