// Regression for the SCANNED auto-detect bug: individual glyphs at DETECT_MAX_PX resolution never
// clear MIN_COMP_FRAC on their own, so without a pre-labeling merge (imaging.ts's DETECT_CLOSE_W/H
// close) real body text was discarded entirely and Auto-detect returned a near-zero-height sliver
// (an incidental component, e.g. a footer rule line) instead of the actual text block. Asserted via
// window.__model (DEV hook, main.ts) — the detected box's geometry isn't otherwise DOM-visible.
import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

interface Snap {
  page_w: number
  page_h: number
  overlay: { kind: string; box?: { x0: number; y0: number; x1: number; y1: number } }[]
}

const readSnap = (page: Page): Promise<Snap> => page.evaluate(() => {
  const m = (window as unknown as { __model?: { view_snapshot(): Snap } }).__model
  if (!m) throw new Error('window.__model missing — DEV hook not installed')
  const s = m.view_snapshot()
  return { page_w: s.page_w, page_h: s.page_h, overlay: s.overlay }
})

const SCAN_IMAGE = fileURLToPath(
  new URL('../assets/Learning Python, 5th Edition_cropped_015.png', import.meta.url))

test('auto-detect on a real scanned text page finds the body text, not a sliver', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('#pp-file', SCAN_IMAGE)
  await expect(page.locator('#pp-badge')).toHaveText('SCANNED', { timeout: 15_000 })

  await page.click('#cp-detect')
  await expect(page.locator('.overlay')).toHaveCount(1)
  await page.locator('.overlay').first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})

  const snap = await readSnap(page)
  const auto = snap.overlay.find(o => o.kind === 'auto')
  expect(auto?.box).toBeDefined()
  const box = auto!.box!

  const w = box.x1 - box.x0, h = box.y1 - box.y0
  // The bug produced a ~1px-tall sliver; a real text page's content spans a large majority of
  // both axes. Generous bounds — this guards against "collapsed to an incidental component", not
  // pixel-exact detection.
  expect(h).toBeGreaterThan(0.5 * snap.page_h)
  expect(w).toBeGreaterThan(0.5 * snap.page_w)
})
