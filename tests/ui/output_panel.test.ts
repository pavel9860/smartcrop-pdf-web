import { describe, it, expect, beforeEach } from 'vitest'
import { OutputPanel } from '@ui/panels/output_panel'
import { make_model, make_ctrl, mount, assert_all_have_tooltips, type FakeController } from './harness'
import type { AppModel } from '@core/model'

describe('OutputPanel', () => {
  let model: AppModel
  let fc: FakeController
  let panel: OutputPanel
  let root: HTMLElement

  beforeEach(async () => {
    root = mount()
    model = await make_model()
    fc = make_ctrl()
    panel = new OutputPanel(root, model, fc.ctrl)
  })

  it('builds Output Quality + Export cards', () => {
    expect(root.querySelector('#op-compress')).toBeTruthy()
    expect(root.querySelector('#op-colours')).toBeTruthy()
    expect(root.querySelector('#op-export')).toBeTruthy()
    expect(root.querySelector('#op-format')).toBeTruthy()
  })

  it('refresh mirrors model settings onto the controls', () => {
    panel.refresh(model, false)
    expect(root.querySelector<HTMLSelectElement>('#op-format')!.value).toBe(model.export_format)
    expect(root.querySelector('#op-export')!.textContent).toContain(model.export_format)
  })

  it('changing colours / format dispatches through the model', () => {
    const colours = root.querySelector<HTMLSelectElement>('#op-colours')!
    colours.value = 'Grayscale'
    colours.dispatchEvent(new Event('change'))
    const fmt = root.querySelector<HTMLSelectElement>('#op-format')!
    fmt.value = fmt.options[fmt.options.length - 1]!.value
    fmt.dispatchEvent(new Event('change'))
    expect(fc.calls.filter(c => c.kind === 'dispatch').length).toBeGreaterThanOrEqual(2)
  })

  it('export button calls the shared trigger_export (dispatch_job behavior tested on AppController, app.test.ts)', () => {
    root.querySelector<HTMLButtonElement>('#op-export')!.click()
    expect(fc.calls.some(c => c.kind === 'trigger_export')).toBe(true)
  })

  it('busy disables export', () => {
    panel.refresh(model, true)
    expect(root.querySelector<HTMLButtonElement>('#op-export')!.disabled).toBe(true)
  })

  it('Custom preset reveals the DPI field and dispatches set_custom_dpi (task 15)', () => {
    const compress = root.querySelector<HTMLSelectElement>('#op-compress')!
    const dpi = root.querySelector<HTMLInputElement>('#op-custom-dpi')!
    expect(dpi.hidden).toBe(true)                 // hidden for a normal preset
    compress.value = 'Custom'
    compress.dispatchEvent(new Event('change'))
    panel.refresh(model, false)
    expect(model.compress_preset).toBe('Custom')
    expect(dpi.hidden).toBe(false)                // revealed once Custom is chosen
    dpi.value = '300'
    dpi.dispatchEvent(new Event('change'))
    expect(model.custom_dpi).toBe(300)
  })

  it('every control has a tooltip (T8, #19)', () => {
    assert_all_have_tooltips(root)
  })
})
