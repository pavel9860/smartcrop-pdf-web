// Dewarp & Deskew path choice on real scans (spec-web §7.1a/§7.1b): flat or merely skewed pages take
// the text-line (DBNet) + vanishing-point path, never the ONNX mesh unwarp, and a page whose content
// is genuinely rotated ~90° keeps that orientation (only residual skew is corrected — reorienting
// is Rotate's job, §12). The path is read from which model files the page fetched (each test
// context starts with an empty model cache), not from timing.
import { test, expect, type Locator } from '@playwright/test'
import { asset, open_scans, until_repainted } from './open_app'

// Ink bounding-box aspect: a 90° reorientation flips which side is longer, a few-degree skew fix does not.
const ink_aspect = (canvas: Locator): Promise<number> => canvas.evaluate((el: HTMLCanvasElement) => {
  const { data, width, height } = (el.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, el.width, el.height)
  let x0 = width, y0 = height, x1 = 0, y1 = 0
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if ((data[(y * width + x) * 4] ?? 255) < 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    }
  }
  return (x1 - x0) / (y1 - y0)
})

const SCANS: [string, string][] = [
  ['a ~5° skew-only page', 'Learning Python_sample_content_rot_5.jpg'],
  ['a real skewed scan', 'Learning Python_sample_content_trap.png'],
  ['the same scan turned 90° (keeps its orientation)', 'Learning Python_sample_content_rot_90_trap.png'],
]

for (const [name, file] of SCANS) {
  test(`${name} is straightened via DBNet + vanishing point, never ONNX`, async ({ page }) => {
    test.setTimeout(180_000)
    const models: string[] = []
    page.on('request', r => { if (r.url().includes('/models/')) models.push(r.url()) })
    const canvas = await open_scans(page, [asset(file)])
    const aspect_before = await ink_aspect(canvas)
    await until_repainted(canvas, () => page.click('#sp-dewarp'))
    expect((await ink_aspect(canvas)) < 1).toBe(aspect_before < 1)
    expect(models.some(u => u.includes('PP-OCRv4_det'))).toBe(true)
    expect(models.filter(u => u.includes('uvdoc'))).toEqual([])
  })
}
