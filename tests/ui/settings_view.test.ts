import { describe, it, expect, beforeEach } from 'vitest'
import { SettingsView } from '@ui/settings_view'
import { make_model, make_ctrl, mount, type FakeController } from './harness'
import type { AppModel } from '@core/model'
import type { UIConfig } from '@ui/app'

const UI: Readonly<UIConfig> = {
  theme: 'light', font_size: 15, ui_scale: 1.2, confirm_overwrite: false, remember_folder: true,
}

describe('SettingsView', () => {
  let model: AppModel
  let fc: FakeController
  let view: SettingsView
  let root: HTMLElement

  beforeEach(async () => {
    root = mount()
    model = await make_model()
    fc = make_ctrl()
    view = new SettingsView(root, model, fc.ctrl)
  })

  it('builds the four sections + About and exposes .el', () => {
    expect(root.querySelectorAll('.settings-section').length).toBeGreaterThanOrEqual(4)
    expect(root.querySelectorAll('[data-theme]')).toHaveLength(3)
    expect(view.el).toBeTruthy()
  })

  it('refresh reflects UIConfig: active theme, font, zoom label, checkboxes', () => {
    view.refresh(model, UI)
    expect(root.querySelector('[data-theme="light"]')!.classList.contains('active')).toBe(true)
    expect(root.querySelector<HTMLSelectElement>('#sv-font')!.value).toBe('15')
    expect(root.querySelector('#sv-zoom-label')!.textContent).toBe('120%')
    expect(root.querySelector<HTMLInputElement>('#sv-confirm')!.checked).toBe(false)
  })

  it('theme buttons and zoom controls call the controller', () => {
    root.querySelector<HTMLButtonElement>('[data-theme="system"]')!.click()
    root.querySelector<HTMLButtonElement>('#sv-zoom-in')!.click()
    root.querySelector<HTMLButtonElement>('#sv-zoom-out')!.click()
    root.querySelector<HTMLButtonElement>('#sv-zoom-rst')!.click()
    expect(fc.calls.some(c => c.kind === 'set_theme' && c.arg === 'system')).toBe(true)
    expect(fc.calls.filter(c => c.kind === 'zoom').length).toBe(3)
  })

  it('font size + behaviour toggles route to the controller', () => {
    const font = root.querySelector<HTMLSelectElement>('#sv-font')!
    font.value = font.options[0]!.value
    font.dispatchEvent(new Event('change'))
    root.querySelector<HTMLInputElement>('#sv-confirm')!.dispatchEvent(new Event('change'))
    root.querySelector<HTMLInputElement>('#sv-remember')!.dispatchEvent(new Event('change'))
    expect(fc.calls.some(c => c.kind === 'set_font_size')).toBe(true)
    expect(fc.calls.some(c => c.kind === 'set_confirm_overwrite')).toBe(true)
    expect(fc.calls.some(c => c.kind === 'set_remember_folder')).toBe(true)
  })

  it('output + scan fields dispatch model setters', () => {
    const folder = root.querySelector<HTMLInputElement>('#sv-folder')!
    folder.value = '/out'; folder.dispatchEvent(new Event('change'))
    const postfix = root.querySelector<HTMLInputElement>('#sv-postfix')!
    postfix.value = '_crop'; postfix.dispatchEvent(new Event('change'))
    const ss = root.querySelector<HTMLInputElement>('#sv-supersample')!
    ss.value = '2'; ss.dispatchEvent(new Event('change'))
    const undo = root.querySelector<HTMLSelectElement>('#sv-undo')!
    undo.value = undo.options[0]!.value; undo.dispatchEvent(new Event('change'))
    expect(model.output_folder).toBe('/out')
    expect(model.output_postfix).toBe('_crop')
    expect(model.dewarp_supersample).toBeCloseTo(2)
  })
})
