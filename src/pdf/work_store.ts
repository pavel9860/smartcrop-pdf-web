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

import { open_idb, idb_req, idb_tx } from './idb'

const DB_NAME = 'smartcrop-work'
const STORE = 'rasters'

export class WorkRasterStore {
  private _db: Promise<IDBDatabase> | null = null

  private _open(): Promise<IDBDatabase> {
    this._db ??= open_idb(DB_NAME, STORE)
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
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(blob, key)
      await idb_tx(tx)
    } catch {
      /* best-effort: a full/blocked IndexedDB just means this page recomputes next time */
    }
  }

  async get(key: string): Promise<ImageBitmap | null> {
    try {
      const db = await this._open()
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key) as IDBRequest<Blob | undefined>
      const blob = await idb_req(req)
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
      await idb_tx(tx)
    } catch {
      /* best-effort */
    }
  }
}
