// Page strip (spec-web §3) in a real browser: thumbnails draw lazily for visible pages, the
// current page is marked, a click navigates — and a thumbnail rendering at the same time as the
// main view never cancels it (pdf.js page.cleanup() race).
import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const NORMAL_PDF = fileURLToPath(new URL('../assets/Deep Work.pdf', import.meta.url))

test('page strip draws visible thumbnails and navigates on click', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('#pp-file', NORMAL_PDF)
  await expect(page.locator('#nav-total')).toHaveText('/ 190', { timeout: 30_000 })
  const items = page.locator('.page-strip__item')
  await expect(items).toHaveCount(190)
  const drawn = (): Promise<number> => page.locator('.page-strip__item canvas').evaluateAll(
    cs => cs.filter(c => (c as HTMLCanvasElement).width !== 51).length)
  await expect.poll(drawn, { timeout: 30_000 }).toBeGreaterThanOrEqual(3)
  expect(await drawn()).toBeLessThan(60)                   // lazy: far-off pages are not rendered
  await expect(items.nth(0)).toHaveClass(/current/)
  await items.nth(4).click()
  await expect(page.locator('#nav-page')).toHaveValue('5')
  await expect(items.nth(4)).toHaveClass(/current/)
  await expect(page.locator('.overlay__title', { hasText: /cancel|error|failed/i })).toHaveCount(0)
})
