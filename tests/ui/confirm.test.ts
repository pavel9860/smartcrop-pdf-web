// confirm_dialog — themed replacement for window.confirm() (L1).
import { describe, it, expect } from 'vitest'
import { confirm_dialog } from '@ui/confirm'
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
