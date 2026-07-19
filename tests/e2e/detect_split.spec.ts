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

// Waits for the real multi-page document to finish loading. The mode badge alone is NOT a valid
// wait condition here — the synthetic placeholder document is already NORMAL by default, so
// `expect(#pp-badge).toHaveText('NORMAL')` is trivially true before the load even starts and
// doesn't wait for anything (a real bug in an earlier version of this test: it let split-detect
// run against the still-loading 1-page placeholder, and only some of that page's 190-page-real
// counterpart's data, depending on how the race happened to land — flaky and misleading, not
// exercising split-detect against the real document at all).
async function loaded(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __model?: { page_count(): number } }).__model!.page_count() > 1,
    null, { timeout: 15_000 },
  )
}

// Restricts detection to a single page (the 190-page default "All" selection would make every
// detect() call slow and its completion time timing-dependent) and waits on crop_rects actually
// changing, rather than a fixed sleep — robust regardless of machine/browser speed.
async function detectOnePage(
  page: Page, source_page: number, split_n: 2 | 4, opts: { same_size?: boolean } = {},
): Promise<void> {
  await page.click('[data-mode="SELECT"]')
  await page.fill('#pp-pattern', String(source_page))
  await page.click(`#cp-split [data-n="${split_n}"]`)   // reveals #cp-same-size (hidden at split=1)
  if (opts.same_size) await page.click('#cp-same-size')
  await page.evaluate(() => {
    const m = (window as unknown as { __model?: { document: { crop_rects: unknown[] } } }).__model!
    m.document.crop_rects = []   // sentinel so the wait below can't observe a stale value from a prior call
  })
  await page.click('#cp-detect')
  await page.waitForFunction(
    (n) => (window as unknown as { __model?: { document: { crop_rects: unknown[] } } })
      .__model!.document.crop_rects.length === n,
    split_n, { timeout: 15_000 },
  )
}

test('auto-detect at split=2 detects independently within each region', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('#pp-file', NORMAL_PDF)
  await loaded(page)
  await expect(page.locator('#cp-detect')).toBeEnabled()   // never gated by split > 1 (spec §4.5)

  await detectOnePage(page, 12, 2)

  const rects = await readCropRects(page)
  expect(rects).toHaveLength(2)
  // Left region's window sits left of the right region's — detection didn't collapse them together.
  expect(rects[0]!.x1).toBeLessThanOrEqual(rects[1]!.x0)
  for (const r of rects) {
    expect(r.x1 - r.x0).toBeGreaterThan(0)
    expect(r.y1 - r.y0).toBeGreaterThan(0)
  }
})

test('regression: the two windows meet exactly at the split boundary — no gap', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('#pp-file', NORMAL_PDF)
  await loaded(page)

  await detectOnePage(page, 12, 2)

  const rects = await readCropRects(page)
  expect(rects[0]!.x1).toBe(rects[1]!.x0)
})

test('regression: result is identical regardless of which page was open when Auto-detect was pressed', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('#pp-file', NORMAL_PDF)
  await loaded(page)

  await detectOnePage(page, 12, 2)
  const from_page12 = await readCropRects(page)

  await page.fill('#nav-page', '1')
  await page.keyboard.press('Enter')
  await detectOnePage(page, 12, 2)   // same detected page (12), different page open beforehand
  const from_page1_open = await readCropRects(page)

  expect(from_page1_open).toEqual(from_page12)
})

test('same_size ON gives every split region the same width and height', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('#pp-file', NORMAL_PDF)
  await loaded(page)

  await detectOnePage(page, 12, 2, { same_size: true })

  const rects = await readCropRects(page)
  expect(rects).toHaveLength(2)
  expect(rects[1]!.x1 - rects[1]!.x0).toBeCloseTo(rects[0]!.x1 - rects[0]!.x0, 3)
  expect(rects[1]!.y1 - rects[1]!.y0).toBeCloseTo(rects[0]!.y1 - rects[0]!.y0, 3)
})
