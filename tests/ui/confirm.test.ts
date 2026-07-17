// confirm_dialog / alert_dialog — themed replacements for window.confirm()/alert() (L1).
import { describe, it, expect } from 'vitest'
import { confirm_dialog, alert_dialog } from '@ui/confirm'
import { mount } from './harness'

describe('confirm_dialog', () => {
  it('renders the message and a labelled confirm button, resolves true on confirm', async () => {
    const root = mount()
    const p = confirm_dialog(root, 'Delete selected pages?', 'Delete')
    expect(root.querySelector('.overlay__title')!.textContent).toBe('Delete selected pages?')
    const confirm_btn = root.querySelector<HTMLButtonElement>('[data-act="confirm"]')!
    expect(confirm_btn.textContent).toBe('Delete')
    confirm_btn.click()
    expect(await p).toBe(true)
    expect(root.querySelector('.overlay')).toBeNull()   // removed after resolving
  })

  it('resolves false on cancel', async () => {
    const root = mount()
    const p = confirm_dialog(root, 'Delete selected pages?')
    root.querySelector<HTMLButtonElement>('[data-act="cancel"]')!.click()
    expect(await p).toBe(false)
    expect(root.querySelector('.overlay')).toBeNull()
  })

  it('defaults the confirm label to "Confirm"', () => {
    const root = mount()
    void confirm_dialog(root, 'Are you sure?')
    expect(root.querySelector('[data-act="confirm"]')!.textContent).toBe('Confirm')
  })
})

describe('alert_dialog', () => {
  it('renders the message with a single OK button, resolves on click (bug 18: no more toast)', async () => {
    const root = mount()
    const p = alert_dialog(root, 'Cannot delete all pages.', 'info')
    expect(root.querySelector('.overlay__title')!.textContent).toBe('Cannot delete all pages.')
    expect(root.querySelector('[data-act="cancel"]')).toBeNull()   // no second button
    const ok = root.querySelector<HTMLButtonElement>('[data-act="ok"]')!
    expect(ok.textContent).toBe('OK')
    ok.click()
    await p
    expect(root.querySelector('.overlay')).toBeNull()
  })

  it('error variant uses danger styling; info does not; defaults to error', () => {
    const root = mount()
    void alert_dialog(root, 'x', 'error')
    expect(root.querySelector('[data-act="ok"]')!.classList.contains('btn-danger')).toBe(true)
    root.querySelector('.overlay')!.remove()

    void alert_dialog(root, 'x', 'info')
    expect(root.querySelector('[data-act="ok"]')!.classList.contains('btn-danger')).toBe(false)
    root.querySelector('.overlay')!.remove()

    void alert_dialog(root, 'x')
    expect(root.querySelector('[data-act="ok"]')!.classList.contains('btn-danger')).toBe(true)
  })
})
