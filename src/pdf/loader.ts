// loader.ts — PDF.js loading/rendering (main thread) + imaging/export worker RPC.
import * as pdfjs from 'pdfjs-dist'
import { PDFDocument, degrees } from 'pdf-lib'
import type { DocInfo, RendererAdapter, OutputPage, VectorExportPage, PageSize } from '@core/model'
import type { Box } from '@core/geometry'
import { to_native_frame } from '@core/geometry'
import type { PageProcessIntent } from '@core/document_state'
import { Mode } from '@core/enums'
import { DocumentLoadError, CONTEXT_2D_UNAVAILABLE } from '@core/errors'
import { WorkRasterStore } from './work_store'
import {
  JPEG_QUALITY, SYNTH_PAGES, SYNTH_W, SYNTH_H,
  SYNTH_BG_COLOR, SYNTH_BORDER_COLOR, SYNTH_TEXT_COLOR, SYNTH_FONT, SYNTH_PADDING,
  MODE_TEXT_MIN,
} from '@core/constants'
import { detect_content_async, process_page_async } from './imaging'
import ExportWorker from '@workers/export.worker?worker'

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href

// Operators that indicate native vector content (spec §4, ARCHITECTURE §8.1).
const VECTOR_OPS = new Set<number>([
  pdfjs.OPS.constructPath, pdfjs.OPS.fill, pdfjs.OPS.eoFill,
  pdfjs.OPS.fillStroke, pdfjs.OPS.eoFillStroke, pdfjs.OPS.stroke,
  pdfjs.OPS.closeStroke, pdfjs.OPS.closeFillStroke, pdfjs.OPS.closeEOFillStroke,
  pdfjs.OPS.shadingFill,
])

// Page is "native" (has real text or vector drawing) vs. a scanned raster (spec §4).
async function is_native_page(page: pdfjs.PDFPageProxy): Promise<boolean> {
  const text = await page.getTextContent()
  const char_count = text.items.reduce(
    (n: number, it) => n + ('str' in it ? it.str.length : 0), 0)
  if (char_count >= MODE_TEXT_MIN) return true
  const ops = await page.getOperatorList()
  return ops.fnArray.some(fn => VECTOR_OPS.has(fn))
}

// Rotate a rendered page raster 90° CW `angle` degrees (0/90/180/270), expanding the
// canvas so the rotated content isn't clipped
function rotate_bitmap_cw(bitmap: ImageBitmap, angle: number): ImageBitmap {
  if (angle === 0) return bitmap
  const { width: w, height: h } = bitmap
  const swapped = angle % 180 === 90
  const canvas = new OffscreenCanvas(swapped ? h : w, swapped ? w : h)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(CONTEXT_2D_UNAVAILABLE)
  switch (angle) {
    case 90:  ctx.translate(h, 0); ctx.rotate(Math.PI / 2);  break
    case 180: ctx.translate(w, h); ctx.rotate(Math.PI);      break
    case 270: ctx.translate(0, w); ctx.rotate(-Math.PI / 2); break
    default:  throw new Error(`Invalid rotation angle: ${angle}`)
  }
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return canvas.transferToImageBitmap()
}

// Re-encode an image blob as PNG bytes — used by export_pdf_vector for an image-sourced page in
// any format pdf-lib can't embed directly (only JPEG/PNG). createImageBitmap already succeeded on
// this same blob at load time (is_native_page/page_sizes), so it is known-decodable here too.
async function reencode_as_png(blob: Blob): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(CONTEXT_2D_UNAVAILABLE)
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const encoded = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await encoded.arrayBuffer())
}

// ---------------------------------------------------------------------------
// Generic worker RPC helper
// ---------------------------------------------------------------------------

type WorkerMsg = { id: number; type: 'ok'; payload: unknown }
               | { id: number; type: 'error'; message: string }
               | { id: number; type: 'progress'; done: number; total: number }

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  on_progress?: ((done: number, total: number) => void) | undefined
}

class RpcWorker {
  private readonly _w: Worker
  private _next_id = 0
  private readonly _pending = new Map<number, Pending>()

  constructor(w: Worker) {
    this._w = w
    this._w.onmessage = (ev: MessageEvent<WorkerMsg>): void => {
      const { id, type } = ev.data
      const p = this._pending.get(id)
      if (!p) return
      if (type === 'progress') { p.on_progress?.(ev.data.done, ev.data.total); return }
      this._pending.delete(id)
      if (type === 'ok') p.resolve((ev.data as { payload: unknown }).payload)
      else p.reject(new Error((ev.data as { message: string }).message))
    }
  }

  call<T>(
    msg: Record<string, unknown>, transfer: Transferable[] = [],
    on_progress?: (done: number, total: number) => void,
  ): Promise<T> {
    const id = this._next_id++
    return new Promise<T>((resolve, reject) => {
      this._pending.set(id, { resolve: v => { resolve(v as T) }, reject, on_progress })
      this._w.postMessage({ id, ...msg }, transfer)
    })
  }

  terminate(): void { this._w.terminate() }
}

// ---------------------------------------------------------------------------
// Per-output-page source map (spec §7.1a): the combined document is PDFs (all their
// pages, in order) and images (one page each) concatenated in selection order. A single
// `PDFDocumentProxy` cannot represent that — several PDFs plus loose images coexist — so
// every output page index maps to its own source: a specific PDF proxy + 1-based page
// number, or a decoded-on-demand image blob. (Fixes §W2 rows 3–4: multi-file and mixed
// PDF+image loads. The old single-`_pdf` field dropped every file but the last and made
// `get_source_image` throw on any image page in a mixed load.)
// ---------------------------------------------------------------------------

type PageSource =
  | { kind: 'pdf'; pdf: pdfjs.PDFDocumentProxy; page_num: number }
  | { kind: 'image'; blob: Blob }

// ---------------------------------------------------------------------------
// PdfRendererAdapter — implements RendererAdapter for AppModel
// ---------------------------------------------------------------------------

export class PdfRendererAdapter implements RendererAdapter {
  private _pdfs: pdfjs.PDFDocumentProxy[] = []
  private _pages: PageSource[] = []
  private _export:  RpcWorker | null = null
  private _doc_info: DocInfo | null  = null
  private _files: File[] = []
  // Disk tier of the model's two-tier work cache (spec-web §W2 row 5). Lives here in pdf/ because
  // core/ may not touch IndexedDB (architecture rule); the model drives it via load/persist/clear.
  private _work_store = new WorkRasterStore()

  async load_files(files: File[]): Promise<DocInfo> {
    if (files.length === 0 && this._files.length > 0) {
      // reset() call: reload same files
      files = this._files
    }
    if (files.length === 0) {
      // Synthetic doc — no real files
      await this._release_sources()
      const synth: DocInfo = {
        page_count: SYNTH_PAGES,
        page_sizes: Array.from({ length: SYNTH_PAGES }, () => ({ width: SYNTH_W, height: SYNTH_H })),
        file_names: [],
        mode: Mode.NORMAL,
        synthetic: true,
      }
      this._doc_info = synth
      return synth
    }

    this._files = files
    await this._release_sources()

    const page_sizes: PageSize[] = []
    const file_names: string[]   = []
    let any_native = false

    try {
      for (const f of files) {
        if (f.name.toLowerCase().endsWith('.pdf')) {
          const buf = await f.arrayBuffer()
          // See file-header note: cMap/standard-font resources are still fetched via
          // pdf.worker.mjs (useWorkerFetch), not this main thread, for correct glyph
          // shaping on complex/CID-keyed scripts without doing the fetch twice.
          const pdf = await pdfjs.getDocument({
            data: buf,
            cMapUrl: `${import.meta.env.BASE_URL}cmaps/`,
            cMapPacked: true,
            standardFontDataUrl: `${import.meta.env.BASE_URL}standard_fonts/`,
            useWorkerFetch: true,
          }).promise
          this._pdfs.push(pdf)
          for (let i = 1; i <= pdf.numPages; i++) {
            const p  = await pdf.getPage(i)
            const vp = p.getViewport({ scale: 1 })
            page_sizes.push({ width: vp.width, height: vp.height })
            this._pages.push({ kind: 'pdf', pdf, page_num: i })
            // Classify per §4: NORMAL as soon as any page carries vector data. Stop probing
            // once found — the rest of the pages still register their size + source above.
            if (!any_native) any_native = await is_native_page(p)
            p.cleanup()
          }
          file_names.push(f.name)
        } else {
          // Image file: one page, size from the decoded bitmap, never native (spec §4).
          // A File is a Blob, so it is stored directly and re-decoded on demand in
          // get_source_image — no decoded raster is retained between views.
          const bitmap = await createImageBitmap(f)
          page_sizes.push({ width: bitmap.width, height: bitmap.height })
          bitmap.close()
          this._pages.push({ kind: 'image', blob: f })
          file_names.push(f.name)
        }
      }
    } catch (e) {
      await this._release_sources()
      throw new DocumentLoadError('Failed to load the selected files', e)
    }

    if (page_sizes.length === 0) {
      throw new DocumentLoadError('No pages to load')
    }

    // Classification (spec §4): any native page → NORMAL, else SCANNED
    const mode = any_native ? Mode.NORMAL : Mode.SCANNED

    const info: DocInfo = {
      page_count: page_sizes.length,
      page_sizes,
      file_names,
      mode,
    }
    this._doc_info = info
    return info
  }

  async get_source_image(page_idx: number, dpi: number, rotation = 0): Promise<ImageBitmap> {
    const source = this._pages[page_idx]
    if (!source) throw new Error(`No source for page index ${page_idx}`)

    if (source.kind === 'image') {
      // Image pages are native-resolution rasters; dpi does not add real pixels (they are
      // treated as SCANNED source @ their own pixel size, spec §4), so it is not applied.
      return rotate_bitmap_cw(await createImageBitmap(source.blob), rotation)
    }

    const page  = await source.pdf.getPage(source.page_num)
    const scale = dpi / 72
    const vp     = page.getViewport({ scale })
    const canvas = new OffscreenCanvas(Math.round(vp.width), Math.round(vp.height))
    const ctx    = canvas.getContext('2d')
    if (!ctx) throw new Error(CONTEXT_2D_UNAVAILABLE)

    await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise
    page.cleanup()
    return rotate_bitmap_cw(canvas.transferToImageBitmap(), rotation)
  }

  async get_work_image(
    source: ImageBitmap,
    intent: PageProcessIntent,
    supersample: number,
  ): Promise<ImageBitmap> {
    if (!intent.dewarp && !intent.filter) return source
    return process_page_async(source, intent, supersample)
  }

  // Disk tier of the two-tier processed-raster cache (spec-web §W2 row 5) — delegates to the
  // IndexedDB-backed WorkRasterStore. Best-effort: a storage error is swallowed there, so the
  // model just recomputes on a miss.
  load_work(key: string): Promise<ImageBitmap | null> { return this._work_store.get(key) }
  persist_work(key: string, bitmap: ImageBitmap): Promise<void> { return this._work_store.put(key, bitmap) }
  clear_work_cache(): Promise<void> { return this._work_store.clear() }

  render_output_image(
    src: ImageBitmap,
    box: Box,
    page_w: number,
    page_h: number,
    target_long_px: number | null,
    greyscale: boolean,
  ): Promise<ImageBitmap> {
    const crop_w = box.x1 - box.x0
    const crop_h = box.y1 - box.y0
    const scale  = src.width / page_w   // pixels per page unit

    // Export sizing (spec-web §W2 row 8): the crop's long side maps to target_long_px
    // (= dpi × paper height, A4 default), short side follows the crop's own aspect.
    // null (preview / 'Original resolution') keeps the source raster resolution.
    const out_scale = target_long_px !== null
      ? target_long_px / Math.max(crop_w, crop_h)
      : scale
    const out_w = Math.round(crop_w * out_scale)
    const out_h = Math.round(crop_h * out_scale)

    const canvas = new OffscreenCanvas(Math.max(1, out_w), Math.max(1, out_h))
    const ctx    = canvas.getContext('2d')
    if (!ctx) throw new Error(CONTEXT_2D_UNAVAILABLE)
    if (greyscale) ctx.filter = 'grayscale(1)'
    ctx.drawImage(src,
      box.x0 * scale, box.y0 * scale, crop_w * scale, crop_h * scale,
      0, 0, out_w, out_h)

    return Promise.resolve(canvas.transferToImageBitmap())
  }

  async detect_content_box(
    img: ImageBitmap,
    page_w: number,
    page_h: number,
    mode: Mode,
  ): Promise<Box> {
    return detect_content_async(img, page_w, page_h, mode)
  }

  // Fast content box for a NORMAL (text-bearing) PDF page: the union of its text runs' boxes,
  // read straight from the text layer — no rasterisation, no OpenCV (desktop detect.py
  // normal_page_box). Positioning uses pdf.js's own text-layer formula. Returns null for
  // image pages or a page with no usable text, so the caller falls back to the image path.
  async detect_text_box(page_idx: number): Promise<Box | null> {
    const source = this._pages[page_idx]
    if (!source || source.kind !== 'pdf') return null
    const page = await source.pdf.getPage(source.page_num)
    const vp   = page.getViewport({ scale: 1 })   // page-unit coords (top-left origin)
    const text = await page.getTextContent()

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    let found = false
    for (const item of text.items) {
      if (!('str' in item) || item.str.trim() === '') continue
      // pdf.js types transform/Util.transform loosely; narrow to the numeric shape we use.
      const it = item as unknown as { transform: number[]; width: number }
      const tx = pdfjs.Util.transform(vp.transform, it.transform) as number[]
      const font_h = Math.hypot(tx[2] ?? 0, tx[3] ?? 0)
      const left   = tx[4] ?? 0
      const top    = (tx[5] ?? 0) - font_h
      const width  = it.width * vp.scale
      x0 = Math.min(x0, left);          y0 = Math.min(y0, top)
      x1 = Math.max(x1, left + width);  y1 = Math.max(y1, top + font_h)
      found = true
    }
    page.cleanup()
    if (!found) return null

    const box: Box = {
      x0: Math.max(0, x0), y0: Math.max(0, y0),
      x1: Math.min(vp.width, x1), y1: Math.min(vp.height, y1),
    }
    // Guard against a degenerate/near-full-page result — fall back to the image path instead.
    if (box.x1 - box.x0 < 4 || box.y1 - box.y0 < 4) return null
    return box
  }

  async export_pdf(pages: OutputPage[]): Promise<Uint8Array> {
    const exp = await this._export_worker()
    return exp.call<Uint8Array>(
      { type: 'export_pdf', pages, quality: JPEG_QUALITY },
      pages.map(p => p.bitmap))
  }

  async export_images(
    pages: OutputPage[], format: 'JPG' | 'PNG' | 'TIFF', base: string,
    on_progress?: (done: number, total: number) => void,
  ): Promise<Uint8Array> {
    const exp = await this._export_worker()
    return exp.call<Uint8Array>(
      { type: 'export_images', pages, format, base, quality: JPEG_QUALITY },
      pages.map(p => p.bitmap), on_progress)
  }

  // Vector PDF export (spec-web §W9.3): crops/rotates/splits via pdf-lib's embedPage against the
  // ORIGINAL page content — never rasterizes a PDF-sourced page. Image-sourced pages (mixed
  // PDF+image NORMAL documents) embed losslessly (PNG/JPEG passthrough, no re-encode) via the same
  // native-frame crop math; anything else the browser can decode re-encodes once as PNG, since
  // pdf-lib only embeds JPEG/PNG. Runs on the main thread, not export.worker.ts: no image-codec
  // work here (unlike JPEG/TIFF raster export) — just PDF structure manipulation — and the source
  // PDFDocumentProxy objects this needs can't cross to a Worker anyway (tied to this thread's
  // pdf.worker.mjs connection). Revisit if profiling shows this janks on very large documents.
  async export_pdf_vector(pages: readonly VectorExportPage[]): Promise<Uint8Array> {
    const outDoc = await PDFDocument.create()
    // One pdf-lib parse per unique SOURCE pdf.js doc, however many of its pages/boxes are
    // exported — getData() returns the same already-parsed bytes pdf.js holds, no re-fetch.
    const pdflib_cache = new Map<pdfjs.PDFDocumentProxy, Promise<PDFDocument>>()
    const get_pdflib_doc = (src: pdfjs.PDFDocumentProxy): Promise<PDFDocument> => {
      let p = pdflib_cache.get(src)
      if (!p) { p = src.getData().then(bytes => PDFDocument.load(bytes)); pdflib_cache.set(src, p) }
      return p
    }

    for (const entry of pages) {
      const source = this._pages[entry.orig_page]
      if (!source) continue
      for (const box of entry.boxes) {
        // native frame: the source page's OWN (rotation=0) coordinates — embedPage/drawImage below
        // clip in that frame, with no notion of this app's rotation state (geometry.ts §W9.3).
        const native = to_native_frame(box, entry.page_w, entry.page_h, entry.rotation)
        const out_w = native.x1 - native.x0
        const out_h = native.y1 - native.y0
        const outPage = outDoc.addPage([out_w, out_h])

        if (source.kind === 'pdf') {
          const srcDoc  = await get_pdflib_doc(source.pdf)
          const srcPage = srcDoc.getPage(source.page_num - 1)
          const src_h   = srcPage.getHeight()
          // pdf-lib boundingBox is {left,bottom,right,top} in the SOURCE page's own bottom-left-
          // origin PDF space; native is top-left-origin (this app's convention) — Y-flip here.
          const embedded = await outDoc.embedPage(srcPage, {
            left: native.x0, right: native.x1,
            bottom: src_h - native.y1, top: src_h - native.y0,
          })
          outPage.drawPage(embedded, { x: 0, y: 0, width: out_w, height: out_h })
        } else {
          const bytes  = new Uint8Array(await source.blob.arrayBuffer())
          const is_png  = bytes[0] === 0x89 && bytes[1] === 0x50
          const is_jpeg = bytes[0] === 0xff && bytes[1] === 0xd8
          const img = is_png  ? await outDoc.embedPng(bytes)
                    : is_jpeg ? await outDoc.embedJpg(bytes)
                    : await outDoc.embedPng(await reencode_as_png(source.blob))
          // Same native-frame crop as the PDF branch, expressed as a draw offset: place the FULL
          // image so only [native.x0,x1]×[native.y0,y1] falls within the (crop-sized) output page
          // — PDF pages clip to their own bounds, so nothing else renders. Derivation: a pixel at
          // image-relative (tx,ty) lands at drawn (x+tx, y+imgH-ty); solving x+tx = tx-native.x0
          // and y+imgH-ty = native.y1-ty gives x=-native.x0, y=native.y1-imgH.
          outPage.drawImage(img, {
            x: -native.x0, y: native.y1 - img.height, width: img.width, height: img.height,
          })
        }
        if (entry.rotation !== 0) outPage.setRotation(degrees(entry.rotation))
      }
    }
    return outDoc.save({ useObjectStreams: true })
  }

  make_synth_page(_idx: number, w: number, h: number): Promise<ImageBitmap> {
    const canvas = new OffscreenCanvas(w, h)
    const ctx    = canvas.getContext('2d')
    if (!ctx) throw new Error(CONTEXT_2D_UNAVAILABLE)
    ctx.fillStyle = SYNTH_BG_COLOR
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = SYNTH_BORDER_COLOR
    ctx.lineWidth = 1
    ctx.strokeRect(SYNTH_PADDING, SYNTH_PADDING, w - 2 * SYNTH_PADDING, h - 2 * SYNTH_PADDING)
    ctx.fillStyle = SYNTH_TEXT_COLOR
    ctx.font = SYNTH_FONT
    ctx.textAlign = 'center'
    ctx.fillText('Load a PDF or image to begin', w / 2, h / 2)
    return Promise.resolve(canvas.transferToImageBitmap())
  }

  close(): void {
    void this._release_sources()
    this._export?.terminate()
  }

  // Destroy every open PDF proxy and drop all page sources — called before a fresh load and
  // on close(). Multiple PDFs are now retained simultaneously (one per loaded .pdf file), so
  // this iterates all of them rather than a single handle.
  private async _release_sources(): Promise<void> {
    const pdfs = this._pdfs
    this._pdfs = []
    this._pages = []
    for (const pdf of pdfs) {
      try { await pdf.destroy() } catch { /* proxy already torn down — nothing to free */ }
    }
  }

  private _export_worker(): Promise<RpcWorker> {
    if (!this._export) {
      this._export = new RpcWorker(new ExportWorker())
    }
    return Promise.resolve(this._export)
  }
}
