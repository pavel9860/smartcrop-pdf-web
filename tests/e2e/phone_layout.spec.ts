// Phone layout (spec-web §3): full-width page, sidebar as a slide-out drawer, visible page arrows.
import { test, expect, devices, type Page } from '@playwright/test'
import { open_app, asset } from './open_app'

const JPGS = ['ml_interview_warped_001.jpg', 'ml_interview_warped_002.jpg'].map(asset)

test.use({ viewport: devices['Pixel 7'].viewport, hasTouch: true })

const sidebar_x = (page: Page): Promise<number> =>
  page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().x)

test('the sidebar is a drawer: closed by default, opened by the toggle, closed by the backdrop', async ({ page }) => {
  await open_app(page)
  const vw = page.viewportSize()!.width
  await expect.poll(() => sidebar_x(page)).toBeLessThan(-100)
  expect((await page.locator('.page-canvas').boundingBox())!.width).toBeGreaterThan(vw * 0.9)

  await page.click('.drawer-toggle')
  await expect.poll(() => sidebar_x(page)).toBe(0)
  await page.setInputFiles('#pp-file', JPGS)
  await expect(page.locator('#nav-total')).toHaveText('/ 2')

  await page.mouse.click(vw - 10, 300)                     // the backdrop, right of the drawer
  await expect.poll(() => sidebar_x(page)).toBeLessThan(-100)
  const next = page.locator('.canvas-nav--right')
  await expect(next).toBeVisible()
  expect(Number(await next.evaluate(el => getComputedStyle(el).opacity))).toBeGreaterThan(0.5)
  await next.click()
  await expect(page.locator('#nav-page')).toHaveValue('2')
})

test('desktop width keeps the fixed sidebar and hides the toggle', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await open_app(page)
  await expect(page.locator('.drawer-toggle')).toBeHidden()
  expect(await sidebar_x(page)).toBe(0)
})
