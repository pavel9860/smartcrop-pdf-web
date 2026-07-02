import { describe, it, expect, beforeEach } from 'vitest'
import { DetailPanel } from '@ui/detail_panel'
import { make_model, make_ctrl, mount, type FakeController } from './harness'
import type { AppModel } from '@core/model'
import type { UIConfig } from '@ui/app'

const UI: Readonly<UIConfig> = {
  theme: 'dark', font_size: 14, ui_scale: 1, confirm_overwrite: true, remember_folder: true,
}

describe('DetailPanel', () => {
  let model: AppModel
  let fc: FakeController
  let panel: DetailPanel
  let root: HTMLElement

  beforeEach(async () => {
    root = mount()
    model = await make_model()
    fc = make_ctrl()
    panel = new DetailPanel(root, model, fc.ctrl)
  })

  it('starts with no active view and builds a close button', () => {
    expect(panel.active).toBeNull()
    expect(root.querySelector('.detail-panel__close')).toBeTruthy()
  })

  it('show(settings) reveals settings and hides help; show(help) swaps', () => {
    panel.show('settings')
    expect(panel.active).toBe('settings')
    expect(root.querySelector('.detail-panel__title')!.textContent).toBe('Settings')
    panel.show('help')
    expect(panel.active).toBe('help')
    expect(root.querySelector('.detail-panel__title')!.textContent).toBe('Help')
  })

  it('hide() clears the active view', () => {
    panel.show('settings')
    panel.hide()
    expect(panel.active).toBeNull()
  })

  it('close button asks the controller to toggle', () => {
    panel.show('settings')
    root.querySelector<HTMLButtonElement>('.detail-panel__close')!.click()
    expect(fc.calls.some(c => c.kind === 'toggle_detail')).toBe(true)
  })

  it('refresh only touches settings when it is the active view', () => {
    panel.show('settings')
    expect(() => { panel.refresh(model, UI) }).not.toThrow()
  })
})
