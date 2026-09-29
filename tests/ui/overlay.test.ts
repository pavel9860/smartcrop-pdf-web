import { describe, it, expect, beforeEach } from 'vitest'
import { ProgressOverlay } from '@ui/overlay'
import { mount } from './harness'
import type { BatchJob } from '@core/batch'

function fake_job(title = 'Exporting', total = 4): BatchJob {
  return { title, total } as unknown as BatchJob
}

describe('ProgressOverlay', () => {
  let root: HTMLElement
  let overlay: ProgressOverlay

  beforeEach(() => {
    root = mount()
    overlay = new ProgressOverlay(root)
  })

  it('is hidden until shown', () => {
    expect(root.querySelector('.overlay')!.classList.contains('hidden')).toBe(true)
  })

  it('show() reveals the card with the job title and zeroed counter', () => {
    overlay.show(fake_job('Exporting', 4), () => { /* noop */ })
    expect(root.querySelector('.overlay')!.classList.contains('hidden')).toBe(false)
    expect(root.querySelector('.overlay__title')!.textContent).toBe('Exporting')
    expect(root.querySelector('.overlay__counter')!.textContent).toBe('0 / 4')
  })

  it('update() advances the bar and counter', () => {
    overlay.show(fake_job('Exporting', 4), () => { /* noop */ })
    overlay.update(2, 4)
    expect(root.querySelector('.overlay__counter')!.textContent).toBe('2 / 4')
    // jsdom's CSSOM re-serializes "50.0%" to "50%"; assert the numeric value, not the string.
    expect(parseFloat((root.querySelector('.overlay__bar') as HTMLElement).style.width)).toBe(50)
  })


  it('cancel button fires the supplied callback; hide() re-hides', () => {
    let cancelled = false
    overlay.show(fake_job(), () => { cancelled = true })
    root.querySelector<HTMLButtonElement>('.overlay__cancel')!.click()
    expect(cancelled).toBe(true)
    overlay.hide()
    expect(root.querySelector('.overlay')!.classList.contains('hidden')).toBe(true)
  })
})

describe('ProgressOverlay single-page and module-status modes (spec-web §11)', () => {
  it('a single-page job is indeterminate (no counter)', () => {
    const root = mount()
    const overlay = new ProgressOverlay(root)
    overlay.show(fake_job('Dewarping', 1), () => { /* noop */ })
    expect(root.querySelector('.overlay')!.classList.contains('overlay--indeterminate')).toBe(true)
  })

  it('show_status has no Cancel; set_detail writes the detail line', () => {
    const root = mount()
    const overlay = new ProgressOverlay(root)
    overlay.show_status('Loading image engine…')
    expect(root.querySelector('.overlay__title')!.textContent).toBe('Loading image engine…')
    expect(root.querySelector('.overlay__cancel')!.classList.contains('hidden')).toBe(true)
    overlay.set_detail('Downloading dewarp model 1.0 / 8.0 MB')
    expect(root.querySelector('.overlay__detail')!.textContent).toContain('1.0 / 8.0 MB')
    overlay.show(fake_job('Exporting', 4), () => { /* noop */ })
    expect(root.querySelector('.overlay__cancel')!.classList.contains('hidden')).toBe(false)
  })
})
