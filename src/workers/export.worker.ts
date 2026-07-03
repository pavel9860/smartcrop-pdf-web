// export.worker.ts — pdf-lib PDF assembly and image encoding.
// Initialized on first export(); stays alive for the session.

import { PDFDocument } from 'pdf-lib'
import { zipSync, type Zippable } from 'fflate'
import type { OutputPage } from '@core/model'
import { encode_tiff } from './tiff'

type ImageFormat = 'JPG' | 'PNG' | 'TIFF'
const EXT: Record<ImageFormat, string> = { JPG: 'jpg', PNG: 'png', TIFF: 'tif' }

type Req =
  | { id: number; type: 'export_pdf';    pages: OutputPage[]; quality: number }
  | { id: number; type: 'export_images'; pages: OutputPage[]; format: ImageFormat; base: string; quality: number }

type Res =
  | { id: number; type: 'ok';       payload: unknown }
  | { id: number; type: 'error';    message: string }
  | { id: number; type: 'progress'; done: number; total: number }

self.onmessage = async (ev: MessageEvent<Req>): Promise<void> => {
  const msg = ev.data
  try {
    switch (msg.type) {
      case 'export_pdf': {
        const bytes = await build_pdf(msg.pages, msg.quality)
        self.postMessage({ id: msg.id, type: 'ok', payload: bytes } satisfies Res,
          [bytes.buffer])
        return
      }
      case 'export_images': {
        const zip = await zip_images(msg.pages, msg.format, msg.base, msg.quality,
          (done, total) => { self.postMessage({ id: msg.id, type: 'progress', done, total } satisfies Res) })
        self.postMessage({ id: msg.id, type: 'ok', payload: zip } satisfies Res, [zip.buffer])
        return
      }
    }
  } catch (e) {
    err(msg.id, String(e))
  }
}

async function build_pdf(pages: OutputPage[], quality: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (const p of pages) {
    const jpeg  = await bitmap_to_jpeg(p.bitmap, quality)
    const img   = await doc.embedJpg(jpeg)
    const page  = doc.addPage([p.width, p.height])
    page.drawImage(img, { x: 0, y: 0, width: p.width, height: p.height })
    p.bitmap.close()
  }
  return doc.save({ useObjectStreams: true })
}

// Encode every output page and pack into ONE zip (spec-web §W: image formats deliver a single
// archive, not N loose downloads). Level 0 for JPG/PNG (already compressed); level 1 (fast
// deflate) for uncompressed TIFF — level 6 made the final zipSync the long pole with no progress.
// Per-page progress is reported so the bar keeps moving through the encode phase.
async function zip_images(
  pages: OutputPage[], format: ImageFormat, base: string, quality: number,
  on_progress: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const ext = EXT[format]
  const level = format === 'TIFF' ? 1 : 0
  const total = pages.length
  const entries: Zippable = {}
  let i = 0
  for (const p of pages) {
    const idx = String(++i).padStart(3, '0')
    entries[`${base}_${idx}.${ext}`] = [await encode_page(p, format, quality), { level }]
    on_progress(i, total)
  }
  return zipSync(entries)
}

async function encode_page(p: OutputPage, format: ImageFormat, quality: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(p.width, p.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.drawImage(p.bitmap, 0, 0)
  try {
    if (format === 'TIFF') {
      const { data } = ctx.getImageData(0, 0, p.width, p.height)
      return encode_tiff(data, p.width, p.height)
    }
    const mime = format === 'JPG' ? 'image/jpeg' : 'image/png'
    const blob = await canvas.convertToBlob({ type: mime, quality })
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    p.bitmap.close()
  }
}

async function bitmap_to_jpeg(bitmap: ImageBitmap, quality: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.drawImage(bitmap, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  return new Uint8Array(await blob.arrayBuffer())
}

function err(id: number, message: string): void {
  self.postMessage({ id, type: 'error', message } satisfies Res)
}
