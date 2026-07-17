import { describe, it, expect, beforeEach } from 'vitest'
import { ProgressOverlay } from '@ui/overlay'
import { mount } from './harness'
import type { BatchJob } from '@core/batch'

function fake_job(title = 'Exporting', total = 4, display_total = total): BatchJob {
  return { title, total, display_total } as unknown as BatchJob
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

  it('counter shows the real display_total, not an internally-doubled total (bug: export progress showing 2x pages)', () => {
    // Image exports double `total` (render + encode phase) so the BAR keeps moving through
    // encoding, but the user-facing counter must still read the real page count.
    overlay.show(fake_job('Exporting PNG', 20, 10), () => { /* noop */ })
    expect(root.querySelector('.overlay__counter')!.textContent).toBe('0 / 10')

    overlay.update(10, 20)   // rendering finished (10 real pages) — encode phase now running
    expect(root.querySelector('.overlay__counter')!.textContent).toBe('10 / 10')
    expect(parseFloat((root.querySelector('.overlay__bar') as HTMLElement).style.width)).toBe(50)

    overlay.update(15, 20)   // encode phase advancing further — counter stays capped, not "15/10"
    expect(root.querySelector('.overlay__counter')!.textContent).toBe('10 / 10')
    expect(parseFloat((root.querySelector('.overlay__bar') as HTMLElement).style.width)).toBe(75)
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
