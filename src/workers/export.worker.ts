// export.worker.ts — streamed raster export (spec-web §10, §21 #9): the main thread opens a session,
// sends one rendered page at a time (bitmap transferred, encoded here at once and closed), then
// finishes it. Only compressed bytes accumulate, never a document's worth of raw bitmaps.
import { PDFDocument } from 'pdf-lib'
import { zipSync, type Zippable } from 'fflate'
import type { OutputPage } from '@core/model'
import type { ExportFormat } from '@core/constants'
import { CONTEXT_2D_UNAVAILABLE } from '@core/errors'
import { encode_tiff } from './tiff'

const EXT: Record<Exclude<ExportFormat, 'PDF'>, string> = { JPG: 'jpg', PNG: 'png', TIFF: 'tif' }

type Req = { id: number; session: number } & (
  | { type: 'begin'; format: ExportFormat; base: string; quality: number }
  | { type: 'page'; page: OutputPage }
  | { type: 'finish' }
  | { type: 'abort' })

type Res = { id: number; type: 'ok'; payload: unknown } | { id: number; type: 'error'; message: string }

interface Session {
  format: ExportFormat
  base: string
  quality: number
  pdf: PDFDocument | null
  entries: Zippable
  count: number
}

const sessions = new Map<number, Session>()

self.onmessage = async (ev: MessageEvent<Req>): Promise<void> => {
  const msg = ev.data
  try {
    const payload = await handle(msg)
    const transfer = payload instanceof Uint8Array ? [payload.buffer] : []
    self.postMessage({ id: msg.id, type: 'ok', payload } satisfies Res, transfer)
  } catch (e) {
    if (msg.type === 'page') close_quietly(msg.page.bitmap)
    self.postMessage({ id: msg.id, type: 'error', message: String(e) } satisfies Res)
  }
}

async function handle(msg: Req): Promise<unknown> {
  if (msg.type === 'begin') {
    sessions.set(msg.session, {
      format: msg.format, base: msg.base, quality: msg.quality,
      pdf: msg.format === 'PDF' ? await PDFDocument.create() : null, entries: {}, count: 0,
    })
    return null
  }
  const s = sessions.get(msg.session)
  if (!s) throw new Error(`Unknown export session ${msg.session}`)
  if (msg.type === 'abort') { sessions.delete(msg.session); return null }
  if (msg.type === 'page') { await add_page(s, msg.page); return null }
  sessions.delete(msg.session)
  return s.pdf ? s.pdf.save({ useObjectStreams: true }) : zipSync(s.entries)
}

// Level 0 for JPG/PNG (already compressed), level 1 (fast deflate) for uncompressed TIFF.
async function add_page(s: Session, p: OutputPage): Promise<void> {
  const fmt = s.format === 'PDF' ? 'JPG' : s.format
  const bytes = await encode_page(p, fmt, s.quality)
  s.count++
  if (s.pdf) {
    const img = await s.pdf.embedJpg(bytes)
    s.pdf.addPage([p.width, p.height]).drawImage(img, { x: 0, y: 0, width: p.width, height: p.height })
    return
  }
  s.entries[`${s.base}_${String(s.count).padStart(3, '0')}.${EXT[fmt]}`] = [bytes, { level: fmt === 'TIFF' ? 1 : 0 }]
}

async function encode_page(p: OutputPage, format: Exclude<ExportFormat, 'PDF'>, quality: number): Promise<Uint8Array> {
  try {
    const canvas = new OffscreenCanvas(p.width, p.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error(CONTEXT_2D_UNAVAILABLE)
    ctx.drawImage(p.bitmap, 0, 0)
    if (format === 'TIFF') {
      const { data } = ctx.getImageData(0, 0, p.width, p.height)
      return encode_tiff(data, p.width, p.height)
    }
    const blob = await canvas.convertToBlob({ type: format === 'JPG' ? 'image/jpeg' : 'image/png', quality })
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    close_quietly(p.bitmap)
  }
}

// ImageBitmap.close() on an already-closed bitmap is a no-op in every real implementation but
// isn't spec-guaranteed — swallow a double-close rather than let cleanup itself throw.
function close_quietly(b: ImageBitmap): void {
  try { b.close() } catch { /* already closed */ }
}
