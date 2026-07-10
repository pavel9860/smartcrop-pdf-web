// work_store.ts — IndexedDB-backed store for processed scan rasters: the DISK tier of the model's
// two-tier work cache (spec-web §W2 row 5). The model keeps a small RAM LRU for the current viewing
// window; older processed pages spill here so revisiting them loads the raster back instead of
// re-running OpenCV/ONNX. Each page is thus processed at most once per settings-generation.
//
// Values are PNG blobs (lossless — a B/W bilevel page compresses to a few KB; a sharpen/dewarp page
// is larger but still far smaller than the raw RGBA). Keys are opaque strings the model owns (page
// index + intent hash). Every method is BEST-EFFORT: any IndexedDB failure degrades to a no-op
// (put/clear) or null (get), so a storage error never blocks or crashes scan processing — the model
// simply recomputes on a miss.

const DB_NAME = 'smartcrop-work'
const STORE = 'rasters'

export class WorkRasterStore {
  private _db: Promise<IDBDatabase> | null = null

  private _open(): Promise<IDBDatabase> {
    this._db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = (): void => { req.result.createObjectStore(STORE) }
      req.onsuccess = (): void => { resolve(req.result) }
      req.onerror   = (): void => { reject(req.error ?? new Error('IndexedDB open failed')) }
    })
    return this._db
  }

  async put(key: string, bitmap: ImageBitmap): Promise<void> {
    // Snapshot the pixels SYNCHRONOUSLY (drawImage before any await) so an LRU eviction that closes
    // `bitmap` right after this call returns cannot race the async PNG encode below.
    let blob: Blob
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(bitmap, 0, 0)
      blob = await canvas.convertToBlob({ type: 'image/png' })
    } catch {
      return   // no canvas/encode support (e.g. jsdom) — silently skip the disk tier
    }
    try {
      const db = await this._open()
      await tx_done(put_value(db, key, blob))
    } catch {
      /* best-effort: a full/blocked IndexedDB just means this page recomputes next time */
    }
  }

  async get(key: string): Promise<ImageBitmap | null> {
    try {
      const db = await this._open()
      const blob = await req_result<Blob | undefined>(get_value(db, key))
      if (!blob) return null
      return await createImageBitmap(blob)
    } catch {
      return null
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await this._open()
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      await tx_done(tx)
    } catch {
      /* best-effort */
    }
  }
}

function put_value(db: IDBDatabase, key: string, value: Blob): IDBTransaction {
  const tx = db.transaction(STORE, 'readwrite')
  tx.objectStore(STORE).put(value, key)
  return tx
}

function get_value(db: IDBDatabase, key: string): IDBRequest<Blob | undefined> {
  const tx = db.transaction(STORE, 'readonly')
  return tx.objectStore(STORE).get(key) as IDBRequest<Blob | undefined>
}

function req_result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = (): void => { resolve(req.result) }
    req.onerror   = (): void => { reject(req.error ?? new Error('IndexedDB request failed')) }
  })
}

function tx_done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = (): void => { resolve() }
    tx.onerror    = (): void => { reject(tx.error ?? new Error('IndexedDB transaction failed')) }
    tx.onabort    = (): void => { reject(tx.error ?? new Error('IndexedDB transaction aborted')) }
  })
}
