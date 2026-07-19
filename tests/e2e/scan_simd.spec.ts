// In-browser SIMD verification (#4): loads a real scanned page image, applies the B/W filter (the
// same OpenCV.js path detect/dewarp use), and checks it both renders correctly and completes in
// real browser wall-clock time — not just that the WASM module loads. Complements the byte-level
// SIMD disassembly check and the Node timing in tests/perf/scan_speed.test.ts (see
// vendor/opencv-js-simd/BUILD.md for that verification method).
import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'

// An image file (not a PDF) always classifies SCANNED (spec §4) and exercises the identical
// OpenCV.js pipeline — no PDF rasterization step needed for this test's purpose.
const SCAN_PDF = fileURLToPath(
  new URL('../assets/Learning Python, 5th Edition_cropped_015.png', import.meta.url))

test('a scanned PDF loads as SCANNED mode and the B/W filter renders correctly', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('#pp-file', SCAN_PDF)
  await expect(page.locator('#pp-badge')).toHaveText('SCANNED', { timeout: 15_000 })

  const canvas = page.locator('canvas.page-canvas')
  await expect(canvas).toBeVisible()
  // Checksum the WHOLE canvas (not a corner sample — page margins are uniform and unaffected by the
  // filter, which would falsely read as "no change").
  const checksum = (el: HTMLCanvasElement): number => {
    const d = (el.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, el.width, el.height).data
    let s = 0
    for (let i = 0; i < d.length; i += 97) s = (s + (d[i] ?? 0) * (i + 1)) >>> 0   // sparse but whole-image
    return s
  }
  const before = await canvas.evaluate(checksum)

  const t0 = Date.now()
  await page.click('#sp-bw')
  // The overlay only shows for job.display_total > 1 (app.ts dispatch_job) — best-effort wait, the
  // real completion signal below (overlay hidden again) is what's timed.
  await page.locator('.overlay').first().waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {})
  await page.locator('.overlay').first().waitFor({ state: 'hidden', timeout: 30_000 })
  const elapsed_ms = Date.now() - t0

  const after = await canvas.evaluate(checksum)
  expect(after).not.toBe(before)   // filter actually changed the rendered page, not a no-op

  console.log(`[scan_simd] B/W filter over the ${SCAN_PDF} pages: ${elapsed_ms} ms (in-browser, chromium/firefox)`)
  // Generous ceiling — this asserts "didn't hang / didn't fall back to something absurd", the
  // tight budget lives in tests/perf/scan_speed.test.ts's ratio-vs-desktop-reference assertion.
  expect(elapsed_ms).toBeLessThan(20_000)
})
