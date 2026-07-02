import { describe, it, expect, beforeEach } from 'vitest'
import { ScanPanel } from '@ui/panels/scan_panel'
import { Mode, FilterMode } from '@core/enums'
import { make_model, make_ctrl, mount, type FakeController } from './harness'
import type { AppModel } from '@core/model'

describe('ScanPanel', () => {
  let model: AppModel
  let fc: FakeController
  let panel: ScanPanel
  let root: HTMLElement

  beforeEach(async () => {
    root = mount()
    model = await make_model({ mode: Mode.SCANNED })
    fc = make_ctrl()
    panel = new ScanPanel(root, model, fc.ctrl)
  })

  it('builds dewarp + filter + strength controls', () => {
    expect(root.querySelector('#sp-dewarp')).toBeTruthy()
    expect(root.querySelector('#sp-bw')).toBeTruthy()
    expect(root.querySelector('#sp-sharpen')).toBeTruthy()
    expect(root.querySelectorAll('[data-str]')).toHaveLength(3)
  })

  it('is visible in SCANNED mode and hidden in NORMAL mode', async () => {
    panel.refresh(model, false)
    expect(root.querySelector('.panel-card')!.classList.contains('hidden')).toBe(false)
    const normal = await make_model({ mode: Mode.NORMAL })
    panel.refresh(normal, false)
    expect(root.querySelector('.panel-card')!.classList.contains('hidden')).toBe(true)
  })

  it('dewarp / filter / strength buttons dispatch jobs', () => {
    root.querySelector<HTMLButtonElement>('#sp-dewarp')!.click()
    root.querySelector<HTMLButtonElement>('#sp-bw')!.click()
    root.querySelector<HTMLButtonElement>('[data-str="2"]')!.click()
    expect(fc.calls.filter(c => c.kind === 'dispatch_job').length).toBe(3)
  })

  it('refresh marks the active filter mode', () => {
    model.set_filter_mode(FilterMode.BW)
    panel.refresh(model, false)
    expect(root.querySelector('#sp-bw')!.classList.contains('active')).toBe(true)
  })

  it('busy disables controls', () => {
    panel.refresh(model, true)
    expect(root.querySelector<HTMLButtonElement>('#sp-dewarp')!.disabled).toBe(true)
  })
})
