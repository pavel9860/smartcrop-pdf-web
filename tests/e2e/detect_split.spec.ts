// Regression for split-mode Auto-detect (spec §4.5/§5a): detection now runs independently within
// each split region and writes the result into crop_rects, instead of being disabled at split > 1.
// Asserted via window.__model (DEV hook, main.ts) — crop_rects geometry isn't otherwise DOM-visible.
import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

interface Box { x0: number; y0: number; x1: number; y1: number }

const readCropRects = (page: Page): Promise<Box[]> => page.evaluate(() => {
  const m = (window as unknown as { __model?: { document: { crop_rects: Box[] } } }).__model
  if (!m) throw new Error('window.__model missing — DEV hook not installed')
  return m.document.crop_rects
})

const NORMAL_PDF = fileURLToPath(new URL('../assets/Deep Work.pdf', import.meta.url))

test('auto-detect at split=2 detects independently within each region', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('#pp-file', NORMAL_PDF)
  await expect(page.locator('#pp-badge')).toHaveText('NORMAL', { timeout: 15_000 })

  await page.click('#cp-split [data-n="2"]')
  await expect(page.locator('#cp-detect')).toBeEnabled()   // never gated by split > 1 (spec §4.5)
  await page.click('#cp-detect')
  await page.waitForTimeout(300)   // split=1 batches show an overlay to wait on; split detect here is instant (1 page)

  const rects = await readCropRects(page)
  expect(rects).toHaveLength(2)
  // Left region's window sits left of the right region's — detection didn't collapse them together.
  expect(rects[0]!.x1).toBeLessThanOrEqual(rects[1]!.x0)
  for (const r of rects) {
    expect(r.x1 - r.x0).toBeGreaterThan(0)
    expect(r.y1 - r.y0).toBeGreaterThan(0)
  }
})

test('same_size ON gives every split region the same width and height', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('#pp-file', NORMAL_PDF)
  await expect(page.locator('#pp-badge')).toHaveText('NORMAL', { timeout: 15_000 })

  await page.click('#cp-split [data-n="2"]')
  await page.click('#cp-same-size')
  await page.click('#cp-detect')
  await page.waitForTimeout(300)

  const rects = await readCropRects(page)
  expect(rects).toHaveLength(2)
  expect(rects[1]!.x1 - rects[1]!.x0).toBeCloseTo(rects[0]!.x1 - rects[0]!.x0, 3)
  expect(rects[1]!.y1 - rects[1]!.y0).toBeCloseTo(rects[0]!.y1 - rects[0]!.y0, 3)
})
