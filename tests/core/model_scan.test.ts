// AppModel scan toggles (spec-web §7, §12): the intent flips synchronously and undoably, then a
// warm batch pre-computes the selection's work rasters. The work cache is RAM-only and
// content-addressed per page, bounded by undo_depth + 1 versions per page.
import { describe, it, expect } from 'vitest'
import { Mode, FilterMode } from '@core/enums'
import { Ok, Cancelled, Failed } from '@core/batch'
import { DEFAULT_UNDO_DEPTH, FILTER_STRENGTH_MIN, FILTER_STRENGTH_MAX } from '@core/constants'
import { make_adapter, spy, n_calls, loaded } from './harness'

async function scanned(page_count = 3): Promise<{ m: Awaited<ReturnType<typeof loaded>>; work: () => number }> {
  const { adapter, calls } = spy(make_adapter({ page_count, mode: Mode.SCANNED }))
  const m = await loaded(adapter)
  return { m, work: () => n_calls(calls, 'get_work_image') }
}

describe('scan toggles', () => {
  it('Dewarp flips on synchronously and warms every selected page; pressing it again changes nothing', async () => {
    const { m, work } = await scanned()
    const job = m.run_dewarp()
    expect(m.dewarp_on).toBe(true)
    expect(await job.result()).toBeInstanceOf(Ok)
    expect(work()).toBe(3)
    await m.run_dewarp().result()
    m.undo()
    expect([m.dewarp_on, m.can_undo]).toEqual([false, false])
  })

  it('filter mode persists on re-press, switches between modes, and undo reverts it', async () => {
    const { m } = await scanned()
    m.set_filter_mode(FilterMode.BW)
    m.set_filter_mode(FilterMode.BW)
    m.set_filter_mode(FilterMode.SHARPEN)
    expect(m.filter_mode).toBe(FilterMode.SHARPEN)
    m.undo()
    expect(m.filter_mode).toBe(FilterMode.BW)
    m.undo()
    expect([m.filter_mode, m.can_undo]).toEqual([FilterMode.NONE, false])
  })

  it('filter strength clamps to its range and re-warms the selection', async () => {
    const { m, work } = await scanned()
    await m.set_filter_mode(FilterMode.SHARPEN).result()
    await m.set_filter_strength(99).result()
    expect([m.filter_strength, work()]).toEqual([FILTER_STRENGTH_MAX, 6])
    m.set_filter_strength(-5)
    expect(m.filter_strength).toBe(FILTER_STRENGTH_MIN)
  })

  it('cancel stops the warm pass but keeps the intent', async () => {
    const { m, work } = await scanned()
    const job = m.run_dewarp()
    job.cancel()
    expect(await job.result()).toBeInstanceOf(Cancelled)
    expect([work() < 3, m.dewarp_on]).toEqual([true, true])
  })

  it('a failing page fails the job, not the toggle call — and a failed Dewarp commits nothing', async () => {
    const m = await loaded({ ...make_adapter({ mode: Mode.SCANNED }), get_work_image: () => Promise.reject(new Error('boom')) })
    let job: ReturnType<typeof m.run_dewarp> | null = null
    expect(() => { job = m.run_dewarp() }).not.toThrow()
    expect(await job!.result()).toBeInstanceOf(Failed)
    expect(m.dewarp_on).toBe(false)
    await m.prepare_current_view()
    expect(m.view_snapshot().image).not.toBeNull()
  })

  it('the current view is never blank after a filter change', async () => {
    const { m } = await scanned()
    m.set_filter_mode(FilterMode.BW)
    await m.prepare_current_view()
    expect(m.view_snapshot().image).not.toBeNull()
  })
})

describe('work cache (spec-web §7, §12)', () => {
  it('a warmed page is a cache hit on view, on revisit, and after walking every other page', async () => {
    const { m, work } = await scanned(20)
    await m.set_filter_mode(FilterMode.BW).result()
    for (let p = 20; p >= 1; p--) { m.jump_to_output_page(p); await m.prepare_current_view() }
    await m.prepare_current_view()
    expect(work()).toBe(20)
  })

  it('Undo of a filter change or a Rotate reuses the still-cached bitmap', async () => {
    const { m, work } = await scanned(1)
    const step = async (): Promise<number> => { await m.prepare_current_view(); return work() }
    await m.set_filter_mode(FilterMode.BW).result()
    expect(await step()).toBe(1)
    await m.set_filter_mode(FilterMode.SHARPEN).result()
    expect(await step()).toBe(2)
    m.undo()
    expect(await step()).toBe(2)
    m.rotate_pages()
    expect(await step()).toBe(3)
    m.undo()
    expect(await step()).toBe(3)
  })

  it('each page keeps undo_depth + 1 versions; an older one is recomputed on revisit', async () => {
    const { m, work } = await scanned(1)
    expect(m.undo_depth).toBe(DEFAULT_UNDO_DEPTH)
    const apply = async (f: () => { result(): Promise<unknown> }): Promise<number> => {
      await f().result(); await m.prepare_current_view(); return work()
    }
    expect(await apply(() => m.set_filter_mode(FilterMode.BW))).toBe(1)
    expect(await apply(() => m.set_filter_strength(2))).toBe(2)
    expect(await apply(() => m.set_filter_strength(3))).toBe(3)
    expect(await apply(() => m.set_filter_mode(FilterMode.SHARPEN))).toBe(4)
    expect(await apply(() => m.set_filter_mode(FilterMode.BW))).toBe(4)
    expect(await apply(() => m.set_filter_strength(1))).toBe(5)
  })
})

describe('orchestration overhead (spec-web §16)', () => {
  it('Dewarp < 0.5 s and a filter < 0.3 s over 50 pages with instant compute', async () => {
    const { m } = await scanned(50)
    const ms = async (job: () => { result(): Promise<unknown> }): Promise<number> => {
      const t0 = performance.now(); await job().result(); return performance.now() - t0
    }
    expect(await ms(() => m.run_dewarp())).toBeLessThan(500)
    expect(await ms(() => m.set_filter_mode(FilterMode.BW))).toBeLessThan(300)
  })
})
