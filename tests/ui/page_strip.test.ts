import { describe, it, expect, vi, afterEach } from 'vitest'
import { PageStrip } from '@ui/page_strip'
import { AppModel } from '@core/model'
import { PagesMode } from '@core/enums'
import { mount, make_adapter, make_ctrl, stub_canvas_apis } from './harness'

async function setup(page_count: number): Promise<{ model: AppModel; strip: PageStrip; root: HTMLElement }> {
  stub_canvas_apis()
  const model = new AppModel(make_adapter(page_count))
  await model.load_files([new File(['%PDF'], 'a.pdf')])
  const root = mount()
  const strip = new PageStrip(root, model, make_ctrl().ctrl)
  strip.refresh(model)
  return { model, strip, root }
}

describe('PageStrip (spec-web §3)', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('one numbered chip per page; current and selected pages are marked', async () => {
    const { model, strip, root } = await setup(4)
    model.set_select_pattern('2-3'); model.set_pages_mode(PagesMode.SELECT)
    model.go_to_page(2)
    strip.refresh(model)
    const items = [...root.querySelectorAll('.page-strip__item')]
    expect(items.map(i => i.textContent)).toEqual(['1', '2', '3', '4'])
    expect(items.map(i => i.classList.contains('selected'))).toEqual([false, true, true, false])
    expect(items.map(i => i.classList.contains('current'))).toEqual([false, false, true, false])
  })

  it('clicking a chip shows that page', async () => {
    const { model, root } = await setup(4)
    root.querySelectorAll<HTMLElement>('.page-strip__item')[3]!.click()
    expect(model.current_page).toBe(3)
  })

  it('follows Delete: one chip fewer', async () => {
    const { model, strip, root } = await setup(4)
    model.set_select_pattern('1'); model.set_pages_mode(PagesMode.SELECT)
    model.delete_pages()
    strip.refresh(model)
    expect(root.querySelectorAll('.page-strip__item')).toHaveLength(3)
  })

  it('is hidden for a single page', async () => {
    const { root } = await setup(1)
    expect(root.querySelector('.page-strip')!.classList.contains('hidden')).toBe(true)
  })
})
