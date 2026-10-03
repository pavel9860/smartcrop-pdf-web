// Shared e2e helpers. The app starts on its manual (spec-web §1); a file load while that is still
// loading would be ignored as busy, so every test starts from open_app().
import { expect, type Page, type Locator } from '@playwright/test'
import { fileURLToPath } from 'node:url'

export const MANUAL_PAGES = 3

export const asset = (name: string): string => fileURLToPath(new URL(`../assets/${name}`, import.meta.url))

export async function open_app(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('#nav-total')).toHaveText(`/ ${MANUAL_PAGES}`)
}

export async function open_scans(page: Page, files: string[]): Promise<Locator> {
  await open_app(page)
  await page.setInputFiles('#pp-file', files)
  await expect(page.locator('#pp-badge')).toHaveText('SCANNED', { timeout: 15_000 })
  await expect(page.locator('#nav-total')).toHaveText(`/ ${files.length}`)
  return page.locator('canvas.page-canvas')
}

// Sparse whole-canvas pixel checksum — page margins are uniform, so a corner sample would miss a change.
export const checksum = (canvas: Locator): Promise<number> => canvas.evaluate((el: HTMLCanvasElement) => {
  const d = (el.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, el.width, el.height).data
  let s = 0
  for (let i = 0; i < d.length; i += 97) s = (s + (d[i] ?? 0) * (i + 1)) >>> 0
  return s
})

// Clicks, then waits for the canvas to repaint with different pixels — the completion signal of a
// scan operation (its overlay only appears after a delay, so it is no reliable signal).
export async function until_repainted(canvas: Locator, act: () => Promise<void>, timeout = 120_000): Promise<number> {
  const before = await checksum(canvas)
  const t0 = Date.now()
  await act()
  await expect.poll(() => checksum(canvas), { timeout, intervals: [250] }).not.toBe(before)
  return Date.now() - t0
}

// Reads the AppModel through the DEV-build hook (main.ts) — geometry that is not DOM-visible.
export function model<T>(page: Page, read: (m: Record<string, never>) => T): Promise<T> {
  return page.evaluate(`(${read.toString()})(window.__model)`) as Promise<T>
}
