import { describe, it, expect, afterEach, vi } from 'vitest'
import { apply_theme, current_theme } from '@ui/theme'

function stub_matchMedia(matches: boolean): void {
  const listeners: Array<(e: MediaQueryListEvent) => void> = []
  ;(window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches, media: q, onchange: null,
    addEventListener: (_t: string, cb: (e: MediaQueryListEvent) => void) => listeners.push(cb),
    removeEventListener: () => { /* noop */ },
    addListener: () => { /* legacy */ }, removeListener: () => { /* legacy */ },
    dispatchEvent: () => true,
  })
}

describe('theme', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('apply_theme(dark) sets tokens and data-theme, and current_theme tracks it', () => {
    apply_theme('dark')
    expect(current_theme()).toBe('dark')
    expect(document.documentElement.dataset['theme']).toBe('dark')
    expect(document.documentElement.style.getPropertyValue('--bg-app')).toBe('#1e1d1b')
  })

  it('apply_theme(light) swaps the palette', () => {
    apply_theme('light')
    expect(document.documentElement.dataset['theme']).toBe('light')
    expect(document.documentElement.style.getPropertyValue('--bg-app')).toBe('#edebe5')
  })

  it('apply_theme(system) resolves via matchMedia', () => {
    stub_matchMedia(true)
    apply_theme('system')
    expect(current_theme()).toBe('system')
    expect(document.documentElement.dataset['theme']).toBe('dark')
    // switching away removes the media listener without throwing
    expect(() => { apply_theme('light') }).not.toThrow()
  })
})
