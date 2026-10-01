// Dropping files anywhere on the window (here: the sidebar, outside the canvas) opens them.
import { test, expect } from '@playwright/test'
import { open_app } from './open_app'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const JPG = readFileSync(fileURLToPath(new URL('../assets/Deep Work_sample.jpg', import.meta.url))).toString('base64')

test('dropping an image on the sidebar opens it', async ({ page }) => {
  await open_app(page)
  const transfer = await page.evaluateHandle((b64) => {
    const dt = new DataTransfer()
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    dt.items.add(new File([bytes], 'dropped.jpg', { type: 'image/jpeg' }))
    return dt
  }, JPG)
  const sidebar = page.locator('.sidebar-scroll')
  await sidebar.dispatchEvent('dragenter', { dataTransfer: transfer })
  await expect(page.locator('.drop-zone')).toBeVisible()
  await sidebar.dispatchEvent('drop', { dataTransfer: transfer })
  await expect(page.locator('#pp-badge')).toHaveText('SCANNED', { timeout: 15_000 })
  await expect(page.locator('#pp-docname')).toContainText('dropped')
  await expect(page.locator('.drop-zone')).toBeHidden()
})
