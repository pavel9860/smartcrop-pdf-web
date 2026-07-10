// Direct unit coverage for imaging.ts's two non-CV-runtime helpers (C3, M3). Excluded from the
// coverage gate (vitest.config.ts) because the rendering functions need a real WASM cv context —
// but ensure_cv/fetch_with_idb_cache only touch `cv.onRuntimeInitialized`, `fetch`, and
// IndexedDB, all mockable under jsdom without a real OpenCV runtime.
import { describe, it, expect, vi, beforeEach } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */

const cv_mock: any = {}
vi.mock('@techstark/opencv-js', () => ({ default: cv_mock }))

function make_fake_indexeddb(stores: Map<string, Map<string, unknown>>): { open: (name: string, version: number) => any } {
  return {
    open(_name: string, _version: number) {
      const req: any = {}
      queueMicrotask(() => {
        if (!stores.has('models')) {
          req.result = { createObjectStore: (n: string) => stores.set(n, new Map()) }
          req.onupgradeneeded?.()
        }
        const map = stores.get('models')!
        req.result = {
          transaction(_storeName: string) {
            const tx: any = {}
            tx.objectStore = () => ({
              get(key: string) {
                const r: any = {}
                queueMicrotask(() => { r.result = map.get(key); r.onsuccess?.() })
                return r
              },
              put(value: unknown, key: string) { map.set(key, value) },
            })
            queueMicrotask(() => tx.oncomplete?.())
            return tx
          },
        }
        req.onsuccess?.()
      })
      return req
    },
  }
}

describe('ensure_cv (C3)', () => {
  beforeEach(() => { vi.resetModules(); delete cv_mock.onRuntimeInitialized })

  it('two concurrent calls share one init and both resolve once the runtime fires', async () => {
    const { ensure_cv } = await import('@pdf/imaging')
    const p1 = ensure_cv()
    const p2 = ensure_cv()
    // Caching means both callers got the SAME promise — a second concurrent call must not
    // install its own onRuntimeInitialized callback, clobbering the first's.
    expect(p1).toBe(p2)

    let settled = false
    const race = Promise.race([
      Promise.all([p1, p2]).then(() => { settled = true }),
      new Promise((resolve) => setTimeout(resolve, 50)),
    ])
    cv_mock.onRuntimeInitialized()
    await race
    expect(settled).toBe(true)
  })
})

describe('fetch_with_idb_cache (M3)', () => {
  let stores: Map<string, Map<string, unknown>>

  beforeEach(() => {
    vi.resetModules()
    stores = new Map()
    vi.stubGlobal('indexedDB', make_fake_indexeddb(stores))
  })

  it('does not cache a !ok response, and retries the fetch on the next call', async () => {
    const { fetch_with_idb_cache } = await import('@pdf/imaging')
    const fetch_mock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found', arrayBuffer: () => { throw new Error('must not be called') } })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer) })
    vi.stubGlobal('fetch', fetch_mock)

    await expect(fetch_with_idb_cache('k', 'u')).rejects.toThrow()
    expect(stores.get('models')?.has('k')).toBe(false)

    const bytes = await fetch_with_idb_cache('k', 'u')
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]))
    expect(fetch_mock).toHaveBeenCalledTimes(2)
    expect(stores.get('models')?.has('k')).toBe(true)
  })
})
