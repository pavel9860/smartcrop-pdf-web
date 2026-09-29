// Start guide (spec-web §1): shown over the placeholder, 3 pages, gone once a real file is open.
import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const JPG = fileURLToPath(new URL('../assets/Deep Work_sample.jpg', import.meta.url))

test('start guide pages through 3 pages and hides once a file is open', async ({ page }) => {
  await page.goto('/')
  const guide = page.locator('.start-guide')
  await expect(guide).toBeVisible()
  await expect(guide.locator('h2')).toHaveText(/Crop a PDF or scan/)
  await expect(guide.locator('[data-act="prev"]')).toBeDisabled()
  await guide.locator('[data-act="next"]').click()
  await expect(guide.locator('h2')).toHaveText(/Book spreads/)
  await guide.locator('.guide-dots button').nth(2).click()
  await expect(guide.locator('h2')).toHaveText('Tips')
  await expect(guide.locator('[data-act="next"]')).toBeDisabled()
  await page.setInputFiles('#pp-file', JPG)
  await expect(page.locator('#pp-badge')).toHaveText('SCANNED', { timeout: 15_000 })
  await expect(guide).toBeHidden()
})

test('the guide close button hides it for the session', async ({ page }) => {
  await page.goto('/')
  await page.click('.start-guide [data-act="close"]')
  await expect(page.locator('.start-guide')).toBeHidden()
  await page.click('#nav-reset')
  await expect(page.locator('.start-guide')).toBeHidden()
})
