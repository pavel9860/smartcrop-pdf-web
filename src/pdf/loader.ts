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
// PdfRendererAdapter — implements RendererAdapter for AppModel
// ---------------------------------------------------------------------------

export class PdfRendererAdapter implements RendererAdapter {
  private _pdf: pdfjs.PDFDocumentProxy | null = null
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
      const synth: DocInfo = {
        page_count: SYNTH_PAGES,
        page_sizes: Array.from({ length: SYNTH_PAGES }, () => ({ width: SYNTH_W, height: SYNTH_H })),
        file_names: [],
        mode: Mode.NORMAL,
      }
      this._doc_info = synth
      return synth
    }

    this._files = files

    const page_sizes: PageSize[] = []
    const file_names: string[]   = []
    const page_is_native: boolean[] = []

    for (const f of files) {
      const buf = await f.arrayBuffer()
      if (f.name.toLowerCase().endsWith('.pdf')) {
        try {
          if (this._pdf) await this._pdf.destroy()
          // See file-header note: cMap/standard-font resources are still fetched via
          // pdf.worker.mjs (useWorkerFetch), not this main thread, for correct glyph
          // shaping on complex/CID-keyed scripts without doing the fetch twice.
          this._pdf = await pdfjs.getDocument({
            data: buf,
            cMapUrl: '/cmaps/',
            cMapPacked: true,
            standardFontDataUrl: '/standard_fonts/',
            useWorkerFetch: true,
          }).promise
          for (let i = 1; i <= this._pdf.numPages; i++) {
            const p  = await this._pdf.getPage(i)
            const vp = p.getViewport({ scale: 1 })
            page_sizes.push({ width: vp.width, height: vp.height })
            page_is_native.push(await is_native_page(p))
            p.cleanup()
          }
          file_names.push(f.name)
        } catch (e) {
          throw new DocumentLoadError(`Failed to load ${f.name}`, e)
        }
      } else {
        // Image file: one page, size from bitmap, never counts as native (spec §4)
        const bitmap = await createImageBitmap(new Blob([buf]))
        page_sizes.push({ width: bitmap.width, height: bitmap.height })
        page_is_native.push(false)
        file_names.push(f.name)
        bitmap.close()
      }
    }

    // Classification (spec §4): any native page → NORMAL, else SCANNED
    const mode = page_is_native.some(Boolean) ? Mode.NORMAL : Mode.SCANNED

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
    if (!this._pdf) throw new Error('No PDF document loaded')
    const page  = await this._pdf.getPage(page_idx + 1)
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

  async export_pdf(pages: OutputPage[]): Promise<Uint8Array> {
    const exp = await this._export_worker()
    return exp.call<Uint8Array>(
      { type: 'export_pdf', pages, quality: JPEG_QUALITY },
      pages.map(p => p.bitmap))
  }

  async export_images(pages: OutputPage[], format: 'JPG' | 'PNG'): Promise<Blob[]> {
    const exp = await this._export_worker()
    return exp.call<Blob[]>(
      { type: 'export_images', pages, format, quality: JPEG_QUALITY },
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
    void this._pdf?.destroy()
    this._export?.terminate()
  }

  private _export_worker(): Promise<RpcWorker> {
    if (!this._export) {
      this._export = new RpcWorker(new ExportWorker())
    }
    return Promise.resolve(this._export)
  }
}
