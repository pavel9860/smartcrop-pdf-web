// Smoke / layout (spec-web §3). Verifies the three-column shell renders, the manual is loaded on
// start (spec-web §1), and every primary control is present.
import { test, expect } from '@playwright/test'
import { open_app } from './open_app'

test.beforeEach(async ({ page }) => { await open_app(page) })

test('the three-column shell renders with the manual open, every primary control visible and the closed detail panel off the sidebar', async ({ page }) => {
  await expect(page.locator('canvas.page-canvas')).toBeVisible()
  await expect(page.locator('#pp-docname')).toContainText('manual')
  for (const sel of [
    '.sidebar', '.canvas-area', '#pp-load', '#cp-detect', '#cp-crop', '#cp-rotate', '#cp-delete',
    '#nav-undo', '#nav-redo', '#nav-reset', '#op-export', '[data-id="settings"]', '[data-id="help"]',
  ]) await expect(page.locator(sel)).toBeVisible()
  // A collapsed (width 0) flex sibling cannot stack over the sidebar; toBeVisible alone would not
  // notice an opaque panel on top of it.
  const sidebar_box = (await page.locator('.sidebar').boundingBox())!
  const panel_box = (await page.locator('.detail-panel').boundingBox())!
  expect(panel_box.width).toBe(0)
  expect(panel_box.x).toBeGreaterThanOrEqual(sidebar_box.x + sidebar_box.width)
})

test('deleting every page shows a themed info dialog, not a toast or a confirm prompt (bug 18)', async ({ page }) => {
  // "All" is selected by default — deleting every page always fails (DeleteAllPagesError), so it's
  // checked before any dialog opens.
  await page.click('#cp-delete')
  // .overlay__card also matches the always-in-DOM (but class="hidden" by default) progress
  // overlay (overlay.ts) — scope to the OK button, which only the alert dialog has.
  const dialog = page.locator('.overlay__card', { has: page.locator('[data-act="ok"]') })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Cannot delete all pages')
  await expect(dialog.locator('[data-act="cancel"]')).toHaveCount(0)   // info, not a yes/no confirm
  await expect(page.locator('.error-toast')).toHaveCount(0)
  await dialog.locator('[data-act="ok"]').click()
  await expect(dialog).toHaveCount(0)   // removed on dismiss, unlike the progress overlay's hide()
})

test('Settings/Help toggle open and closed (not on Esc) and reflow the canvas by the panel width (spec-web §3)', async ({ page }) => {
  const canvas = page.locator('canvas.page-canvas')
  const panel = page.locator('.detail-panel')
  const sidebar_box = (await page.locator('.sidebar').boundingBox())!
  // The panel's open/close transition is 180ms (app.css) — settle past it before measuring, or a
  // mid-animation snapshot could match box_before by sheer timing coincidence. Races transitionend
  // against a fixed timeout: a backgrounded/CPU-starved tab under parallel test load can throttle
  // or coalesce the transition enough that the event never fires at all, which would otherwise
  // hang until the whole test times out (observed under 6-worker parallel runs).
  const settle = (): Promise<void> => panel.evaluate(
    el => new Promise<void>(resolve => {
      const done = (): void => { el.removeEventListener('transitionend', done); resolve() }
      el.addEventListener('transitionend', done, { once: true })
      setTimeout(done, 1000)
    }),
  )

  const box_before = await canvas.boundingBox()
  expect(box_before).not.toBeNull()

  await page.click('[data-id="settings"]')
  await expect(panel).toHaveClass(/open/)
  await settle()
  const panel_box_open = (await panel.boundingBox())!
  expect(panel_box_open.width).toBe(sidebar_box.width)   // same width as the sidebar (spec-web §3)
  const box_open = (await canvas.boundingBox())!
  expect(box_open.x).toBeCloseTo(box_before!.x + sidebar_box.width, 0)   // pushed right by the panel
  expect(box_open.width).toBeCloseTo(box_before!.width - sidebar_box.width, 0)

  await page.keyboard.press('Escape')
  await expect(panel).toHaveClass(/open/)   // Esc drops the crop window, never the panel (spec-web §20)
  await page.click('[data-id="settings"]')
  await expect(panel).not.toHaveClass(/open/)
  await settle()
  expect(await canvas.boundingBox()).toEqual(box_before)   // back to the original position/size

  // Help shares the same reflow mechanism as Settings, but at 1.5x the width (item 2).
  await page.click('[data-id="help"]')
  await expect(panel).toHaveClass(/open/)
  await settle()
  const help_panel_box = (await panel.boundingBox())!
  expect(help_panel_box.width).toBeCloseTo(sidebar_box.width * 1.5, 0)
  expect((await canvas.boundingBox())!.x).toBeCloseTo(box_before!.x + sidebar_box.width * 1.5, 0)
})

test('Ctrl+/Ctrl- zoom stepping always lands exactly on a preset, never an approximation (M1)', async ({ page }) => {
  await page.click('[data-id="settings"]')
  const zoom = page.locator('#sv-zoom')
  await expect(zoom).toHaveValue('1')   // 100% default

  // Dispatched directly rather than page.keyboard.press('Control+=') — Ctrl/Cmd +/- is a
  // browser-reserved page-zoom shortcut in a real browser and doesn't reliably reach the page's
  // own keydown listener via a simulated OS-level key combo; app.ts listens on window keydown
  // regardless of focus, so a direct dispatch exercises the same handler just as faithfully.
  const press = (key: string): Promise<void> => page.evaluate((k) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true }))
  }, key)

  await press('=')
  // Steps to the next preset above 1.0 (1.15) — not a free-form +0.1 that would land off-grid
  // and force the dropdown to show a "nearest" approximation instead of the true live value.
  await expect(zoom).toHaveValue('1.15')
  await press('=')
  await expect(zoom).toHaveValue('1.3')
  await press('-')
  await expect(zoom).toHaveValue('1.15')
  await press('0')
  await expect(zoom).toHaveValue('1')
})
