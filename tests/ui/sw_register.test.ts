// Offline auto-precache registration (T7). Public interface only.
import { describe, it, expect, vi } from 'vitest'

const ensure_cv = vi.fn().mockResolvedValue(undefined)
const ensure_onnx = vi.fn().mockResolvedValue(undefined)
vi.mock('@pdf/cv', () => ({ ensure_cv }))
vi.mock('@pdf/dewarp', () => ({ ensure_onnx }))

const { register_service_worker, warm_offline_cache } = await import('@ui/sw_register')

describe('register_service_worker', () => {
  it('does nothing outside a production build, even when serviceWorker is supported', () => {
    const register = vi.fn().mockResolvedValue(undefined)
    register_service_worker({ prod: false, base_url: '/' }, { register })
    expect(register).not.toHaveBeenCalled()
  })

  it('does nothing when serviceWorker is unsupported, even in production', () => {
    // No throw is the actual guarantee here — jsdom has no ServiceWorkerContainer to call into.
    expect(() => { register_service_worker({ prod: true, base_url: '/' }, null) }).not.toThrow()
  })

  it('registers sw.js under the configured base path in production', () => {
    const register = vi.fn().mockResolvedValue(undefined)
    register_service_worker({ prod: true, base_url: '/smartcrop-pdf-web/' }, { register })
    expect(register).toHaveBeenCalledWith('/smartcrop-pdf-web/sw.js')
  })

  it('never throws or rejects visibly when registration itself fails', async () => {
    const register = vi.fn().mockRejectedValue(new Error('registration denied'))
    expect(() => { register_service_worker({ prod: true, base_url: '/' }, { register }) }).not.toThrow()
    await Promise.resolve()   // let the rejection's .catch() run
    await Promise.resolve()
  })
})

describe('warm_offline_cache (Settings → Enable offline mode)', () => {
  it('runs the real OpenCV + ONNX init paths so their assets get cached, not a hardcoded URL list', async () => {
    ensure_cv.mockClear(); ensure_onnx.mockClear()
    await warm_offline_cache()
    expect(ensure_cv).toHaveBeenCalledTimes(1)
    expect(ensure_onnx).toHaveBeenCalledTimes(1)
  })
})
