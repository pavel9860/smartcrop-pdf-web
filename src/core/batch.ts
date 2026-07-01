// BatchJob protocol + BatchResult (ARCHITECTURE §6).
// Web version: result() returns Promise<BatchResult>; progress via onProgress callback.
// core/ only defines the interface; concrete implementations live in AppModel methods.

import type { SmartCropError } from './errors'

export class Ok      { readonly type = 'ok'        as const }
export class Cancelled { readonly type = 'cancelled' as const }
export class Failed  {
  readonly type = 'failed' as const
  constructor(readonly error: SmartCropError) {}
}
export type BatchResult = Ok | Cancelled | Failed

export type ProgressCallback = (done: number, total: number) => void

export interface BatchJob {
  readonly title: string
  readonly total: number
  readonly done:  number   // updated as work progresses
  cancel(): void
  onProgress(cb: ProgressCallback): void
  result(): Promise<BatchResult>
}

// Concrete implementation — wraps a Promise-based worker operation.
// The executor receives a controller it uses to report progress and completion.
export interface BatchController {
  readonly is_cancelled: boolean
  advance(n?: number): void                // increment done counter, fire callbacks
  complete(result: BatchResult): void      // resolve the result promise
}

export class PageBatchJob implements BatchJob {
  readonly title: string
  readonly total: number
  done = 0

  private _cancelled = false
  private _cbs: ProgressCallback[] = []
  private _resolve!: (r: BatchResult) => void
  private readonly _promise: Promise<BatchResult>

  constructor(title: string, total: number) {
    this.title = title
    this.total = total
    this._promise = new Promise<BatchResult>(res => { this._resolve = res })
  }

  cancel(): void {
    if (this._cancelled) return
    this._cancelled = true
    this._resolve(new Cancelled())
  }

  onProgress(cb: ProgressCallback): void { this._cbs.push(cb) }

  result(): Promise<BatchResult> { return this._promise }

  // Called by the async executor driving the job
  get controller(): BatchController {
    return {
      get is_cancelled() { return this._outer._cancelled },
      advance: (n = 1) => {
        this.done += n
        for (const cb of this._cbs) cb(this.done, this.total)
      },
      complete: (r) => { this._resolve(r) },
      _outer: this,
    } as BatchController & { _outer: PageBatchJob }
  }
}
