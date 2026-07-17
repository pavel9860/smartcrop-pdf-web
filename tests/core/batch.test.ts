// PageBatchJob (ARCHITECTURE §6) — progress callbacks, cancel idempotency, controller.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PageBatchJob, Ok, Failed, Cancelled, make_paint_yielder, start_batch, fail_batch } from '@core/batch'
import { PAINT_YIELD_INTERVAL_MS } from '@core/constants'

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

describe('start_batch', () => {
  it('returns the job immediately and fires the worker with it', async () => {
    const seen: number[] = []
    const job = start_batch('t', 5, (j) => {
      seen.push(j.total)
      j.controller.complete(new Ok())
      return Promise.resolve()
    })
    expect(job.title).toBe('t')
    expect(job.total).toBe(5)
    expect(await job.result()).toBeInstanceOf(Ok)
    expect(seen).toEqual([5])
  })

  it('a worker that rejects past its own error handling still resolves the job as Failed, not an unhandled rejection', async () => {
    const job = start_batch('t', 1, () => Promise.reject(new Error('boom')))
    const result = await job.result()
    expect(result).toBeInstanceOf(Failed)
    expect((result as Failed).error.message).toContain('boom')
  })
})

describe('fail_batch', () => {
  it('completes the controller with a Failed wrapping the error message', async () => {
    const job = new PageBatchJob('t', 1)
    fail_batch(job.controller, new Error('disk full'))
    const result = await job.result()
    expect(result).toBeInstanceOf(Failed)
    expect((result as Failed).error.message).toContain('disk full')
  })

  it('stringifies a non-Error thrown value', async () => {
    const job = new PageBatchJob('t', 1)
    fail_batch(job.controller, 'plain string reason')
    const result = await job.result()
    expect((result as Failed).error.message).toContain('plain string reason')
  })
})

describe('make_paint_yielder', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('does not yield (no macrotask scheduled) before the interval has elapsed', async () => {
    const yielder = make_paint_yielder()
    let resolved = false
    void yielder().then(() => { resolved = true })
    await Promise.resolve()   // flush microtasks only
    expect(resolved).toBe(true)   // under-interval calls resolve immediately, no setTimeout wait
    expect(vi.getTimerCount()).toBe(0)
  })

  it('yields (schedules a macrotask) once the interval has elapsed since the last yield', async () => {
    const yielder = make_paint_yielder()
    vi.advanceTimersByTime(PAINT_YIELD_INTERVAL_MS)
    let resolved = false
    const p = yielder().then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(false)   // now waiting on the real setTimeout(0)
    await vi.runAllTimersAsync()
    await p
    expect(resolved).toBe(true)
  })

  it('resets its clock on an actual yield, not on every call', async () => {
    const yielder = make_paint_yielder()
    vi.advanceTimersByTime(PAINT_YIELD_INTERVAL_MS)
    const first = yielder()   // actually yields (interval elapsed) — resets the internal clock to now
    await vi.runAllTimersAsync()
    await first

    let resolved = false
    void yielder().then(() => { resolved = true })   // immediately after — under interval again
    await Promise.resolve()
    expect(resolved).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
