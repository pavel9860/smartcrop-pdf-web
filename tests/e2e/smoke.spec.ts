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

test('closed detail panel does not paint over the sidebar (regression)', async ({ page }) => {
  // .sidebar toBeVisible() alone doesn't catch this: it only checks the sidebar's OWN CSS
  // visibility, not whether an opaque sibling is stacked on top of it. The detail-panel is a
  // normal-flow flex sibling collapsed to width:0 while closed (spec-web §3) — width:0 makes
  // overlapping the sidebar structurally impossible, unlike the earlier position:absolute overlay
  // this regression test was written against (bug: sidebar looked empty until Settings/Help was
  // opened once, because that overlay's off-screen translateX fell short of the sidebar's width).
  const sidebar_box = (await page.locator('.sidebar').boundingBox())!
  const panel_box = (await page.locator('.detail-panel').boundingBox())!
  expect(panel_box.width).toBe(0)
  expect(panel_box.x).toBeGreaterThanOrEqual(sidebar_box.x + sidebar_box.width)
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

test('opening/closing Settings or Help reflows the canvas right by the sidebar width (spec-web §3)', async ({ page }) => {
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
