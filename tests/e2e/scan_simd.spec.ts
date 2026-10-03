// The real OpenCV.js (SIMD WASM) pipeline on a real scanned page: Auto-detect finds the body text
// (regression: glyphs below MIN_COMP_FRAC used to leave only a sliver, imaging.ts DETECT_CLOSE_W/H)
// and the B/W filter repaints the page within a generous wall-clock ceiling — "did not hang or fall
// back to something absurd"; the tight budgets live in tests/perf/scan_speed.test.ts.
import { test, expect } from '@playwright/test'
import { asset, open_scans, until_repainted, model } from './open_app'

interface Snap { page_w: number; page_h: number; overlay: { kind: string; box: { x0: number; y0: number; x1: number; y1: number } }[] }

test('Auto-detect finds the text block and the B/W filter renders on a real scan', async ({ page }) => {
  const canvas = await open_scans(page, [asset('Learning Python_sample_content.png')])
  await page.click('#cp-detect')
  const snap = (): Promise<Snap> => model(page, m => (m as unknown as { view_snapshot(): Snap }).view_snapshot())
  await expect.poll(async () => (await snap()).overlay.some(o => o.kind === 'auto'), { timeout: 15_000 }).toBe(true)
  const s = await snap()
  const box = s.overlay.find(o => o.kind === 'auto')!.box
  expect(box.x1 - box.x0).toBeGreaterThan(0.5 * s.page_w)
  expect(box.y1 - box.y0).toBeGreaterThan(0.5 * s.page_h)

  const ms = await until_repainted(canvas, () => page.click('#sp-bw'), 30_000)
  console.log(`[scan_simd] B/W filter: ${ms} ms`)
  expect(ms).toBeLessThan(20_000)
})
