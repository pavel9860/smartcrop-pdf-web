// loader.ts — PDF.js loading/rendering (main thread) + imaging/export worker RPC.
//
// PDF.js parsing/rendering runs here on the MAIN thread, not in a Worker. This is
// deliberate, not an oversight: pdfjs-dist's display API (pdf.mjs) references
// `window`/`document` unconditionally in several places it should guard — e.g.
// PDFWorker._initialize() reads `window.location.href` to decide same-origin handling
// before it even tries to spawn its own pdf.worker.mjs worker. Inside any Worker,
// `window` is undefined, so that call throws, PDF.js silently falls back to its
// same-thread "fake worker" path, and that path in turn calls `importScripts()` —
// which is illegal inside an ES-module worker ("format: 'es'" in vite.config.ts) and
// throws a second, more confusing error. A prior version of this file ran the pdf.js
// calls inside a dedicated render.worker.ts; that hit exactly this failure for every
// document load. Running on the main thread sidesteps it entirely and is in fact
// pdf.js's own supported architecture: pdf.js still offloads the CPU-heavy parsing to
// its own internally-managed pdf.worker.mjs (a real Worker, spawned from here), so we
// aren't blocking the UI thread with parsing — only the (cheap) canvas compositing in
// page.render() runs on this thread, same as pdf.js's documented usage pattern.
import * as pdfjs from 'pdfjs-dist'
import type { DocInfo, RendererAdapter, OutputPage, PageSize } from '@core/model'
import type { Box } from '@core/geometry'
import type { PageProcessIntent } from '@core/document_state'
import { Mode } from '@core/enums'
import { DocumentLoadError } from '@core/errors'
import {
  SRC_DPI, NORMAL_DPI, JPEG_QUALITY, SYNTH_PAGES, SYNTH_W, SYNTH_H,
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
// canvas so the rotated content isn't clipped — the raster equivalent of desktop
// model.py's `img.rotate(-ang, expand=True)` (PIL rotates CCW; -ang = clockwise). Bakes
// the page's current rotation state (core/model.ts's document.rotation map) into the
// pixels themselves, since AppModel.view_snapshot()/render_output_image() work in the
// post-rotation page-unit frame (core/model.ts's _page_dims) and never rotate on read.
function rotate_bitmap_cw(bitmap: ImageBitmap, angle: number): ImageBitmap {
  if (angle === 0) return bitmap
  const { width: w, height: h } = bitmap
  const swapped = angle % 180 === 90
  const canvas = new OffscreenCanvas(swapped ? h : w, swapped ? w : h)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
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

// ---------------------------------------------------------------------------
// Generic worker RPC helper
// ---------------------------------------------------------------------------

type WorkerMsg = { id: number; type: 'ok'; payload: unknown }
               | { id: number; type: 'error'; message: string }

class RpcWorker {
  private readonly _w: Worker
  private _next_id = 0
  private readonly _pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor(w: Worker) {
    this._w = w
    this._w.onmessage = (ev: MessageEvent<WorkerMsg>): void => {
      const { id, type } = ev.data
      const p = this._pending.get(id)
      if (!p) return
      this._pending.delete(id)
      if (type === 'ok') p.resolve((ev.data as { payload: unknown }).payload)
      else p.reject(new Error((ev.data as { message: string }).message))
    }
  }

  call<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = this._next_id++
    return new Promise<T>((resolve, reject) => {
      this._pending.set(id, {
        resolve: v => { resolve(v as T) },
        reject,
      })
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
    if (!ctx) throw new Error('2d context unavailable')
    // pdfjs-dist's RenderParameters.canvasContext is typed as CanvasRenderingContext2D only;
    // it hasn't been updated for OffscreenCanvasRenderingContext2D even though page.render()
    // only calls the Canvas2D methods the two interfaces share. Cast is required, not a gap.
    await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise
    page.cleanup()
    return rotate_bitmap_cw(canvas.transferToImageBitmap(), rotation)
  }

  async get_work_image(
    page_idx: number,
    intent: PageProcessIntent,
    supersample: number,
    rotation = 0,
  ): Promise<ImageBitmap> {
    const dpi = SRC_DPI
    const src = await this.get_source_image(page_idx, dpi, rotation)
    if (!intent.dewarp && !intent.filter) return src
    return process_page_async(src, intent, supersample)
  }

  render_output_image(
    src: ImageBitmap,
    box: Box,
    page_w: number,
    page_h: number,
    target_dpi: number | null,
    greyscale: boolean,
  ): Promise<ImageBitmap> {
    const src_dpi = this._doc_info?.mode === Mode.SCANNED ? SRC_DPI : NORMAL_DPI
    const crop_w = box.x1 - box.x0
    const crop_h = box.y1 - box.y0
    const scale  = src.width / page_w   // pixels per page unit

    const out_w = target_dpi
      ? Math.round(crop_w * target_dpi / src_dpi)
      : Math.round(crop_w * scale)
    const out_h = target_dpi
      ? Math.round(crop_h * target_dpi / src_dpi)
      : Math.round(crop_h * scale)

    const canvas = new OffscreenCanvas(Math.max(1, out_w), Math.max(1, out_h))
    const ctx    = canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    ctx.drawImage(src,
      box.x0 * scale, box.y0 * scale, crop_w * scale, crop_h * scale,
      0, 0, out_w, out_h)

    if (greyscale) {
      const id = ctx.getImageData(0, 0, out_w, out_h)
      for (let i = 0; i < id.data.length; i += 4) {
        const g = 0.299 * (id.data[i] ?? 0)
              + 0.587 * (id.data[i + 1] ?? 0)
              + 0.114 * (id.data[i + 2] ?? 0)
        id.data[i] = id.data[i + 1] = id.data[i + 2] = g
      }
      ctx.putImageData(id, 0, 0)
    }

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
  ): Promise<Uint8Array> {
    const exp = await this._export_worker()
    return exp.call<Uint8Array>(
      { type: 'export_images', pages, format, base, quality: JPEG_QUALITY },
      pages.map(p => p.bitmap))
  }

  make_synth_page(_idx: number, w: number, h: number): Promise<ImageBitmap> {
    const canvas = new OffscreenCanvas(w, h)
    const ctx    = canvas.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
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
