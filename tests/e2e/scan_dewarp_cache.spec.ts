// Real-browser regression for the dewarped-intermediate cache (ARCHITECTURE §9a): switching the
// filter while Dewarp&Deskew stays on must reuse the dewarped raster, not re-run the ONNX dewarp
// pipeline. The exact call-count guarantee (dewarp computed exactly once across filter switches)
// is unit-tested deterministically in tests/core/page_raster_pipeline.test.ts with a mocked
// adapter — real wall-clock timing under parallel Playwright workers is too noisy for a tight or
// even a relative (ratio-to-dewarp) budget: two heavy CPU/WASM jobs in sibling workers can starve
// each other, so a `filter_ms < dewarp_ms / N` assertion was observed to flip depending on which
// worker got starved when, though it seems it should be always true (verified empirically over
// several runs). This test instead checks the two things a real browser run can prove that a
// mocked unit test can't: it doesn't hang, and the rendered result actually changed — the same
// "generous ceiling, not a tight budget" pattern as tests/e2e/scan_simd.spec.ts.
import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const SCAN_JPG = fileURLToPath(new URL('../assets/test_pdf_distorted_page-0001.jpg', import.meta.url))

test('1-page SCANNED doc: Dewarp&Deskew, then switching filters, completes and renders correctly', async ({ page }) => {
  test.setTimeout(400_000)   // 3 steps, each polled up to 120s under contention (see below)
  await page.goto('/')
  await page.setInputFiles('#pp-file', SCAN_JPG)
  await expect(page.locator('#pp-badge')).toHaveText('SCANNED', { timeout: 15_000 })
  await expect(page.locator('#nav-total')).toHaveText('/ 1')

  const canvas = page.locator('canvas.page-canvas')
  const checksum = (): Promise<number> => canvas.evaluate((el: HTMLCanvasElement) => {
    const d = (el.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, el.width, el.height).data
    let s = 0
    for (let i = 0; i < d.length; i += 97) s = (s + (d[i] ?? 0) * (i + 1)) >>> 0
    return s
  })

  // display_total===1 (single page) skips the progress overlay entirely (app.ts dispatch_job), so
  // it can't be used as a completion signal here (it may never appear, or may already be hidden
  // before the async work finishes) — poll the checksum itself instead, which is both the real
  // completion signal and the correctness assertion.
  const timed = async (click: () => Promise<void>): Promise<number> => {
    const before = await checksum()
    const t0 = Date.now()
    await click()
    await expect.poll(checksum, { timeout: 120_000, intervals: [250] }).not.toBe(before)
    return Date.now() - t0
  }

  // Each step below either resolves within the 120s poll (dewarp is a real two-stage ONNX model —
  // CNN + GridSample resample, also lazily fetching+compiling the model on first use, single-digit
  // seconds of pure inference on CPU/WASM with no WebGPU but observed up to ~60s under
  // sibling-worker CPU contention) or the poll itself throws a clear timeout — no separate ceiling
  // assertion needed. This asserts "real compute completed, didn't hang, actually changed the
  // page" — the tight overhead-only budget lives in tests/core/scan_orchestration_speed.test.ts,
  // and the exact dewarp-reuse guarantee in tests/core/page_raster_pipeline.test.ts.
  const dewarp_ms = await timed(() => page.click('#sp-dewarp'))
  const filter_ms = await timed(() => page.click('#sp-bw'))
  const filter2_ms = await timed(() => page.click('#sp-sharpen'))
  console.log(`[scan_dewarp_cache] dewarp: ${dewarp_ms}ms, filter after dewarp: ${filter_ms}ms, ` +
    `filter switch: ${filter2_ms}ms`)
})
