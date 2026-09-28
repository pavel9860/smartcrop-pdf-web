// Real-browser regression for Dewarp & Deskew (spec-web §7.1a/§7.1b): a page that is already flat
// or only incidentally skewed must take the fast text-line-detection + vanishing-point path
// instead of the multi-second ONNX mesh-unwarp pipeline (the bug this feature exists to fix —
// dewarping an already-correct page was introducing its own small residual distortion). Uses real
// fixtures, decoded by the real browser (no image-decode dependency needed in the test itself,
// unlike tests/perf/deskew_speed.test.ts's synthetic pages) — and is the only place this repo
// proves the DBNet model actually loads and runs for real (tests/perf/ deliberately can't: no dev
// server for it to fetch the model from, same reason dewarp.ts's real ONNX inference is e2e-only,
// never perf-tested).
import { test, expect, type Page, type Locator } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const SKEW_ONLY_JPG = fileURLToPath(new URL(
  '../assets/Learning Python_sample_content_rot_5.jpg', import.meta.url))
// A real scanned page with a genuine skew (its own row-profile classic-CV read is ~1.6deg). Also
// used as the rotation-fold regression below: this repo's automatic keystone correction was
// investigated and abandoned (see docs/detrapezoid_research.md, gitignored, local reference only)
// — this fixture only exercises skew correction now, same as SKEW_ONLY_JPG.
const SKEWED_SCAN_PNG = fileURLToPath(new URL(
  '../assets/Learning Python_sample_content_trap.png', import.meta.url))
// Same page as SKEWED_SCAN_PNG, rotated 90deg as a whole image — regression for a real bug: the
// derived rotation was unbounded, so a page whose real content is itself rotated ~90deg (this
// file, genuinely) got that whole reorientation undone by Dewarp & Deskew, which isn't its job
// (Rotate's, §12). Only the small residual skew within that orientation should ever be corrected.
const ROTATED_SCAN_PNG = fileURLToPath(new URL(
  '../assets/Learning Python_sample_content_rot_90_trap.png', import.meta.url))

const checksum = (canvas: Locator): Promise<number> => canvas.evaluate((el: HTMLCanvasElement) => {
  const d = (el.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, el.width, el.height).data
  let s = 0
  for (let i = 0; i < d.length; i += 97) s = (s + (d[i] ?? 0) * (i + 1)) >>> 0
  return s
})

// Ink bounding-box aspect ratio (width/height of the dark-pixel extent) — a coarse but robust
// orientation signal: a genuine 90deg reorientation flips which side (width or height) is larger,
// while a fine skew correction (a few degrees, no axis swap) does not.
const ink_aspect = (canvas: Locator): Promise<number> => canvas.evaluate((el: HTMLCanvasElement) => {
  const ctx = el.getContext('2d') as CanvasRenderingContext2D
  const { data, width, height } = ctx.getImageData(0, 0, el.width, el.height)
  let x0 = width, y0 = height, x1 = 0, y1 = 0
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4
      if ((data[i] ?? 255) < 128) {
        if (x < x0) x0 = x; if (x > x1) x1 = x
        if (y < y0) y0 = y; if (y > y1) y1 = y
      }
    }
  }
  return (x1 - x0) / (y1 - y0)
})

// Which path ran is read from which model files the page fetched (each test context starts with an
// empty IndexedDB model cache), not from wall-clock time, which parallel workers make meaningless.
async function run_dewarp(page: Page, file: string): Promise<{ canvas: Locator; models: string[] }> {
  const models: string[] = []
  page.on('request', r => { if (r.url().includes('/models/')) models.push(r.url()) })
  await page.goto('/')
  await page.setInputFiles('#pp-file', file)
  await expect(page.locator('#pp-badge')).toHaveText('SCANNED', { timeout: 15_000 })
  await expect(page.locator('#nav-total')).toHaveText('/ 1')
  const canvas = page.locator('canvas.page-canvas')
  const before = await checksum(canvas)
  await page.click('#sp-dewarp')
  await expect.poll(() => checksum(canvas), { timeout: 120_000, intervals: [250] }).not.toBe(before)
  return { canvas, models }
}

const expect_fast_path = (models: string[]): void => {
  expect(models.some(u => u.includes('PP-OCRv4_det'))).toBe(true)
  expect(models.some(u => /uvdoc|bilinear/i.test(u))).toBe(false)
}

test('a skew-only real scan (~5deg, no warp) is corrected via the fast vanishing-point path, not ONNX', async ({ page }) => {
  test.setTimeout(180_000)
  expect_fast_path((await run_dewarp(page, SKEW_ONLY_JPG)).models)
})

test('a real skewed scan is corrected via DBNet + vanishing-point, not always-ONNX', async ({ page }) => {
  test.setTimeout(180_000)
  expect_fast_path((await run_dewarp(page, SKEWED_SCAN_PNG)).models)
})

test('the same scan rotated 90deg is corrected without undoing the 90deg orientation', async ({ page }) => {
  test.setTimeout(180_000)
  await page.goto('/')
  await page.setInputFiles('#pp-file', ROTATED_SCAN_PNG)
  await expect(page.locator('#pp-badge')).toHaveText('SCANNED', { timeout: 15_000 })
  const aspect_before = await ink_aspect(page.locator('canvas.page-canvas'))
  const { canvas, models } = await run_dewarp(page, ROTATED_SCAN_PNG)
  expect_fast_path(models)
  const aspect_after = await ink_aspect(canvas)
  // A fine skew correction changes the ink aspect only slightly; undoing the page's genuine ~90deg
  // orientation would flip which side is longer.
  expect(aspect_before < 1).toBe(aspect_after < 1)
})
