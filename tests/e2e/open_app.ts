import { expect, type Page } from '@playwright/test'

export const MANUAL_PAGES = 3

// The app starts on its manual (spec-web §1); a file load while that is still loading would be
// ignored as busy, so every test starts here.
export async function open_app(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('#nav-total')).toHaveText(`/ ${MANUAL_PAGES}`)
}
