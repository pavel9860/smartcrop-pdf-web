import { describe, it, expect, beforeEach } from 'vitest'
import { SettingsView } from '@ui/settings_view'
import { make_model, make_ctrl, mount, type FakeController } from './harness'
import type { AppModel } from '@core/model'
import type { UIConfig } from '@ui/app'

const UI: Readonly<UIConfig> = {
  theme: 'light', font_size: 15, ui_scale: 1.2, remember_folder: true,
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

  it('refresh reflects UIConfig: active theme, font, zoom dropdown, checkboxes', () => {
    view.refresh(model, UI)
    expect(root.querySelector('[data-theme="light"]')!.classList.contains('active')).toBe(true)
    expect(root.querySelector<HTMLSelectElement>('#sv-font')!.value).toBe('15')
    expect(root.querySelector<HTMLSelectElement>('#sv-zoom')!.value).toBe('1.15')  // nearest to 1.2
    expect(root.querySelector<HTMLInputElement>('#sv-remember')!.checked).toBe(true)
  })

  it('does not duplicate the sidebar output-quality controls, and drops inert confirm-overwrite', () => {
    expect(root.querySelector('#sv-compress')).toBeNull()   // task 14: lives only in the sidebar
    expect(root.querySelector('#sv-format')).toBeNull()
    expect(root.querySelector('#sv-confirm')).toBeNull()    // task 13: inert control removed
  })

  it('theme buttons and the zoom dropdown call the controller', () => {
    root.querySelector<HTMLButtonElement>('[data-theme="system"]')!.click()
    const zoom = root.querySelector<HTMLSelectElement>('#sv-zoom')!
    zoom.value = '1.5'; zoom.dispatchEvent(new Event('change'))
    expect(fc.calls.some(c => c.kind === 'set_theme' && c.arg === 'system')).toBe(true)
    expect(fc.calls.some(c => c.kind === 'set_ui_scale' && c.arg === 1.5)).toBe(true)
  })

  it('font size + behaviour toggles route to the controller', () => {
    const font = root.querySelector<HTMLSelectElement>('#sv-font')!
    font.value = font.options[0]!.value
    font.dispatchEvent(new Event('change'))
    root.querySelector<HTMLInputElement>('#sv-remember')!.dispatchEvent(new Event('change'))
    expect(fc.calls.some(c => c.kind === 'set_font_size')).toBe(true)
    expect(fc.calls.some(c => c.kind === 'set_remember_folder')).toBe(true)
  })

  it('Output section has shared-state Custom DPI + Paper size (spec-web §4.8)', () => {
    view.refresh(model, UI)   // select values are only synced from the model on refresh()
    const dpi = root.querySelector<HTMLInputElement>('#sv-custom-dpi')!
    expect(dpi).toBeTruthy()
    dpi.value = '240'; dpi.dispatchEvent(new Event('change'))
    expect(model.custom_dpi).toBe(240)
    expect(model.compress_preset).toBe('Custom')   // editing the field switches the preset
    const paper = root.querySelector<HTMLSelectElement>('#sv-paper')!
    expect(paper).toBeTruthy()
    expect(paper.value).toBe('A4')
    expect(Array.from(paper.options).map(o => o.value)).toEqual(['A2', 'A3', 'A4', 'A5', 'A6', 'Custom'])
    paper.value = 'A3'; paper.dispatchEvent(new Event('change'))
    expect(model.paper_size).toBe('A3')
    view.refresh(model, UI)
    expect(dpi.value).toBe('240')                  // refresh reads back the shared state
  })

  it('paper size \'Custom\' reveals a numeric height field, like the Custom DPI field (task #6)', () => {
    const paper = root.querySelector<HTMLSelectElement>('#sv-paper')!
    const row   = root.querySelector<HTMLElement>('#sv-custom-paper-row')!
    const custom = root.querySelector<HTMLInputElement>('#sv-custom-paper')!
    // Hidden from construction (the markup's own `hidden` attribute), same as #op-custom-dpi —
    // NOT only after the first refresh(), which would still flash it visible on initial mount.
    expect(row.hidden).toBe(true)
    paper.value = 'Custom'; paper.dispatchEvent(new Event('change'))
    view.refresh(model, UI)
    expect(model.paper_size).toBe('Custom')
    expect(row.hidden).toBe(false)                 // revealed once Custom is chosen
    custom.value = '20'; custom.dispatchEvent(new Event('change'))
    expect(model.custom_paper_in).toBe(20)
  })

  it('no longer shows an Output folder control (meaningless in the browser)', () => {
    expect(root.querySelector('#sv-folder')).toBeNull()
    expect(root.querySelector('#sv-folder-pick')).toBeNull()
  })

  it('output + scan fields dispatch model setters', () => {
    const postfix = root.querySelector<HTMLInputElement>('#sv-postfix')!
    postfix.value = '_crop'; postfix.dispatchEvent(new Event('change'))
    const ss = root.querySelector<HTMLInputElement>('#sv-supersample')!
    ss.value = '2'; ss.dispatchEvent(new Event('change'))
    const undo = root.querySelector<HTMLSelectElement>('#sv-undo')!
    undo.value = undo.options[0]!.value; undo.dispatchEvent(new Event('change'))
    expect(model.output_postfix).toBe('_crop')
    expect(model.dewarp_supersample).toBeCloseTo(2)
  })

  it('outlier-tolerance dropdown offers [0,1,2,5,10] and dispatches set_detect_outlier_pages (spec-web §5, #11)', () => {
    const outlier = root.querySelector<HTMLSelectElement>('#sv-outlier')!
    expect(Array.from(outlier.options).map(o => o.value)).toEqual(['0', '1', '2', '5', '10'])
    outlier.value = '2'; outlier.dispatchEvent(new Event('change'))
    expect(model.detect_outlier_pages).toBe(2)
    view.refresh(model, UI)
    expect(outlier.value).toBe('2')
  })
})
