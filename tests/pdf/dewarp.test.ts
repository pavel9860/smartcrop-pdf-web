// Direct unit coverage for dewarp.ts's non-ONNX-runtime helpers (fp16 conversion, M3's
// fetch_with_idb_cache). Excluded from the coverage gate for the rest of dewarp.ts
// (vitest.config.ts) — ensure_onnx/apply_dewarp need a real ONNX+OpenCV runtime — but these
// touch only pure bit math, `fetch`, and IndexedDB, all mockable under jsdom.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/* eslint-disable @typescript-eslint/no-explicit-any */

// dewarp.ts imports ./cv, which imports the real (heavy, WASM) opencv-js package at module
// scope — mock it so importing @pdf/dewarp in a test doesn't try to load that.
vi.mock('@techstark/opencv-js', () => ({ default: {} }))

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

describe('f32_array_to_f16_bits / f16_data_to_f32_array (fp16 conversion)', () => {
  it('round-trips known IEEE 754 binary16 bit patterns', async () => {
    const { f32_array_to_f16_bits, f16_data_to_f32_array } = await import('@pdf/dewarp')
    const cases: Array<[number, number]> = [
      [0, 0x0000], [-0, 0x8000], [1, 0x3c00], [-1, 0xbc00], [2, 0x4000], [0.5, 0x3800],
      [65504, 0x7bff],          // max finite fp16
      [Infinity, 0x7c00], [-Infinity, 0xfc00],
    ]
    const f32 = Float32Array.from(cases.map(([v]) => v))
    const bits = f32_array_to_f16_bits(f32)
    cases.forEach(([, expected_bits], i) => { expect(bits[i]).toBe(expected_bits) })

    const back = f16_data_to_f32_array(bits)
    cases.forEach(([expected], i) => { expect(back[i]).toBe(expected) })
  })

  it('NaN round-trips as NaN', async () => {
    const { f32_array_to_f16_bits, f16_data_to_f32_array } = await import('@pdf/dewarp')
    const bits = f32_array_to_f16_bits(Float32Array.from([NaN]))
    expect(f16_data_to_f32_array(bits)[0]).toBeNaN()
  })

  it('round-trips a spread of fractional values within fp16 precision (~3 significant digits)', async () => {
    const { f32_array_to_f16_bits, f16_data_to_f32_array } = await import('@pdf/dewarp')
    const values = [0.1, 0.3333, 1.5, 3.14159, -2.71828, 100.25, -0.001, 12345.6]
    const back = f16_data_to_f32_array(f32_array_to_f16_bits(Float32Array.from(values)))
    values.forEach((v, i) => { expect(back[i]).toBeCloseTo(v, v > 1000 ? -2 : 1) })
  })

  it('does not mutate the input Float32Array (reads via a view, not a copy)', async () => {
    const { f32_array_to_f16_bits } = await import('@pdf/dewarp')
    const input = Float32Array.from([1, 2, 3])
    const snapshot = Float32Array.from(input)
    f32_array_to_f16_bits(input)
    expect(input).toEqual(snapshot)
  })
})

describe('resolve_onnx_execution_providers (wasm thread count follows crossOriginIsolated)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('forces numThreads=1 when the page is not cross-origin isolated', async () => {
    vi.stubGlobal('crossOriginIsolated', false)
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 })
    const { resolve_onnx_execution_providers } = await import('@pdf/dewarp')
    const ort = { env: { wasm: {} as { numThreads?: number } } }
    resolve_onnx_execution_providers(ort)
    expect(ort.env.wasm.numThreads).toBe(1)
  })

  it('requests multiple threads, capped at WASM_MAX_THREADS, when cross-origin isolated with plenty of cores', async () => {
    vi.stubGlobal('crossOriginIsolated', true)
    vi.stubGlobal('navigator', { hardwareConcurrency: 16 })
    const { resolve_onnx_execution_providers } = await import('@pdf/dewarp')
    const { WASM_MAX_THREADS } = await import('@core/constants')
    const ort = { env: { wasm: {} as { numThreads?: number } } }
    resolve_onnx_execution_providers(ort)
    expect(ort.env.wasm.numThreads).toBe(WASM_MAX_THREADS)
  })

  it('never requests more threads than hardwareConcurrency reports, even when cross-origin isolated', async () => {
    vi.stubGlobal('crossOriginIsolated', true)
    vi.stubGlobal('navigator', { hardwareConcurrency: 2 })
    const { resolve_onnx_execution_providers } = await import('@pdf/dewarp')
    const ort = { env: { wasm: {} as { numThreads?: number } } }
    resolve_onnx_execution_providers(ort)
    expect(ort.env.wasm.numThreads).toBe(2)
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
    const { fetch_with_idb_cache } = await import('@pdf/dewarp')
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
