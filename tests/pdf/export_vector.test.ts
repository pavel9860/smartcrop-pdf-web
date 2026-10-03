// export_pdf_vector (spec-web §10.3) against real pdf-lib documents. pdf.js is mocked only for what
// it reports about a page — the viewport it shows (CropBox size, turned by the page's own /Rotate) —
// so the pdf-lib assembly under test runs for real.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { PDFDocument, PDFRawStream, PDFName, PDFDict, PDFArray, StandardFonts, degrees } from 'pdf-lib'
import { unzlibSync, strFromU8 } from 'fflate'
import type { Box } from '@core/geometry'
import type { VectorExportPage } from '@core/model'

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
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

const PHOTO = new Uint8Array(readFileSync('tests/assets/ml_interview_warped_001.jpg'))

async function pdf(build: (doc: PDFDocument) => void | Promise<void>): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  await build(doc)
  return doc.save()
}

// `n` 400×600 pages each drawing the SAME embedded photo plus a line of text — a shared resource big
// enough that duplicating it per output page would be measurable.
const photos = (n = 1): Promise<Uint8Array> => pdf(async doc => {
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const photo = await doc.embedJpg(PHOTO)
  for (let p = 0; p < n; p++) {
    const page = doc.addPage([400, 600])
    page.drawImage(photo, { x: 0, y: 0, width: 400, height: 600 })
    page.drawText(`Page ${p}`, { x: 20, y: 580, size: 14, font })
  }
})

async function exported(src: Uint8Array, entries: (sizes: { width: number; height: number }[]) => VectorExportPage[]): Promise<{ bytes: Uint8Array; doc: PDFDocument }> {
  const a = new PdfRendererAdapter()
  const info = await a.load_files([new File([new Uint8Array(src)], 'a.pdf', { type: 'application/pdf' })])
  const bytes = await a.export_pdf_vector(entries(info.page_sizes))
  return { bytes, doc: await PDFDocument.load(bytes) }
}
const one = (boxes: Box[], page_w = 400, page_h = 600, rotation = 0, orig_page = 0): VectorExportPage =>
  ({ orig_page, boxes, page_w, page_h, rotation })

describe('unsplit pages', () => {
  it('keep the source page whole and narrow it with a CropBox in PDF space (bottom-left origin)', async () => {
    const { doc } = await exported(await photos(), () => [one([{ x0: 20, y0: 30, x1: 320, y1: 530 }])])
    const p = doc.getPage(0)
    expect([doc.getPageCount(), p.getMediaBox(), p.getCropBox()])
      .toEqual([1, { x: 0, y: 0, width: 400, height: 600 }, { x: 20, y: 70, width: 300, height: 500 }])
  })

  it('carry the app rotation as /Rotate and map the box back to the native frame', async () => {
    const { doc } = await exported(await photos(), () => [one([{ x0: 0, y0: 0, x1: 600, y1: 400 }], 600, 400, 90)])
    expect([doc.getPage(0).getRotation().angle, doc.getPage(0).getCropBox()]).toEqual([90, { x: 0, y: 0, width: 400, height: 600 }])
  })

  it('from one source share its resources: N pages stay under 2× the source size, each with its own crop', async () => {
    const N = 6
    const src = await photos(N)
    const { bytes, doc } = await exported(src, () => Array.from({ length: N }, (_, i) => one([{ x0: 0, y0: 0, x1: 100 + i * 10, y1: 200 + i * 10 }], 400, 600, 0, i)))
    expect(bytes.length).toBeLessThan(src.length * 2)
    expect(doc.getPages().map(p => [p.getCropBox().width, p.getCropBox().height]))
      .toEqual(Array.from({ length: N }, (_, i) => [100 + i * 10, 200 + i * 10]))
  })
})

describe('split pages', () => {
  it('become one output page per box, sized to the box', async () => {
    const { doc } = await exported(await photos(), () => [one([{ x0: 0, y0: 0, x1: 100, y1: 600 }, { x0: 100, y0: 0, x1: 400, y1: 600 }])])
    expect(doc.getPages().map(p => p.getSize())).toEqual([{ width: 100, height: 600 }, { width: 300, height: 600 }])
  })

  it('embed the source page once: a 4-way split costs under 2× a single crop', async () => {
    const src = await photos()
    const q = (x: number, y: number): Box => ({ x0: x, y0: y, x1: x + 200, y1: y + 300 })
    const single = await exported(src, () => [one([q(0, 0)])])
    const four = await exported(src, () => [one([q(0, 0), q(200, 0), q(0, 300), q(200, 300)])])
    expect(four.bytes.length).toBeLessThan(single.bytes.length * 2)
  })

  it('offset a MediaBox that does not start at the origin', async () => {
    const src = await pdf(doc => {
      const p = doc.addPage([600, 800])
      p.setMediaBox(50, 50, 600, 800)
      p.drawRectangle({ x: 60, y: 60, width: 10, height: 10 })
    })
    const { doc } = await exported(src, () => [one([{ x0: 0, y0: 0, x1: 300, y1: 800 }, { x0: 300, y0: 0, x1: 600, y1: 800 }], 600, 800)])
    const right = doc.getPage(1)
    const raw = doc.context.lookup(right.node.get(PDFName.of('Contents')))
    const streams = raw instanceof PDFArray ? raw.asArray().map(r => doc.context.lookup(r)) : [raw]
    const text = streams.map(st => {
      const s = st as PDFRawStream
      return s.dict.get(PDFName.of('Filter')) ? strFromU8(unzlibSync(s.getContents())) : strFromU8(s.getContents())
    }).join('\n')
    expect(text).toContain('1 0 0 1 -300 0 cm')
    const form = doc.context.lookup(right.node.Resources()!.lookup(PDFName.of('XObject'), PDFDict).values()[0]!) as PDFRawStream
    expect(form.dict.lookup(PDFName.of('Matrix'))!.toString()).toBe('[ 1 0 0 1 -50 -50 ]')
  })
})

describe('the frame pdf.js shows', () => {
  it('a CropBox not at the origin offsets the exported crop', async () => {
    const src = await pdf(doc => { doc.addPage([600, 800]).setCropBox(100, 50, 400, 600) })
    const { doc } = await exported(src, s => [one([{ x0: 0, y0: 0, x1: 200, y1: 300 }], s[0]!.width, s[0]!.height)])
    expect(doc.getPage(0).getCropBox()).toEqual({ x: 100, y: 350, width: 200, height: 300 })
  })

  it('the source page\'s own /Rotate is honoured and kept', async () => {
    const src = await pdf(doc => { doc.addPage([400, 600]).setRotation(degrees(90)) })
    const { doc } = await exported(src, s => [one([{ x0: 0, y0: 0, x1: 300, y1: 200 }], s[0]!.width, s[0]!.height)])
    expect([doc.getPage(0).getCropBox(), doc.getPage(0).getRotation().angle]).toEqual([{ x: 0, y: 0, width: 200, height: 300 }, 90])
  })
})

describe('image pages of a mixed document', () => {
  it('embed the image and crop it to the box in its native frame, keeping the app rotation', async () => {
    const jpg = await (await PDFDocument.create()).embedJpg(PHOTO)
    vi.stubGlobal('createImageBitmap', () => Promise.resolve({ width: jpg.width, height: jpg.height, close: () => undefined }))
    try {
      const a = new PdfRendererAdapter()
      const info = await a.load_files([
        new File([new Uint8Array(await photos())], 'a.pdf', { type: 'application/pdf' }),
        new File([PHOTO], 'b.jpg', { type: 'image/jpeg' }),
      ])
      expect(info.page_sizes[1]).toEqual({ width: jpg.width, height: jpg.height })
      const { width: w, height: h } = info.page_sizes[1]!
      const out = await PDFDocument.load(await a.export_pdf_vector([
        one([{ x0: 10, y0: 20, x1: 110, y1: 220 }], w, h, 0, 1),
        one([{ x0: 0, y0: 0, x1: 300, y1: 100 }], h, w, 90, 1),
      ]))
      expect(out.getPages().map(p => [p.getSize(), p.getRotation().angle])).toEqual([
        [{ width: 100, height: 200 }, 0], [{ width: 100, height: 300 }, 90],
      ])
      expect(out.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict).keys()).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
