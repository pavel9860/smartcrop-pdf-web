// Real-browser counterpart of tests/core/sequences.test.ts: one long mixed action sequence on a
// 3-page SCANNED document with pages of different sizes, through the real render/export path.
// Asserts no error dialog appears, the page counter stays in range, and the saved zip holds one
// image per output view.
import { test, expect, type Page } from '@playwright/test'
import { open_app } from './open_app'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'
import { readFileSync } from 'node:fs'

const asset = (name: string): string => fileURLToPath(new URL(`../assets/${name}`, import.meta.url))
const FILES = ['drawning_book_sample_trap.jpg', 'Deep Work_sample.jpg', 'Learning Python_sample_content_rot_90_trap.png'].map(asset)

async function counter(page: Page): Promise<[number, number]> {
  const pos = Number(await page.locator('#nav-page').inputValue())
  const total = Number((await page.locator('#nav-total').textContent())?.replace('/', '').trim())
  return [pos, total]
}

async function step(page: Page, action: () => Promise<void>): Promise<void> {
  await action()
  await expect(page.locator('#op-export')).toBeEnabled({ timeout: 60_000 })
  await expect(page.locator('.overlay__title', { hasText: /error|failed/i })).toHaveCount(0)
  const [pos, total] = await counter(page)
  expect(pos).toBeGreaterThanOrEqual(1)
  expect(pos).toBeLessThanOrEqual(total)
}

test('mixed action sequence on mixed-size scans ends in a correct Save', async ({ page }) => {
  test.setTimeout(240_000)
  await open_app(page)
  await page.setInputFiles('#pp-file', FILES)
  await expect(page.locator('#pp-badge')).toHaveText('SCANNED', { timeout: 15_000 })
  await expect(page.locator('#nav-total')).toHaveText('/ 3')

  await step(page, () => page.click('#sp-bw'))
  await step(page, () => page.click('#cp-split [data-n="2"]'))
  await step(page, () => page.click('#cp-detect'))
  await step(page, () => page.click('#cp-crop'))
  await expect(page.locator('#nav-total')).toHaveText('/ 6')
  await step(page, () => page.click('#nav-next'))
  await step(page, () => page.click('#nav-next'))
  await step(page, () => page.click('#cp-rotate'))
  await step(page, async () => {
    await page.click('#pp-modes [data-mode="EVEN"]')
    await page.click('#cp-delete')
    await page.click('[data-act="confirm"]')
    await page.click('#pp-modes [data-mode="ALL"]')
  })
  await expect(page.locator('#nav-total')).toHaveText('/ 4')
  await step(page, () => page.click('#cp-split [data-n="1"]'))
  await step(page, () => page.click('#nav-undo'))

  const [, total] = await counter(page)
  await page.selectOption('#op-format', 'JPG')
  const download = page.waitForEvent('download')
  await page.click('#op-export')
  const zip = unzipSync(new Uint8Array(readFileSync(await (await download).path())))
  const jpgs = Object.entries(zip).filter(([n]) => n.endsWith('.jpg'))
  expect(jpgs).toHaveLength(total)
  for (const [, bytes] of jpgs) expect(bytes.length).toBeGreaterThan(1000)
})
