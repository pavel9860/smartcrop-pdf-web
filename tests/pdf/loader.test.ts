// PdfRendererAdapter load/route tests (spec §7.1a; spec-web §W2 rows 3-4). Exercises the REAL
// adapter with pdfjs-dist, the imaging module, and the export worker mocked, plus minimal
// createImageBitmap/OffscreenCanvas stubs — no browser required. Guards the multi-file and
// mixed PDF+image regressions: several PDFs must coexist and image pages must not throw.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Mode } from '@core/enums'
import { DocumentLoadError } from '@core/errors'

/* eslint-disable @typescript-eslint/no-explicit-any */

const shared = vi.hoisted(() => ({ pdfQueue: [] as any[] }))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {} as Record<string, unknown>,
  OPS: {
    constructPath: 1, fill: 2, eoFill: 3, fillStroke: 4, eoFillStroke: 5,
    stroke: 6, closeStroke: 7, closeFillStroke: 8, closeEOFillStroke: 9, shadingFill: 10,
  },
  getDocument: () => ({
    promise: shared.pdfQueue.length
      ? Promise.resolve(shared.pdfQueue.shift())
      : Promise.reject(new Error('bad pdf')),
  }),
}))
vi.mock('@pdf/imaging', () => ({
  detect_content_async: vi.fn(),
  process_page_async: vi.fn(),
}))
vi.mock('@workers/export.worker?worker', () => ({
  default: class { postMessage(): void {} terminate(): void {} onmessage: unknown = null },
}))

import { PdfRendererAdapter } from '@pdf/loader'

// image File -> reported bitmap size
const img_sizes = new WeakMap<Blob, { width: number; height: number }>()

function fake_pdf(page_count: number, native: boolean, base_w = 100, base_h = 200): any {
  return {
    numPages: page_count,
    destroy: vi.fn(() => Promise.resolve()),
    getPage: vi.fn((_n: number) => Promise.resolve({
      getViewport: ({ scale }: { scale: number }) => ({ width: base_w * scale, height: base_h * scale }),
      getTextContent: () => Promise.resolve({ items: native ? [{ str: 'x'.repeat(20) }] : [] }),
      getOperatorList: () => Promise.resolve({ fnArray: native ? [2] : [] }),
      render: () => ({ promise: Promise.resolve() }),
      cleanup: () => { /* no-op */ },
    })),
  }
}

function pdf_file(name: string): File { return new File([new Uint8Array([1, 2, 3])], name) }
function img_file(name: string, w: number, h: number): File {
  const f = new File([new Uint8Array([9])], name)
  img_sizes.set(f, { width: w, height: h })
  return f
}

beforeEach(() => {
  shared.pdfQueue = []
  ;(globalThis as any).createImageBitmap = (blob: Blob): Promise<any> =>
    Promise.resolve({ ...(img_sizes.get(blob) ?? { width: 10, height: 10 }), close: () => { /* no-op */ } })
  ;(globalThis as any).OffscreenCanvas = class {
    width: number; height: number
    constructor(w: number, h: number) { this.width = w; this.height = h }
    getContext(): unknown { return {} }
    transferToImageBitmap(): any { return { width: this.width, height: this.height, close: () => { /* no-op */ } } }
  }
})

describe('multi-file load (§W2 row 3)', () => {
  it('concatenates several PDFs, pages in selection order, NORMAL if any native', async () => {
    shared.pdfQueue = [fake_pdf(2, true, 100, 200), fake_pdf(3, true, 111, 222)]
    const a = new PdfRendererAdapter()
    const info = await a.load_files([pdf_file('a.pdf'), pdf_file('b.pdf')])
    expect(info.page_count).toBe(5)
    expect(info.file_names).toEqual(['a.pdf', 'b.pdf'])
    expect(info.mode).toBe(Mode.NORMAL)
    // Routing: page 0 -> first PDF (w 100), page 4 -> second PDF (w 111) at dpi 72 (scale 1)
    expect((await a.get_source_image(0, 72, 0)).width).toBe(100)
    expect((await a.get_source_image(4, 72, 0)).width).toBe(111)
  })

  it('a later native page still classifies NORMAL (whole doc scanned, not first-N)', async () => {
    shared.pdfQueue = [fake_pdf(1, false), fake_pdf(1, true)]
    const a = new PdfRendererAdapter()
    const info = await a.load_files([pdf_file('scan.pdf'), pdf_file('native.pdf')])
    expect(info.mode).toBe(Mode.NORMAL)
  })
})

describe('mixed PDF + image load (§W2 row 4)', () => {
  it('does not throw on image pages; sizes and routing are per-source', async () => {
    shared.pdfQueue = [fake_pdf(2, true, 100, 200)]
    const a = new PdfRendererAdapter()
    const info = await a.load_files([pdf_file('a.pdf'), img_file('b.png', 200, 320), img_file('c.jpg', 150, 400)])
    expect(info.page_count).toBe(4)
    expect(info.mode).toBe(Mode.NORMAL)              // any native PDF page -> NORMAL
    expect(info.file_names).toEqual(['a.pdf', 'b.png', 'c.jpg'])
    expect(info.page_sizes[2]).toEqual({ width: 200, height: 320 })
    expect(info.page_sizes[3]).toEqual({ width: 150, height: 400 })
    // page 2 is an image -> old code threw here; now returns the decoded bitmap
    expect((await a.get_source_image(2, 200, 0)).width).toBe(200)
    // page 0 is the PDF -> renders at dpi 72 (scale 1) width 100
    expect((await a.get_source_image(0, 72, 0)).width).toBe(100)
  })

  it('all-image documents classify SCANNED', async () => {
    const a = new PdfRendererAdapter()
    const info = await a.load_files([img_file('x.png', 200, 300), img_file('y.png', 201, 300), img_file('z.png', 202, 300)])
    expect(info.page_count).toBe(3)
    expect(info.mode).toBe(Mode.SCANNED)
  })
})

describe('state lifecycle', () => {
  it('a fresh load replaces prior sources and destroys prior PDFs', async () => {
    const first = fake_pdf(2, true)
    shared.pdfQueue = [first]
    const a = new PdfRendererAdapter()
    await a.load_files([pdf_file('a.pdf')])
    shared.pdfQueue = [fake_pdf(3, true)]
    const info = await a.load_files([pdf_file('b.pdf')])
    expect(info.page_count).toBe(3)                  // not 5 — prior file dropped
    expect(first.destroy).toHaveBeenCalled()
  })

  it('get_source_image throws for an out-of-range index', async () => {
    shared.pdfQueue = [fake_pdf(1, true)]
    const a = new PdfRendererAdapter()
    await a.load_files([pdf_file('a.pdf')])
    await expect(a.get_source_image(5, 72, 0)).rejects.toThrow(/No source/)
  })

  it('wraps a failed load in DocumentLoadError', async () => {
    shared.pdfQueue = []                              // getDocument rejects
    const a = new PdfRendererAdapter()
    await expect(a.load_files([pdf_file('bad.pdf')])).rejects.toBeInstanceOf(DocumentLoadError)
  })
})
