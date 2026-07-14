import { describe, it, expect, beforeEach } from 'vitest'
import { NavBar } from '@ui/nav_bar'
import { make_model, make_ctrl, mount, assert_all_have_tooltips, type FakeController } from './harness'
import type { AppModel } from '@core/model'

describe('NavBar', () => {
  let model: AppModel
  let fc: FakeController
  let bar: NavBar
  let root: HTMLElement

  beforeEach(async () => {
    root = mount()
    model = await make_model()
    fc = make_ctrl()
    bar = new NavBar(root, model, fc.ctrl)
  })

  it('builds settings/help + undo/redo/reset + page nav', () => {
    expect(root.querySelector('[data-id="settings"]')).toBeTruthy()
    expect(root.querySelector('[data-id="help"]')).toBeTruthy()
    for (const id of ['#nav-undo', '#nav-redo', '#nav-reset', '#nav-prev', '#nav-next', '#nav-total']) {
      expect(root.querySelector(id)).toBeTruthy()
    }
  })

  it('refresh writes the output-page total and disables prev at page 1', () => {
    bar.refresh(model, false)
    expect(root.querySelector('#nav-total')!.textContent).toBe(`/ ${model.view_total}`)
    expect(root.querySelector<HTMLButtonElement>('#nav-prev')!.disabled).toBe(true)
  })

  it('settings/help buttons toggle the detail panel', () => {
    root.querySelector<HTMLButtonElement>('[data-id="settings"]')!.click()
    root.querySelector<HTMLButtonElement>('[data-id="help"]')!.click()
    const toggles = fc.calls.filter(c => c.kind === 'toggle_detail').map(c => c.arg)
    expect(toggles).toEqual(['settings', 'help'])
  })

  it('next/prev and page input dispatch navigation', () => {
    root.querySelector<HTMLButtonElement>('#nav-next')!.click()
    const inp = root.querySelector<HTMLInputElement>('#nav-page')!
    inp.value = '2'
    inp.dispatchEvent(new Event('change'))
    expect(fc.calls.filter(c => c.kind === 'dispatch').length).toBeGreaterThanOrEqual(2)
  })

  it('busy disables reset and page input', () => {
    bar.refresh(model, true)
    expect(root.querySelector<HTMLButtonElement>('#nav-reset')!.disabled).toBe(true)
    expect(root.querySelector<HTMLInputElement>('#nav-page')!.disabled).toBe(true)
  })

  it('every control has a tooltip (T8, #19)', () => {
    assert_all_have_tooltips(root)
  })
})
