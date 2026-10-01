// Crop / split / reset output-page math (spec §7.3, §13). N-way split multiplies the output
// page count by N; Reset returns to the just-loaded manual.
import { test, expect } from '@playwright/test'
import { open_app, MANUAL_PAGES as N } from './open_app'

test('a 2-way split doubles the output page count on apply', async ({ page }) => {
  await open_app(page)
  await page.click('#cp-split [data-n="2"]')
  await page.click('#cp-crop')
  await expect(page.locator('#nav-total')).toHaveText(`/ ${2 * N}`)
})

test('a 4-way split quadruples, and Reset restores the manual', async ({ page }) => {
  await open_app(page)
  await page.click('#cp-split [data-n="4"]')
  await page.click('#cp-crop')
  await expect(page.locator('#nav-total')).toHaveText(`/ ${4 * N}`)
  await page.click('#nav-reset')
  await expect(page.locator('#nav-total')).toHaveText(`/ ${N}`)
})

test('undo reverts an applied crop', async ({ page }) => {
  await open_app(page)
  await page.click('#cp-split [data-n="2"]')
  await page.click('#cp-crop')
  await expect(page.locator('#nav-total')).toHaveText(`/ ${2 * N}`)
  await page.click('#nav-undo')
  await expect(page.locator('#nav-total')).toHaveText(`/ ${N}`)
})
