// Crop / split / reset output-page math (spec §7.3, §13). N-way split multiplies the output
// page count by N; Reset returns to the just-loaded synthetic state.
import { test, expect } from '@playwright/test'

test('a 2-way split doubles the output page count on apply', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#nav-total')).toHaveText('/ 24')
  await page.click('#cp-split [data-n="2"]')
  await page.click('#cp-crop')
  await expect(page.locator('#nav-total')).toHaveText('/ 48')
})

test('a 4-way split quadruples, and Reset restores the synthetic document', async ({ page }) => {
  await page.goto('/')
  await page.click('#cp-split [data-n="4"]')
  await page.click('#cp-crop')
  await expect(page.locator('#nav-total')).toHaveText('/ 96')
  await page.click('#nav-reset')
  await expect(page.locator('#nav-total')).toHaveText('/ 24')
})

test('undo reverts an applied crop', async ({ page }) => {
  await page.goto('/')
  await page.click('#cp-split [data-n="2"]')
  await page.click('#cp-crop')
  await expect(page.locator('#nav-total')).toHaveText('/ 48')
  await page.click('#nav-undo')
  await expect(page.locator('#nav-total')).toHaveText('/ 24')
})
