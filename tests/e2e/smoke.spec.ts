// Smoke / layout (spec-web §3). Verifies the three-column shell renders, the synthetic
// document (SYNTH_PAGES = 1) is loaded on start, and every primary control is present.
import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => { await page.goto('/') })

test('three-column layout renders with the synthetic document', async ({ page }) => {
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.locator('.canvas-area')).toBeVisible()
  await expect(page.locator('canvas.page-canvas')).toBeVisible()
  await expect(page.locator('#nav-total')).toHaveText('/ 1')
})

test('primary controls are present', async ({ page }) => {
  for (const id of [
    '#pp-load', '#cp-detect', '#cp-crop', '#cp-rotate', '#cp-delete',
    '#nav-undo', '#nav-redo', '#nav-reset', '#op-export', '[data-id="settings"]', '[data-id="help"]',
  ]) {
    await expect(page.locator(id)).toBeVisible()
  }
})

test('Settings detail panel opens and Esc closes it', async ({ page }) => {
  await page.click('[data-id="settings"]')
  await expect(page.locator('#sv-undo')).toBeVisible()   // a Settings control is now shown
  await page.keyboard.press('Escape')
  await expect(page.locator('#sv-undo')).toBeHidden()
})

test('opening/closing Settings or Help slides the panel over the canvas — the canvas never resizes (bug #3)', async ({ page }) => {
  const canvas = page.locator('canvas.page-canvas')
  const panel = page.locator('.detail-panel')
  // The panel's open/close transition is 180ms (app.css) — settle past it before measuring, or a
  // mid-animation snapshot could equal box_before by sheer timing coincidence in EITHER the buggy
  // (width-reflow) or fixed (overlay) layout, making the assertion meaningless either way. Races
  // transitionend against a fixed timeout: a backgrounded/CPU-starved tab under parallel test load
  // can throttle or coalesce the transition enough that the event never fires at all, which would
  // otherwise hang until the whole test times out (observed under 6-worker parallel runs).
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
  expect(await canvas.boundingBox()).toEqual(box_before)   // same size AND position — no reflow

  await page.keyboard.press('Escape')
  await expect(panel).not.toHaveClass(/open/)
  await settle()
  expect(await canvas.boundingBox()).toEqual(box_before)

  // Help must behave identically (same shared detail-panel/canvas-area mechanism).
  await page.click('[data-id="help"]')
  await expect(panel).toHaveClass(/open/)
  await settle()
  expect(await canvas.boundingBox()).toEqual(box_before)
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
