// Smoke / layout (spec-web §W3). Verifies the three-column shell renders, the synthetic
// document (SYNTH_PAGES = 24) is loaded on start, and every primary control is present.
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
