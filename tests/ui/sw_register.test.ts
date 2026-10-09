// Offline auto-precache registration (T7). Public interface only.
import { describe, it, expect, vi } from 'vitest'

const ensure_cv = vi.fn().mockResolvedValue(undefined)
const ensure_dbnet = vi.fn().mockResolvedValue(undefined)
vi.mock('@pdf/cv', () => ({ ensure_cv }))
vi.mock('@pdf/dbnet', () => ({ ensure_dbnet }))

const { register_service_worker, prefetch_scan_tools, set_offline_mode, get_offline_mode } = await import('@ui/sw_register')

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

describe('set_offline_mode / get_offline_mode (Settings → Enable offline mode, spec-web §15)', () => {
  // A fake active worker that answers on the transferred MessageChannel port, as public/sw.js does.
  function container(reply: (msg: { type: string; on?: boolean }) => unknown): Pick<ServiceWorkerContainer, 'getRegistration'> {
    const active = {
      postMessage: (msg: { type: string; on?: boolean }, ports: MessagePort[]) => { ports[0]!.postMessage(reply(msg)) },
    }
    return { getRegistration: () => Promise.resolve({ active } as unknown as ServiceWorkerRegistration) }
  }

  it('sends the switch to the worker and resolves with the state it reports', async () => {
    const seen: unknown[] = []
    const sw = container(msg => { seen.push(msg); return { ok: true, on: msg.on ?? true } })
    await expect(set_offline_mode(true, sw)).resolves.toEqual({ ok: true, on: true })
    await expect(get_offline_mode(sw)).resolves.toEqual({ ok: true, on: true })
    expect(seen).toEqual([{ type: 'set-offline', on: true }, { type: 'get-offline' }])
  })

  it('reports not-ok, off, when no service worker is active (dev server, unsupported browser)', async () => {
    const none = { getRegistration: () => Promise.resolve(undefined) }
    await expect(set_offline_mode(true, none)).resolves.toMatchObject({ ok: false, on: false })
    await expect(get_offline_mode(null)).resolves.toMatchObject({ ok: false, on: false })
  })
})

describe('prefetch_scan_tools (SCANNED document open)', () => {
  it('loads the image engine, then the text-line model, and swallows a failure', async () => {
    ensure_cv.mockClear(); ensure_dbnet.mockClear()
    ensure_dbnet.mockRejectedValueOnce(new Error('offline'))
    void prefetch_scan_tools()
    await vi.waitFor(() => { expect(ensure_dbnet).toHaveBeenCalledTimes(1) })
    expect(ensure_cv).toHaveBeenCalledTimes(1)
  })
})
