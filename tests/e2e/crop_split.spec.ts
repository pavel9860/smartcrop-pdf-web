// Split output-page math (spec-web §4.4, §12): an N-way split multiplies the output pages by N,
// Undo reverts the Crop, Reset returns to the just-opened manual.
import { test, expect } from '@playwright/test'
import { open_app, MANUAL_PAGES as N } from './open_app'

test('split crops multiply the output pages; Undo and Reset restore them', async ({ page }) => {
  await open_app(page)
  const total = page.locator('#nav-total')
  await page.click('#cp-split [data-n="2"]')
  await page.click('#cp-crop')
  await expect(total).toHaveText(`/ ${2 * N}`)
  await page.click('#nav-undo')
  await expect(total).toHaveText(`/ ${N}`)
  await page.click('#cp-split [data-n="4"]')
  await page.click('#cp-crop')
  await expect(total).toHaveText(`/ ${4 * N}`)
  await page.click('#nav-reset')
  await expect(total).toHaveText(`/ ${N}`)
})
