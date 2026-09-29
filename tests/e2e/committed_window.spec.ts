// Committed-page crop window (frozen spec §9.3, batch C). A committed page stays zoomed to its
// crop; drawing a new window over it must NOT flip the canvas back to the full page. This is the
// one part of the fix that is a pointer-pixel mapping (canvas_view crop_origin) and so cannot be
// unit-tested — it is asserted here through window.__model (DEV hook, main.ts).
import { test, expect, type Page } from '@playwright/test'

interface Snap {
  page_w: number
  page_h: number
  crop_origin: { x: number; y: number }
  overlay: { kind: string }[]
}

const readSnap = (page: Page): Promise<Snap> => page.evaluate(() => {
  const m = (window as unknown as { __model?: { view_snapshot(): Snap } }).__model
  if (!m) throw new Error('window.__model missing — DEV hook not installed')
  const s = m.view_snapshot()
  return {
    page_w: s.page_w, page_h: s.page_h, crop_origin: s.crop_origin,
    overlay: s.overlay.map(o => ({ kind: o.kind })),
  }
})

async function drag(page: Page, ox: number, oy: number,
  fx0: number, fy0: number, fx1: number, fy1: number): Promise<void> {
  // fractions of the canvas box → viewport pixels; a mid-point move so the rubber-band registers.
  await page.mouse.move(ox + fx0, oy + fy0)
  await page.mouse.down()
  await page.mouse.move(ox + (fx0 + fx1) / 2, oy + (fy0 + fy1) / 2)
  await page.mouse.move(ox + fx1, oy + fy1)
  await page.mouse.up()
}

test('drawing on a committed page stays cropped and never flips to the full page', async ({ page }) => {
  await page.goto('/')
  const canvas = page.locator('canvas.page-canvas')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('no canvas bounding box')
  const { x, y, width: w, height: h } = box

  const full = await readSnap(page)
  expect(full.crop_origin).toEqual({ x: 0, y: 0 })

  // Draw a window on the full page, then Crop to commit it.
  await drag(page, x, y, w * 0.25, h * 0.25, w * 0.75, h * 0.75)
  await page.click('#cp-crop')
  const committed = await readSnap(page)
  expect(committed.page_w).toBeLessThan(full.page_w)   // now shown cropped
  expect(committed.crop_origin.x).toBeGreaterThan(0)   // origin at the crop's top-left
  expect(committed.crop_origin.y).toBeGreaterThan(0)
  expect(committed.overlay).toHaveLength(0)            // plain committed crop → no outline (bug 18)

  // Draw a smaller window on the CROPPED canvas.
  await drag(page, x, y, w * 0.35, h * 0.35, w * 0.6, h * 0.6)
  const after = await readSnap(page)

  // The fix: the view stayed cropped (did NOT revert to the full page) and shows the drawn window
  // as an outline over the crop. Before the fix this drag flipped the canvas back to the full page.
  expect(after.page_w).toBeCloseTo(committed.page_w, 3)
  expect(after.page_h).toBeCloseTo(committed.page_h, 3)
  expect(after.crop_origin).toEqual(committed.crop_origin)
  expect(after.overlay.some(o => o.kind === 'committed')).toBe(true)
})
