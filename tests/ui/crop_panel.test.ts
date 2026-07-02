import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CropPanel } from '@ui/panels/crop_panel'
import { make_model, make_ctrl, mount, type FakeController } from './harness'
import type { AppModel } from '@core/model'

describe('CropPanel', () => {
  let model: AppModel
  let fc: FakeController
  let panel: CropPanel
  let root: HTMLElement

  beforeEach(async () => {
    root = mount()
    model = await make_model()
    fc = make_ctrl()
    panel = new CropPanel(root, model, fc.ctrl)
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('builds split / detect / advanced / actions controls', () => {
    expect(root.querySelectorAll('#cp-split [data-n]')).toHaveLength(3)
    expect(root.querySelector('#cp-detect')).toBeTruthy()
    expect(root.querySelector('#cp-crop')).toBeTruthy()
    expect(root.querySelector('#cp-delete')).toBeTruthy()
    expect(root.querySelectorAll('.offset-inp')).toHaveLength(4)
  })

  it('selecting split=2 shows same-size row and relabels crop button', () => {
    root.querySelector<HTMLButtonElement>('[data-n="2"]')!.click()
    panel.refresh(model, false)
    expect(model.split_count).toBe(2)
    expect(root.querySelector('#cp-same-row')!.classList.contains('hidden')).toBe(false)
    expect(root.querySelector('#cp-crop')!.textContent).toContain('Split & Crop')
  })

  it('advanced toggle expands the offset body', () => {
    const body = root.querySelector('#cp-adv-body')!
    expect(body.classList.contains('hidden')).toBe(true)
    root.querySelector<HTMLButtonElement>('#cp-adv-toggle')!.click()
    expect(body.classList.contains('hidden')).toBe(false)
  })

  it('detect button dispatches a job', () => {
    root.querySelector<HTMLButtonElement>('#cp-detect')!.click()
    expect(fc.calls.some(c => c.kind === 'dispatch_job')).toBe(true)
  })

  it('anchor / keep-ratio / offset changes dispatch through the model', () => {
    root.querySelector<HTMLInputElement>('#cp-anchor-l')!.dispatchEvent(new Event('change'))
    root.querySelector<HTMLInputElement>('#cp-keep-ratio')!.dispatchEvent(new Event('change'))
    const off = root.querySelector<HTMLInputElement>('#cp-off-l')!
    off.value = '5'
    off.dispatchEvent(new Event('change'))
    expect(fc.calls.filter(c => c.kind === 'dispatch').length).toBeGreaterThanOrEqual(3)
  })

  it('crop / rotate dispatch; delete asks for confirmation first', () => {
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true)
    root.querySelector<HTMLButtonElement>('#cp-crop')!.click()
    root.querySelector<HTMLButtonElement>('#cp-rotate')!.click()
    root.querySelector<HTMLButtonElement>('#cp-delete')!.click()
    expect(confirm).toHaveBeenCalledOnce()
    expect(fc.calls.filter(c => c.kind === 'dispatch').length).toBeGreaterThanOrEqual(3)
  })

  it('declining the delete confirm does not dispatch', () => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(false)
    const before = fc.calls.length
    root.querySelector<HTMLButtonElement>('#cp-delete')!.click()
    expect(fc.calls.length).toBe(before)
  })

  it('busy disables the action buttons', () => {
    panel.refresh(model, true)
    expect(root.querySelector<HTMLButtonElement>('#cp-crop')!.disabled).toBe(true)
    expect(root.querySelector<HTMLButtonElement>('#cp-rotate')!.disabled).toBe(true)
  })
})
