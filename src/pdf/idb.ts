// idb.ts — generic IndexedDB open/request/transaction-wait helpers, used by dewarp.ts's ONNX
// model-weight cache (the only disk-cached asset — per-page rasters are RAM-only, spec-web §7).

export function open_idb(db_name: string, store_name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(db_name, 1)
    req.onupgradeneeded = (): void => { req.result.createObjectStore(store_name) }
    req.onsuccess = (): void => { resolve(req.result) }
    req.onerror   = (): void => { reject(req.error ?? new Error('IndexedDB open failed')) }
  })
}

export function idb_req<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = (): void => { resolve(req.result) }
    req.onerror   = (): void => { reject(req.error ?? new Error('IndexedDB request failed')) }
  })
}

export function idb_tx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = (): void => { resolve() }
    tx.onerror    = (): void => { reject(tx.error ?? new Error('IndexedDB transaction failed')) }
    tx.onabort    = (): void => { reject(tx.error ?? new Error('IndexedDB transaction aborted')) }
  })
}
