import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CropPanel } from '@ui/panels/crop_panel'
import { make_model, make_ctrl, mount, assert_all_have_tooltips, type FakeController } from './harness'
import type { AppModel } from '@core/model'
import { PagesMode } from '@core/enums'

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

  it('builds split / detect / drawn-offset / actions controls', () => {
    expect(root.querySelectorAll('#cp-split [data-n]')).toHaveLength(3)
    expect(root.querySelector('#cp-detect')).toBeTruthy()
    expect(root.querySelector('#cp-manual')).toBeFalsy()   // switch removed (spec-web §4.6)
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

  it('Auto-detect and the anchor toggles stay enabled at split=2/4 (spec §4.5/§5a)', () => {
    root.querySelector<HTMLButtonElement>('[data-n="2"]')!.click()
    panel.refresh(model, false)
    expect(root.querySelector<HTMLButtonElement>('#cp-detect')!.disabled).toBe(false)
    expect(root.querySelector<HTMLInputElement>('#cp-anchor-l')!.disabled).toBe(false)
    expect(root.querySelector<HTMLInputElement>('#cp-anchor-t')!.disabled).toBe(false)
  })

  it('the offset grid is hidden with no drawn window, and shown/populated once one exists ' +
     '(spec-web §4.6: no separate switch, appears only for a hand-drawn crop window)', () => {
    const body = root.querySelector('#cp-offset-body')!
    expect(body.classList.contains('hidden')).toBe(true)
    expect(root.querySelector<HTMLButtonElement>('#cp-detect')!.disabled).toBe(false)

    // Draw a window directly via the model (page is 200x300, harness.ts) — the mouse-gesture path
    // canvas_view.ts wires up; the panel only reacts to model.drawn_offsets, not the gesture itself.
    model.begin_drag(20, 30, 5)
    model.update_drag(180, 270)
    model.end_drag()
    panel.refresh(model, false)

    expect(model.drawn_offsets).toEqual({ left: 10, top: 10, right: 10, bottom: 10 })
    expect(body.classList.contains('hidden')).toBe(false)
    expect(root.querySelector<HTMLButtonElement>('#cp-detect')!.disabled).toBe(false)   // never gated by a drawn window

    model.cancel_drag()   // no drag in progress -> Esc/right-click semantics: drops the drawn window
    panel.refresh(model, false)
    expect(model.drawn_offsets).toBeNull()
    expect(body.classList.contains('hidden')).toBe(true)
  })

  it('detect button dispatches a job', () => {
    root.querySelector<HTMLButtonElement>('#cp-detect')!.click()
    expect(fc.calls.some(c => c.kind === 'dispatch_job')).toBe(true)
  })

  it('anchor / keep-ratio / drawn-offset field changes dispatch through the model', () => {
    root.querySelector<HTMLInputElement>('#cp-anchor-l')!.dispatchEvent(new Event('change'))
    root.querySelector<HTMLInputElement>('#cp-keep-ratio')!.dispatchEvent(new Event('change'))
    const off = root.querySelector<HTMLInputElement>('#cp-off-l')!
    off.value = '5'
    off.dispatchEvent(new Event('change'))
    expect(fc.calls.filter(c => c.kind === 'dispatch').length).toBeGreaterThanOrEqual(3)
  })

  it('crop / rotate dispatch; delete asks for confirmation first (L1: themed dialog, not window.confirm)', async () => {
    model.set_pages_mode(PagesMode.SELECT)
    model.set_select_pattern('1')   // fewer than all 3 pages — confirm path, not the all-pages alert
    fc.set_confirm_result(true)
    root.querySelector<HTMLButtonElement>('#cp-crop')!.click()
    root.querySelector<HTMLButtonElement>('#cp-rotate')!.click()
    root.querySelector<HTMLButtonElement>('#cp-delete')!.click()
    expect(fc.calls.filter(c => c.kind === 'confirm')).toHaveLength(1)
    await Promise.resolve()   // ctrl.confirm() resolves via a microtask before delete_pages dispatches
    expect(fc.calls.filter(c => c.kind === 'dispatch').length).toBeGreaterThanOrEqual(3)
  })

  it('deleting every page shows an info alert instead of the confirm dialog (bug 18)', () => {
    // Default "Pages to Process" is All, and make_model()'s default document has 3 pages.
    root.querySelector<HTMLButtonElement>('#cp-delete')!.click()
    expect(fc.calls.filter(c => c.kind === 'confirm')).toHaveLength(0)
    const alerts = fc.calls.filter(c => c.kind === 'alert')
    expect(alerts).toHaveLength(1)
    expect((alerts[0]!.arg as { variant: string }).variant).toBe('info')
  })

  it('declining the delete confirm does not dispatch', async () => {
    model.set_pages_mode(PagesMode.SELECT)
    model.set_select_pattern('1')
    fc.set_confirm_result(false)
    const before = fc.calls.filter(c => c.kind === 'dispatch').length
    root.querySelector<HTMLButtonElement>('#cp-delete')!.click()
    await Promise.resolve()
    expect(fc.calls.filter(c => c.kind === 'dispatch').length).toBe(before)
  })

  it('busy disables the action buttons', () => {
    panel.refresh(model, true)
    expect(root.querySelector<HTMLButtonElement>('#cp-crop')!.disabled).toBe(true)
    expect(root.querySelector<HTMLButtonElement>('#cp-rotate')!.disabled).toBe(true)
  })

  it('every control has a tooltip (T8, #19)', () => {
    assert_all_have_tooltips(root)
  })
})
