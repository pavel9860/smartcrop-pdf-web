// Progress overlay and the themed confirm/alert dialogs (spec-web §11).
import { describe, it, expect } from 'vitest'
import { ProgressOverlay } from '@ui/overlay'
import { confirm_dialog, alert_dialog } from '@ui/confirm'
import type { BatchJob } from '@core/batch'
import { mount } from './harness'

const job = (title: string, total: number): BatchJob => ({ title, total }) as unknown as BatchJob
const q = (root: HTMLElement, sel: string): HTMLElement => root.querySelector<HTMLElement>(sel)!
const text = (root: HTMLElement, sel: string): string | null => root.querySelector(sel)?.textContent ?? null

describe('ProgressOverlay', () => {
  it('is hidden until a job shows; update moves bar and counter; Cancel calls back; hide re-hides', () => {
    const root = mount()
    const overlay = new ProgressOverlay(root)
    expect(q(root, '.overlay').classList.contains('hidden')).toBe(true)
    let cancelled = false
    overlay.show(job('Exporting', 4), () => { cancelled = true })
    expect([q(root, '.overlay').classList.contains('hidden'), text(root, '.overlay__title'), text(root, '.overlay__counter')])
      .toEqual([false, 'Exporting', '0 / 4'])
    overlay.update(2, 4)
    expect([text(root, '.overlay__counter'), parseFloat(q(root, '.overlay__bar').style.width)]).toEqual(['2 / 4', 50])
    q(root, '.overlay__cancel').click()
    overlay.hide()
    expect([cancelled, q(root, '.overlay').classList.contains('hidden')]).toEqual([true, true])
  })

  it('a single-page job is indeterminate; a module status has no Cancel and shows a detail line', () => {
    const root = mount()
    const overlay = new ProgressOverlay(root)
    overlay.show(job('Dewarping', 1), () => undefined)
    expect(q(root, '.overlay').classList.contains('overlay--indeterminate')).toBe(true)
    overlay.show_status('Loading image engine…')
    overlay.set_detail('Downloading dewarp model 1.0 / 8.0 MB')
    expect([text(root, '.overlay__title'), q(root, '.overlay__cancel').classList.contains('hidden'), text(root, '.overlay__detail')])
      .toEqual(['Loading image engine…', true, 'Downloading dewarp model 1.0 / 8.0 MB'])
    overlay.show(job('Exporting', 4), () => undefined)
    expect(q(root, '.overlay__cancel').classList.contains('hidden')).toBe(false)
  })
})

describe('confirm_dialog / alert_dialog', () => {
  it('confirm resolves true on its labelled button, false on Cancel, and removes itself', async () => {
    const root = mount()
    const yes = confirm_dialog(root, 'Delete selected pages?', 'Delete')
    expect([text(root, '.overlay__title'), text(root, '[data-act="confirm"]')]).toEqual(['Delete selected pages?', 'Delete'])
    q(root, '[data-act="confirm"]').click()
    expect([await yes, root.querySelector('.overlay')]).toEqual([true, null])
    const no = confirm_dialog(root, 'Sure?')
    expect(text(root, '[data-act="confirm"]')).toBe('Confirm')
    q(root, '[data-act="cancel"]').click()
    expect([await no, root.querySelector('.overlay')]).toEqual([false, null])
  })

  it('alert has a single OK, danger-styled unless info, and resolves on click', async () => {
    const root = mount()
    const danger = (variant?: 'info' | 'error'): boolean => {
      void alert_dialog(root, 'x', variant)
      const ok = q(root, '[data-act="ok"]').classList.contains('btn-danger')
      q(root, '.overlay').remove()
      return ok
    }
    expect([danger('error'), danger('info'), danger()]).toEqual([true, false, true])
    const done = alert_dialog(root, 'Cannot delete all pages.', 'info')
    expect([text(root, '.overlay__title'), root.querySelector('[data-act="cancel"]'), text(root, '[data-act="ok"]')])
      .toEqual(['Cannot delete all pages.', null, 'OK'])
    q(root, '[data-act="ok"]').click()
    await done
    expect(root.querySelector('.overlay')).toBeNull()
  })
})
