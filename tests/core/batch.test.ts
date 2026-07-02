// PageBatchJob (ARCHITECTURE §6) — progress callbacks, cancel idempotency, controller.
import { describe, it, expect } from 'vitest'
import { PageBatchJob, Ok, Cancelled } from '@core/batch'

describe('PageBatchJob', () => {
  it('advance increments done and fires every progress callback', async () => {
    const job = new PageBatchJob('t', 3)
    const seen: Array<[number, number]> = []
    job.onProgress((d, t) => seen.push([d, t]))
    const ctrl = job.controller
    ctrl.advance()
    ctrl.advance(2)
    expect(job.done).toBe(3)
    expect(seen).toEqual([[1, 3], [3, 3]])
    ctrl.complete(new Ok())
    expect(await job.result()).toBeInstanceOf(Ok)
  })

  it('cancel resolves Cancelled and is idempotent', async () => {
    const job = new PageBatchJob('t', 1)
    job.cancel()
    job.cancel()                       // second call early-returns
    expect(await job.result()).toBeInstanceOf(Cancelled)
    expect(job.controller.is_cancelled).toBe(true)
  })
})
