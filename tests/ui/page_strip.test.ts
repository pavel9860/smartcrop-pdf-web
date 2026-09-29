import { describe, it, expect, vi, afterEach } from 'vitest'
import { PageStrip } from '@ui/page_strip'
import { AppModel } from '@core/model'
import { PagesMode } from '@core/enums'
import { mount, make_adapter, make_ctrl, stub_canvas_apis } from './harness'

type IOCallback = (entries: { target: Element; isIntersecting: boolean }[]) => void

async function setup(page_count: number, with_thumbs = true): Promise<{
  model: AppModel; strip: PageStrip; root: HTMLElement; renders: number[]; show: (ps: number[]) => void
}> {
  stub_canvas_apis()
  let io_cb: IOCallback = () => undefined
  vi.stubGlobal('IntersectionObserver', class {
    constructor(cb: IOCallback) { io_cb = cb }
    observe(): void { /* no-op */ }
    unobserve(): void { /* no-op */ }
    disconnect(): void { /* no-op */ }
  })
  const renders: number[] = []
  const adapter = make_adapter(page_count)
  if (with_thumbs) {
    adapter.render_thumbnail = (orig): Promise<ImageBitmap> => {
      renders.push(orig)
      return Promise.resolve({ width: 40, height: 60, close: (): void => undefined } as unknown as ImageBitmap)
    }
  }
  const model = new AppModel(adapter)
  await model.load_files([new File(['%PDF'], 'a.pdf')])
  const root = mount()
  const { ctrl } = make_ctrl()
  const strip = new PageStrip(root, model, ctrl)
  strip.refresh(model)
  const show = (ps: number[]): void => {
    io_cb(ps.map(p => ({ target: root.querySelectorAll('.page-strip__item')[p]!, isIntersecting: true })))
  }
  return { model, strip, root, renders, show }
}

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 5))

describe('PageStrip (spec-web §3)', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('one numbered item per page; current and selected pages are marked', async () => {
    const { model, strip, root } = await setup(4)
    model.set_select_pattern('2-3'); model.set_pages_mode(PagesMode.SELECT)
    model.go_to_page(2)
    strip.refresh(model)
    const items = [...root.querySelectorAll('.page-strip__item')]
    expect(items.map(i => i.textContent)).toEqual(['1', '2', '3', '4'])
    expect(items.map(i => i.classList.contains('selected'))).toEqual([false, true, true, false])
    expect(items.map(i => i.classList.contains('current'))).toEqual([false, false, true, false])
  })

  it('clicking an item shows that page', async () => {
    const { model, root } = await setup(4)
    root.querySelectorAll<HTMLElement>('.page-strip__item')[3]!.click()
    expect(model.current_page).toBe(3)
  })

  it('is hidden for a single page', async () => {
    const { root } = await setup(1)
    expect(root.querySelector('.page-strip')!.classList.contains('hidden')).toBe(true)
  })

  it('renders only visible thumbnails, once, and again only when the page changes (rotate)', async () => {
    const { model, strip, renders, show } = await setup(6)
    await flush()
    expect(renders).toEqual([])                   // nothing visible yet
    show([0, 1])
    await vi.waitFor(() => { expect(renders).toEqual([0, 1]) })
    strip.refresh(model)
    await flush()
    expect(renders).toEqual([0, 1])               // a plain refresh redraws nothing
    model.set_select_pattern('2'); model.set_pages_mode(PagesMode.SELECT)
    model.rotate_pages()
    strip.refresh(model)
    await vi.waitFor(() => { expect(renders).toEqual([0, 1, 1]) })   // only the rotated page
    await flush()
    expect(renders).toEqual([0, 1, 1])
  })

  it('shows nothing without adapter thumbnail support', async () => {
    const { renders, show } = await setup(3, false)
    show([0, 1, 2])
    await flush()
    expect(renders).toEqual([])
  })
})
