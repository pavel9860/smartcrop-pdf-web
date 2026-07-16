// Regression coverage for export_pdf_vector's unsplit-case size fix (Problems.md #4). Mocks
// pdfjs-dist the same minimal way loader.test.ts does (real pdf.js needs a worker that can't
// spawn under jsdom/vitest — same class of issue as ARCHITECTURE.md §7a) — but getData() returns
// bytes from a REAL pdf-lib-built PDF, so the actual pdf-lib assembly logic under test (what
// changed) still runs for real, not mocked.
import { describe, it, expect, vi } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {} as Record<string, unknown>,
  OPS: {
    constructPath: 1, fill: 2, eoFill: 3, fillStroke: 4, eoFillStroke: 5,
    stroke: 6, closeStroke: 7, closeFillStroke: 8, closeEOFillStroke: 9, shadingFill: 10,
  },
  getDocument: (opts: { data: Uint8Array }) => ({
    promise: Promise.resolve({
      numPages: 1,
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

function pdf_file(bytes: Uint8Array, name = 'test.pdf'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' })
}

// A page with a non-trivial content stream (many text lines) — a near-empty page wouldn't show a
// measurable size difference between embedPage's Form-XObject path and copyPages.
async function make_test_pdf(page_w = 400, page_h = 600): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([page_w, page_h])
  for (let i = 0; i < 40; i++) {
    page.drawText(`Line ${i}: the quick brown fox jumps over the lazy dog ${i * 7}`, {
      x: 20, y: page_h - 20 - i * 14, size: 10, font,
    })
  }
  return doc.save()
}

// Reference implementation of the OLD embedPage-based single-crop export, kept local to this test
// as the "before" baseline — the fix replaced this path for the unsplit case, so there's nothing
// left in source to compare against directly.
async function embed_page_baseline(srcBytes: Uint8Array, cropW: number, cropH: number): Promise<Uint8Array> {
  const outDoc = await PDFDocument.create()
  const srcDoc = await PDFDocument.load(srcBytes)
  const srcPage = srcDoc.getPage(0)
  const outPage = outDoc.addPage([cropW, cropH])
  const embedded = await outDoc.embedPage(srcPage, {
    left: 0, right: cropW, bottom: 0, top: cropH,
  })
  outPage.drawPage(embedded, { x: 0, y: 0, width: cropW, height: cropH })
  return outDoc.save({ useObjectStreams: true })
}

describe('export_pdf_vector unsplit-case size (Problems.md #4)', () => {
  it('a single-box (unsplit) export is smaller than the old embedPage Form-XObject approach', async () => {
    const page_w = 400, page_h = 600
    const src_bytes = await make_test_pdf(page_w, page_h)

    const adapter = new PdfRendererAdapter()
    await adapter.load_files([pdf_file(src_bytes)])

    const crop_w = 300, crop_h = 500
    const new_bytes = await adapter.export_pdf_vector([{
      orig_page: 0,
      boxes: [{ x0: 20, y0: 20, x1: 20 + crop_w, y1: 20 + crop_h }],
      page_w, page_h, rotation: 0,
    }])
    const baseline_bytes = await embed_page_baseline(src_bytes, crop_w, crop_h)

    expect(new_bytes.length).toBeLessThan(baseline_bytes.length)
  })

  it('crops to the correct CropBox dimensions for the unsplit case', async () => {
    const page_w = 400, page_h = 600
    const src_bytes = await make_test_pdf(page_w, page_h)
    const adapter = new PdfRendererAdapter()
    await adapter.load_files([pdf_file(src_bytes)])

    const crop_w = 300, crop_h = 500
    const out_bytes = await adapter.export_pdf_vector([{
      orig_page: 0,
      boxes: [{ x0: 20, y0: 20, x1: 20 + crop_w, y1: 20 + crop_h }],
      page_w, page_h, rotation: 0,
    }])

    const outDoc = await PDFDocument.load(out_bytes)
    expect(outDoc.getPageCount()).toBe(1)
    // getSize() reports the MediaBox (unchanged, still the source's full page) — CropBox is what
    // actually narrows the visible/print area, so check that directly.
    const crop = outDoc.getPage(0).getCropBox()
    expect(crop.width).toBe(crop_w)
    expect(crop.height).toBe(crop_h)
  })

  it('applies rotation for the unsplit case (entry.rotation is the sole source of truth)', async () => {
    // page_w/page_h must be the CURRENT (post-rotation) dims per VectorExportPage's contract — a
    // native 400x600 page rotated 90 degrees displays as 600x400.
    const native_w = 400, native_h = 600
    const src_bytes = await make_test_pdf(native_w, native_h)
    const adapter = new PdfRendererAdapter()
    await adapter.load_files([pdf_file(src_bytes)])

    const out_bytes = await adapter.export_pdf_vector([{
      orig_page: 0,
      boxes: [{ x0: 0, y0: 0, x1: native_h, y1: native_w }],   // full current (rotated) page
      page_w: native_h, page_h: native_w, rotation: 90,
    }])

    const outDoc = await PDFDocument.load(out_bytes)
    const outPage = outDoc.getPage(0)
    expect(outPage.getRotation().angle).toBe(90)
    // Full current-frame box maps back to the full native page regardless of rotation.
    const crop = outPage.getCropBox()
    expect(crop.width).toBe(native_w)
    expect(crop.height).toBe(native_h)
  })

  it('still uses the split (multi-box) path for >1 box per source page', async () => {
    const page_w = 400, page_h = 600
    const src_bytes = await make_test_pdf(page_w, page_h)
    const adapter = new PdfRendererAdapter()
    await adapter.load_files([pdf_file(src_bytes)])

    const out_bytes = await adapter.export_pdf_vector([{
      orig_page: 0,
      boxes: [
        { x0: 0, y0: 0, x1: 200, y1: 600 },
        { x0: 200, y0: 0, x1: 400, y1: 600 },
      ],
      page_w, page_h, rotation: 0,
    }])
    const outDoc = await PDFDocument.load(out_bytes)
    expect(outDoc.getPageCount()).toBe(2)
    expect(outDoc.getPage(0).getSize()).toEqual({ width: 200, height: 600 })
    expect(outDoc.getPage(1).getSize()).toEqual({ width: 200, height: 600 })
  })
})
