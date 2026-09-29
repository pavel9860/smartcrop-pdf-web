// Vector export must crop the same region the preview shows. pdf.js (preview, page_sizes) views a
// page through its CropBox, offset to (0,0) and turned by the page's own /Rotate; this mock
// reproduces that viewport from the real pdf-lib-built bytes so export_pdf_vector runs for real.
import { describe, it, expect, vi } from 'vitest'
import { PDFDocument, PDFRawStream, PDFName, PDFDict, PDFArray, degrees } from 'pdf-lib'
import { unzlibSync, strFromU8 } from 'fflate'

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {} as Record<string, unknown>,
  OPS: {},
  getDocument: (opts: { data: Uint8Array }) => ({
    promise: PDFDocument.load(opts.data).then(doc => ({
      numPages: doc.getPageCount(),
      destroy: () => Promise.resolve(),
      getData: () => Promise.resolve(opts.data),
      getPage: (n: number) => {
        const page = doc.getPage(n - 1)
        const cb = page.getCropBox()
        const turned = page.getRotation().angle % 180 !== 0
        return Promise.resolve({
          getViewport: () => (turned ? { width: cb.height, height: cb.width } : { width: cb.width, height: cb.height }),
          getTextContent: () => Promise.resolve({ items: [{ str: 'x'.repeat(20) }] }),
          getOperatorList: () => Promise.resolve({ fnArray: [] }),
          render: () => ({ promise: Promise.resolve() }),
          cleanup: () => undefined,
        })
      },
    })),
  }),
}))

import { PdfRendererAdapter } from '@pdf/loader'

async function export_crop(
  setup: (doc: PDFDocument) => void, box: { x0: number; y0: number; x1: number; y1: number },
): Promise<{ crop: { x: number; y: number; width: number; height: number }; rotation: number }> {
  const doc = await PDFDocument.create()
  setup(doc)
  const adapter = new PdfRendererAdapter()
  const info = await adapter.load_files([new File([new Uint8Array(await doc.save())], 'a.pdf', { type: 'application/pdf' })])
  const sz = info.page_sizes[0]!
  const out = await PDFDocument.load(await adapter.export_pdf_vector([
    { orig_page: 0, boxes: [box], page_w: sz.width, page_h: sz.height, rotation: 0 },
  ]))
  const page = out.getPage(0)
  return { crop: page.getCropBox(), rotation: page.getRotation().angle }
}

describe('export_pdf_vector crops in the frame pdf.js shows', () => {
  it('honours a CropBox that does not start at the origin', async () => {
    const r = await export_crop(doc => {
      const p = doc.addPage([600, 800])
      p.setCropBox(100, 50, 400, 600)
    }, { x0: 0, y0: 0, x1: 200, y1: 300 })   // top-left quarter of the visible 400x600 page
    expect(r.crop).toEqual({ x: 100, y: 350, width: 200, height: 300 })
  })

  it('honours the source page\'s own /Rotate and keeps it on the output page', async () => {
    const r = await export_crop(doc => {
      const p = doc.addPage([400, 600])
      p.setRotation(degrees(90))
    }, { x0: 0, y0: 0, x1: 300, y1: 200 })   // top-left of the 600x400 page as displayed
    expect(r.crop).toEqual({ x: 0, y: 0, width: 200, height: 300 })
    expect(r.rotation).toBe(90)
  })

  it('split path: a MediaBox not at the origin is embedded whole and offset per box', async () => {
    const doc = await PDFDocument.create()
    const p = doc.addPage([600, 800])
    p.setMediaBox(50, 50, 600, 800)
    p.drawRectangle({ x: 60, y: 60, width: 10, height: 10 })
    const adapter = new PdfRendererAdapter()
    await adapter.load_files([new File([new Uint8Array(await doc.save())], 'a.pdf', { type: 'application/pdf' })])
    const out = await PDFDocument.load(await adapter.export_pdf_vector([{
      orig_page: 0, page_w: 600, page_h: 800, rotation: 0,
      boxes: [{ x0: 0, y0: 0, x1: 300, y1: 800 }, { x0: 300, y0: 0, x1: 600, y1: 800 }],
    }]))
    const right = out.getPage(1)
    const raw = out.context.lookup(right.node.get(PDFName.of('Contents')))
    const streams = raw instanceof PDFArray ? raw.asArray().map(r => out.context.lookup(r)) : [raw]
    const text = streams.map(st => {
      const bytes = (st as PDFRawStream).getContents()
      return (st as PDFRawStream).dict.get(PDFName.of('Filter')) ? strFromU8(unzlibSync(bytes)) : strFromU8(bytes)
    }).join('\n')
    expect(text).toContain('1 0 0 1 -300 0 cm')
    const xobjects = right.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict)
    const form = out.context.lookup(xobjects.values()[0]!) as PDFRawStream
    expect(form.dict.lookup(PDFName.of('Matrix'))!.toString()).toBe('[ 1 0 0 1 -50 -50 ]')
  })
})
