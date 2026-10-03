// User preferences: theme tokens (incl. following the OS scheme) and output-quality persistence
// across sessions (spec-web §4.8).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { apply_theme } from '@ui/theme'
import { load_output_prefs, save_output_prefs, type OutputPrefs } from '@ui/persist'

const root = document.documentElement
const state = (): [string | undefined, string] => [root.dataset['theme'], root.style.getPropertyValue('--bg-app')]

describe('apply_theme', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('dark and light set the data-theme and swap the palette', () => {
    apply_theme('dark')
    expect(state()).toEqual(['dark', '#1e1d1b'])
    apply_theme('light')
    expect(state()).toEqual(['light', '#edebe5'])
  })

  it('system follows the OS scheme live until another theme is picked', () => {
    const listeners = new Set<(e: { matches: boolean }) => void>()
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: (_t: string, cb: (e: { matches: boolean }) => void) => listeners.add(cb),
      removeEventListener: (_t: string, cb: (e: { matches: boolean }) => void) => listeners.delete(cb),
    }))
    apply_theme('system')
    expect(state()).toEqual(['dark', '#1e1d1b'])
    for (const cb of listeners) cb({ matches: false })
    expect(state()).toEqual(['light', '#edebe5'])
    apply_theme('dark')
    expect(listeners.size).toBe(0)
  })
})

describe('output prefs persistence', () => {
  beforeEach(() => { localStorage.clear() })

  it('round-trips saved prefs; nothing stored or corrupt JSON reads as {}', () => {
    const prefs: OutputPrefs = {
      compress_preset: 'Custom', custom_dpi: 220, output_colours: 'Grayscale', export_format: 'PNG',
      paper_size: 'Custom', custom_paper_in: 20,
    }
    expect(load_output_prefs()).toEqual({})
    save_output_prefs(prefs)
    expect(load_output_prefs()).toEqual(prefs)
    localStorage.setItem('scw.output.v1', '{not json')
    expect(load_output_prefs()).toEqual({})
  })
})
