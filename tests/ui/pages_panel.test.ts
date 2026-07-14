import { describe, it, expect, beforeEach } from 'vitest'
import { PagesPanel } from '@ui/panels/pages_panel'
import { PagesMode, Mode } from '@core/enums'
import { make_model, make_ctrl, mount, assert_all_have_tooltips, type FakeController } from './harness'
import type { AppModel } from '@core/model'

describe('PagesPanel', () => {
  let model: AppModel
  let fc: FakeController
  let panel: PagesPanel
  let root: HTMLElement

  beforeEach(async () => {
    root = mount()
    model = await make_model({ mode: Mode.NORMAL })
    fc = make_ctrl()
    panel = new PagesPanel(root, model, fc.ctrl)
  })

  it('builds the Document & State + Pages cards', () => {
    expect(root.querySelector('#pp-load')).toBeTruthy()
    expect(root.querySelector('#pp-file')).toBeTruthy()
    expect(root.querySelectorAll('#pp-modes [data-mode]')).toHaveLength(4)
  })

  it('refresh reflects mode badge and marks the active pages-mode', () => {
    panel.refresh(model, false)
    expect(root.querySelector('#pp-badge')?.textContent).toBe(model.mode)
    const all = root.querySelector<HTMLButtonElement>(`[data-mode="${PagesMode.ALL}"]`)
    expect(all?.classList.contains('active')).toBe(true)
  })

  it('SELECT mode reveals the pattern row', () => {
    model.set_pages_mode(PagesMode.SELECT)
    panel.refresh(model, false)
    expect(root.querySelector('#pp-pat-row')?.classList.contains('hidden')).toBe(false)
  })

  it('clicking a pages-mode button dispatches through the model', () => {
    root.querySelector<HTMLButtonElement>(`[data-mode="${PagesMode.ODD}"]`)!.click()
    expect(fc.calls.some(c => c.kind === 'dispatch')).toBe(true)
    expect(model.pages_mode).toBe(PagesMode.ODD)
  })

  it('trigger_load() clicks the load button (opens file dialog)', () => {
    let opened = false
    root.querySelector<HTMLInputElement>('#pp-file')!.click = () => { opened = true }
    panel.trigger_load()
    expect(opened).toBe(true)
  })

  it('pattern input updates the model select pattern', () => {
    model.set_pages_mode(PagesMode.SELECT)
    panel.refresh(model, false)
    const inp = root.querySelector<HTMLInputElement>('#pp-pattern')!
    inp.value = '1,3,5-9'
    inp.dispatchEvent(new Event('input'))
    expect(model.select_pattern).toBe('1,3,5-9')
  })

  it('busy disables the load button', () => {
    panel.refresh(model, true)
    expect(root.querySelector<HTMLButtonElement>('#pp-load')!.disabled).toBe(true)
  })

  it('every control has a tooltip (T8, #19)', () => {
    // #pp-pattern already carries a static placeholder-pattern tooltip regardless of mode; reveal
    // the Selected-only pattern row first so it's actually checked rather than skipped by absence.
    model.set_pages_mode(PagesMode.SELECT)
    panel.refresh(model, false)
    assert_all_have_tooltips(root)
  })
})
