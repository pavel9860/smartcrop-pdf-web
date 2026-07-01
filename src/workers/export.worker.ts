// export.worker.ts — pdf-lib PDF assembly and image encoding.
// Initialized on first export(); stays alive for the session.

import { PDFDocument } from 'pdf-lib'
import type { OutputPage } from '@core/model'

type Req =
  | { id: number; type: 'export_pdf';    pages: OutputPage[]; quality: number }
  | { id: number; type: 'export_images'; pages: OutputPage[]; format: 'JPG' | 'PNG'; quality: number }

type Res =
  | { id: number; type: 'ok';    payload: unknown }
  | { id: number; type: 'error'; message: string }

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
        const blobs = await encode_images(msg.pages, msg.format, msg.quality)
        reply(msg.id, blobs)
        break
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

async function encode_images(
  pages: OutputPage[], format: 'JPG' | 'PNG', quality: number,
): Promise<Blob[]> {
  const results: Blob[] = []
  for (const p of pages) {
    const canvas = new OffscreenCanvas(p.width, p.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    ctx.drawImage(p.bitmap, 0, 0)
    p.bitmap.close()
    const mime = format === 'JPG' ? 'image/jpeg' : 'image/png'
    const blob = await canvas.convertToBlob({ type: mime, quality })
    results.push(blob)
  }
  return results
}

async function bitmap_to_jpeg(bitmap: ImageBitmap, quality: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.drawImage(bitmap, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  return new Uint8Array(await blob.arrayBuffer())
}

function reply(id: number, payload: unknown): void {
  self.postMessage({ id, type: 'ok', payload } satisfies Res)
}
function err(id: number, message: string): void {
  self.postMessage({ id, type: 'error', message } satisfies Res)
}
