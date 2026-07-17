// Regression coverage for export_pdf_vector's per-SOURCE-DOCUMENT copyPages() batching (bug #7).
// Same mocking approach as export_vector.test.ts (pdfjs-dist mocked, getData() returns real
// pdf-lib-built bytes so the actual assembly logic runs for real) but with a real multi-page
// source PDF, since the bug only shows up across several pages sharing one resource.
import { describe, it, expect, vi } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { readFileSync } from 'node:fs'

const PAGE_COUNT = 6

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {} as Record<string, unknown>,
  OPS: {
    constructPath: 1, fill: 2, eoFill: 3, fillStroke: 4, eoFillStroke: 5,
    stroke: 6, closeStroke: 7, closeFillStroke: 8, closeEOFillStroke: 9, shadingFill: 10,
  },
  getDocument: (opts: { data: Uint8Array }) => ({
    promise: Promise.resolve({
      numPages: PAGE_COUNT,
      destroy: vi.fn(() => Promise.resolve()),
      getData: () => Promise.resolve(opts.data),
      getPage: () => Promise.resolve({
        getViewport: () => ({ width: 400, height: 600 }),
        getTextContent: () => Promise.resolve({ items: [{ str: 'x'.repeat(20) }] }),
        getOperatorList: () => Promise.resolve({ fnArray: [] }),
        render: () => ({ promise: Promise.resolve() }),
        cleanup: () => { /* no-op */ },
      }),
    }),
  }),
}))

import { PdfRendererAdapter } from '@pdf/loader'
import type { VectorExportPage } from '@core/model'

function pdf_file(bytes: Uint8Array, name = 'book.pdf'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' })
}

const PHOTO_PATH = 'tests/assets/test_pdf_distorted_page-0001.jpg'   // relative to the vitest root (project root)

// A multi-page PDF where every page draws the SAME embedded photo (real, substantial byte data —
// unlike a StandardFonts reference, which pdf-lib stores as a tiny by-name reference and would
// show no measurable duplication cost either way) plus text via a shared font. If copyPages()
// doesn't dedupe a resource shared across pages when called once per page, this is what exposes it.
async function make_multi_page_pdf(pages = PAGE_COUNT, page_w = 400, page_h = 600): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const photo_bytes = new Uint8Array(readFileSync(PHOTO_PATH))
  const photo = await doc.embedJpg(photo_bytes)   // embedded ONCE, shared across every page below
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([page_w, page_h])
    page.drawImage(photo, { x: 0, y: 0, width: page_w, height: page_h })
    page.drawText(`Page ${p}`, { x: 20, y: page_h - 20, size: 14, font })
  }
  return doc.save()
}

describe('export_pdf_vector batches copyPages() per source document (bug #7)', () => {
  it('N unsplit pages from one source cost close to 1×, not N×, the shared-resource size', async () => {
    const page_w = 400, page_h = 600
    const src_bytes = await make_multi_page_pdf(PAGE_COUNT, page_w, page_h)
    const adapter = new PdfRendererAdapter()
    await adapter.load_files([pdf_file(src_bytes)])

    const entries: VectorExportPage[] = Array.from({ length: PAGE_COUNT }, (_, i) => ({
      orig_page: i,
      boxes: [{ x0: 20, y0: 20, x1: 380, y1: 580 }],
      page_w, page_h, rotation: 0,
    }))
    const out_bytes = await adapter.export_pdf_vector(entries)

    // A per-page-duplicated font would scale roughly with PAGE_COUNT; batched copyPages should
    // stay close to the source's own size (one shared font, once) — well under 2× the source,
    // nowhere near the ~19.5× the bug produced empirically on a real 190-page book.
    expect(out_bytes.length).toBeLessThan(src_bytes.length * 2)
  })

  it('each page still crops to its OWN distinct box after batching (no cross-page mixup)', async () => {
    const page_w = 400, page_h = 600
    const src_bytes = await make_multi_page_pdf(PAGE_COUNT, page_w, page_h)
    const adapter = new PdfRendererAdapter()
    await adapter.load_files([pdf_file(src_bytes)])

    const entries: VectorExportPage[] = Array.from({ length: PAGE_COUNT }, (_, i) => ({
      orig_page: i,
      // A distinct crop per page (widening by i*10 px) proves each output page's CropBox reflects
      // its OWN entry, not one shared/incorrectly-reused box from the batch.
      boxes: [{ x0: 0, y0: 0, x1: 100 + i * 10, y1: 200 + i * 10 }],
      page_w, page_h, rotation: 0,
    }))
    const out_bytes = await adapter.export_pdf_vector(entries)

    const outDoc = await PDFDocument.load(out_bytes)
    expect(outDoc.getPageCount()).toBe(PAGE_COUNT)
    for (let i = 0; i < PAGE_COUNT; i++) {
      const crop = outDoc.getPage(i).getCropBox()
      expect(crop.width).toBe(100 + i * 10)
      expect(crop.height).toBe(200 + i * 10)
    }
  })
})

describe('export_pdf_vector embeds a split source page once, not once per box (bug #7 corollary)', () => {
  it('a 4-way split of one page costs close to a single crop, not ~4×', async () => {
    const page_w = 400, page_h = 600
    const src_bytes = await make_multi_page_pdf(1, page_w, page_h)
    const adapter = new PdfRendererAdapter()
    await adapter.load_files([pdf_file(src_bytes)])

    const single_bytes = await adapter.export_pdf_vector([{
      orig_page: 0,
      boxes: [{ x0: 0, y0: 0, x1: page_w / 2, y1: page_h / 2 }],
      page_w, page_h, rotation: 0,
    }])
    const split4_bytes = await adapter.export_pdf_vector([{
      orig_page: 0,
      boxes: [
        { x0: 0, y0: 0, x1: page_w / 2, y1: page_h / 2 },
        { x0: page_w / 2, y0: 0, x1: page_w, y1: page_h / 2 },
        { x0: 0, y0: page_h / 2, x1: page_w / 2, y1: page_h },
        { x0: page_w / 2, y0: page_h / 2, x1: page_w, y1: page_h },
      ],
      page_w, page_h, rotation: 0,
    }])

    // Re-embedding the same page's photo once per box would scale ~4× the single-crop size;
    // embedding it once and drawing 4× with an offset should stay well under 2×.
    expect(split4_bytes.length).toBeLessThan(single_bytes.length * 2)
  })

  it('each split box still crops to its own region after the shared embed (no cross-box mixup)', async () => {
    const page_w = 400, page_h = 600
    const src_bytes = await make_multi_page_pdf(1, page_w, page_h)
    const adapter = new PdfRendererAdapter()
    await adapter.load_files([pdf_file(src_bytes)])

    const out_bytes = await adapter.export_pdf_vector([{
      orig_page: 0,
      boxes: [
        { x0: 0, y0: 0, x1: 100, y1: 600 },
        { x0: 100, y0: 0, x1: 400, y1: 600 },
      ],
      page_w, page_h, rotation: 0,
    }])
    const outDoc = await PDFDocument.load(out_bytes)
    expect(outDoc.getPageCount()).toBe(2)
    expect(outDoc.getPage(0).getSize()).toEqual({ width: 100, height: 600 })
    expect(outDoc.getPage(1).getSize()).toEqual({ width: 300, height: 600 })
  })
})
