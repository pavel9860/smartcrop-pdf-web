// Page strip (spec-web §3) in a real browser: one chip per page, current page marked, click navigates.
import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const NORMAL_PDF = fileURLToPath(new URL('../assets/Deep Work.pdf', import.meta.url))

test('page strip shows one chip per page and navigates on click', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('#pp-file', NORMAL_PDF)
  await expect(page.locator('#nav-total')).toHaveText('/ 190', { timeout: 30_000 })
  const items = page.locator('.page-strip__item')
  await expect(items).toHaveCount(190)
  await expect(items.nth(0)).toHaveClass(/current/)
  await items.nth(4).click()
  await expect(page.locator('#nav-page')).toHaveValue('5')
  await expect(items.nth(4)).toHaveClass(/current/)
})
