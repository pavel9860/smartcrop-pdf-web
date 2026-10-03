// Split-mode Auto-detect (spec-web §4.5/§5a) on a generated NORMAL PDF: detection runs per region,
// the result is one template independent of the page that happened to be open, and adjacent
// windows meet at the split line when text crosses it.
import { test, expect, type Page } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { open_app, model } from './open_app'

interface Box { x0: number; y0: number; x1: number; y1: number }

// 3 pages of 400×600. Page 2 holds lines drawn as two runs that straddle the centre line
// (x = 200): a left run centred in the left half and a right run centred in the right half.
async function fixture(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const run = 'the quick brown fox jumps'
  const size = 220 / font.widthOfTextAtSize(run, 1)
  for (let p = 0; p < 3; p++) {
    const page = doc.addPage([400, 600])
    if (p === 1) {
      for (let y = 520; y >= 120; y -= 40) {
        page.drawText(run, { x: 40, y, size, font })
        page.drawText(run, { x: 160, y: y - 20, size, font })
      }
    } else {
      page.drawText(run, { x: 30, y: 80 + p * 200, size: size / 2, font })
    }
  }
  return Buffer.from(await doc.save())
}

const crop_rects = (page: Page): Promise<Box[]> =>
  model(page, m => (m as unknown as { document: { crop_rects: Box[] } }).document.crop_rects.map(b => ({ ...b })))

async function detect_page_2(page: Page, n: 2 | 4, same_size = false): Promise<Box[]> {
  await page.click('[data-mode="SELECT"]')
  await page.fill('#pp-pattern', '2')
  await page.click(`#cp-split [data-n="${n}"]`)
  if (same_size) await page.click('#cp-same-size')
  const before = JSON.stringify(await crop_rects(page))
  await page.click('#cp-detect')
  await expect.poll(async () => JSON.stringify(await crop_rects(page))).not.toBe(before)
  return crop_rects(page)
}

async function load(page: Page): Promise<void> {
  await open_app(page)
  await page.setInputFiles('#pp-file', { name: 'two_runs.pdf', mimeType: 'application/pdf', buffer: await fixture() })
  await expect(page.locator('#pp-docname')).toContainText('two_runs')
  await expect(page.locator('#pp-badge')).toHaveText('NORMAL')
}

test('split=2 detects per region, windows meet at the split line, and the open page does not matter', async ({ page }) => {
  await load(page)
  await expect(page.locator('#cp-detect')).toBeEnabled()
  const from_page_1 = await detect_page_2(page, 2)
  expect(from_page_1).toHaveLength(2)
  const [l, r] = from_page_1 as [Box, Box]
  expect(l.x1).toBe(r.x0)
  expect([l.x0 > 0, r.x1 < 1, l.y0 > 0, l.y1 < 1]).toEqual([true, true, true, true])

  await page.fill('#nav-page', '3')
  await page.keyboard.press('Enter')
  await page.click('#cp-split [data-n="1"]')
  expect(await detect_page_2(page, 2)).toEqual(from_page_1)
})

test('same-size gives every region of a 4-split the same width and height', async ({ page }) => {
  await load(page)
  const rects = await detect_page_2(page, 4, true)
  const sizes = rects.map(b => [+(b.x1 - b.x0).toFixed(6), +(b.y1 - b.y0).toFixed(6)])
  expect(new Set(sizes.map(s => s.join())).size).toBe(1)
})
