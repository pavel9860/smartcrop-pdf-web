// Dewarp & Deskew in a real browser (spec-web §7, ARCHITECTURE §9a): the real ONNX dewarp completes
// and changes the page; switching filters and rotating afterwards reuse the dewarped raster — rotate
// lands far below the dewarp's own multi-second cost. Exact reuse counts are unit-tested
// (tests/core/page_raster_pipeline.test.ts); wall-clock here only proves nothing re-ran ONNX.
import { test, expect } from '@playwright/test'
import { asset, open_scans, until_repainted } from './open_app'

test('Dewarp, then B/W, Sharpen and Rotate all render, and Rotate does not re-run the dewarp', async ({ page }) => {
  test.setTimeout(400_000)
  const canvas = await open_scans(page, [asset('ml_interview_warped_001.jpg')])
  const dewarp_ms = await until_repainted(canvas, () => page.click('#sp-dewarp'))
  await until_repainted(canvas, () => page.click('#sp-bw'))
  await until_repainted(canvas, () => page.click('#sp-sharpen'))
  const rotate_ms = await until_repainted(canvas, () => page.click('#cp-rotate'), 10_000)
  console.log(`[scan_dewarp_cache] dewarp ${dewarp_ms} ms, rotate after dewarp ${rotate_ms} ms`)
  expect(rotate_ms).toBeLessThan(3000)
})
