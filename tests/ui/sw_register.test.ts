// Offline auto-precache registration (T7). Public interface only.
import { describe, it, expect, vi } from 'vitest'
import { register_service_worker } from '@ui/sw_register'

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
