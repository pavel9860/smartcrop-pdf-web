// Direct unit coverage for the shared IndexedDB open/request/transaction-wait helpers used by
// dewarp.ts's ONNX model-weight cache. Pure IndexedDB-event plumbing, mockable under jsdom without
// a real browser.
import { describe, it, expect } from 'vitest'
import { open_idb, idb_req, idb_tx } from '@pdf/idb'

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('open_idb', () => {
  it('creates the store on first open and resolves with the database', async () => {
    const created: string[] = []
    const fake_indexeddb: any = {
      open(name: string, _version: number) {
        const req: any = {}
        queueMicrotask(() => {
          req.result = { createObjectStore: (n: string) => created.push(n), name }
          req.onupgradeneeded?.()
          req.onsuccess?.()
        })
        return req
      },
    }
    const original = (globalThis as any).indexedDB
    ;(globalThis as any).indexedDB = fake_indexeddb
    try {
      const result = await open_idb('test-db', 'test-store')
      expect(created).toEqual(['test-store'])
      expect((result as any).name).toBe('test-db')
    } finally {
      (globalThis as any).indexedDB = original
    }
  })

  it('rejects when indexedDB.open itself errors', async () => {
    const fake_indexeddb: any = {
      open() {
        const req: any = {}
        queueMicrotask(() => { req.error = new Error('boom'); req.onerror?.() })
        return req
      },
    }
    const original = (globalThis as any).indexedDB
    ;(globalThis as any).indexedDB = fake_indexeddb
    try {
      await expect(open_idb('d', 's')).rejects.toThrow('boom')
    } finally {
      (globalThis as any).indexedDB = original
    }
  })
})

describe('idb_req', () => {
  it('resolves with the request result on success', async () => {
    const req: any = {}
    const p = idb_req(req)
    req.result = 42
    req.onsuccess()
    await expect(p).resolves.toBe(42)
  })

  it('rejects with the request error on failure', async () => {
    const req: any = { error: new Error('req failed') }
    const p = idb_req(req)
    req.onerror()
    await expect(p).rejects.toThrow('req failed')
  })
})

describe('idb_tx', () => {
  it('resolves on transaction completion', async () => {
    const tx: any = {}
    const p = idb_tx(tx)
    tx.oncomplete()
    await expect(p).resolves.toBeUndefined()
  })

  it('rejects on transaction error', async () => {
    const tx: any = { error: new Error('tx failed') }
    const p = idb_tx(tx)
    tx.onerror()
    await expect(p).rejects.toThrow('tx failed')
  })

  it('rejects on transaction abort', async () => {
    const tx: any = { error: new Error('tx aborted') }
    const p = idb_tx(tx)
    tx.onabort()
    await expect(p).rejects.toThrow('tx aborted')
  })
})
