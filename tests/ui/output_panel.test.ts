import { describe, it, expect, beforeEach } from 'vitest'
import { OutputPanel } from '@ui/panels/output_panel'
import { make_model, make_ctrl, mount, type FakeController } from './harness'
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

  it('export button dispatches a job', () => {
    root.querySelector<HTMLButtonElement>('#op-export')!.click()
    expect(fc.calls.some(c => c.kind === 'dispatch_job')).toBe(true)
  })

  it('busy disables export', () => {
    panel.refresh(model, true)
    expect(root.querySelector<HTMLButtonElement>('#op-export')!.disabled).toBe(true)
  })
})
