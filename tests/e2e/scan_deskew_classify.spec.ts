// Real-browser regression for the Dewarp & Deskew warp classifier (spec-web §7.1a): a page that is
// already flat or only incidentally skewed must take the fast classic-CV rotate-only path instead
// of the multi-second ONNX mesh-unwarp pipeline (the bug this feature exists to fix — dewarping an
// already-correct page was introducing its own small residual distortion). Uses the real fixtures
// this feature was designed and validated against, decoded by the real browser (no image-decode
// dependency needed in the test itself, unlike tests/perf/deskew_speed.test.ts's synthetic pages).
import { test, expect, type Page, type Locator } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const SKEW_ONLY_JPG = fileURLToPath(new URL(
  '../assets/Learning Python, 5th Edition_cropped_015_rot.jpg', import.meta.url))
const TRAPEZOID_PNG = fileURLToPath(new URL(
  '../assets/Learning Python, 5th Edition_cropped_015_trap.png', import.meta.url))

// A single classic-CV rotate-only correction is a few tens of ms of real work (tests/perf/
// deskew_speed.test.ts's <300ms/page budget); the ONNX path this feature avoids for these pages is
// documented (scan_dewarp_cache.spec.ts) at single-digit seconds, observed up to ~60s under
// sibling-worker contention. This ceiling is generous specifically so it stays far below the ONNX
// cost while comfortably clearing normal e2e/CPU-contention noise for the classic-CV path.
const FAST_PATH_CEILING_MS = 8_000

const checksum = (canvas: Locator): Promise<number> => canvas.evaluate((el: HTMLCanvasElement) => {
  const d = (el.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, el.width, el.height).data
  let s = 0
  for (let i = 0; i < d.length; i += 97) s = (s + (d[i] ?? 0) * (i + 1)) >>> 0
  return s
})

async function load_scan(page: Page, file: string): Promise<void> {
  await page.goto('/')
  await page.setInputFiles('#pp-file', file)
  await expect(page.locator('#pp-badge')).toHaveText('SCANNED', { timeout: 15_000 })
  await expect(page.locator('#nav-total')).toHaveText('/ 1')
}

test('a skew-only real scan (~1.82deg, no warp) takes the fast classic-CV rotate path, not ONNX', async ({ page }) => {
  test.setTimeout(60_000)
  await load_scan(page, SKEW_ONLY_JPG)
  const canvas = page.locator('canvas.page-canvas')

  const before = await checksum(canvas)
  const t0 = Date.now()
  await page.click('#sp-dewarp')
  await expect.poll(() => checksum(canvas), { timeout: 15_000, intervals: [100] }).not.toBe(before)
  const ms = Date.now() - t0

  console.log(`[scan_deskew_classify] skew-only real scan: ${ms}ms`)
  expect(ms).toBeLessThan(FAST_PATH_CEILING_MS)
})

test('a trapezoid-distorted real scan does not regress to always-ONNX (classifier correctly reads it as not warped)', async ({ page }) => {
  test.setTimeout(60_000)
  await load_scan(page, TRAPEZOID_PNG)
  const canvas = page.locator('canvas.page-canvas')

  const before = await checksum(canvas)
  const t0 = Date.now()
  await page.click('#sp-dewarp')
  await expect.poll(() => checksum(canvas), { timeout: 15_000, intervals: [100] }).not.toBe(before)
  const ms = Date.now() - t0

  console.log(`[scan_deskew_classify] trapezoid real scan: ${ms}ms`)
  expect(ms).toBeLessThan(FAST_PATH_CEILING_MS)
})
