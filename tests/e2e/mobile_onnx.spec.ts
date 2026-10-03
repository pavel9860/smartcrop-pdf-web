// Android Chrome regression: "another WebGPU EP inference session is being created". Runs the
// real ONNX models on a mobile viewport on the CPU (wasm) EP — once with WebGPU absent, once with a
// broken navigator.gpu so ORT's WebGPU build fails and create_onnx_session must fall back, and once
// on SwiftShader-emulated WebGPU so concurrent WebGPU session builds are exercised for real.
import { test, expect, devices } from '@playwright/test'
import { open_app, asset, checksum } from './open_app'

const SCAN_JPG = asset('ml_interview_warped_001.jpg')

test.use({
  viewport: devices['Pixel 7'].viewport, hasTouch: true,
  launchOptions: { args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'] },
})

const GPU_SETUPS: Record<string, () => void> = {
  'emulated WebGPU': () => undefined,
  'no WebGPU': () => { delete (Navigator.prototype as { gpu?: unknown }).gpu },
  'broken WebGPU': () => {
    Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => ({ requestAdapter: () => Promise.resolve(null) }) })
  },
}

for (const [name, init] of Object.entries(GPU_SETUPS)) {
  test(`mobile Dewarp&Deskew loads and runs the ONNX models (${name})`, async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Android Chrome regression')
    test.setTimeout(240_000)
    await page.addInitScript(init)
    await open_app(page)
    await page.click('.drawer-toggle')                   // phone layout: controls live in the drawer
    await page.setInputFiles('#pp-file', SCAN_JPG)
    await expect(page.locator('#pp-badge')).toHaveText('SCANNED', { timeout: 15_000 })
    const canvas = page.locator('canvas.page-canvas')
    const before = await checksum(canvas)
    await page.click('#sp-dewarp')
    await expect.poll(async () => {
      const err = await page.locator('.overlay__title').allTextContents()
      if (err.some(t => t.includes('Failed'))) throw new Error(err.join('\n'))
      return checksum(canvas)
    }, { timeout: 200_000, intervals: [500] }).not.toBe(before)
  })
}
