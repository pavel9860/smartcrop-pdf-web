import { describe, it, expect, beforeEach } from 'vitest'
import { load_output_prefs, save_output_prefs } from '@ui/persist'

describe('output-quality persistence (task 12)', () => {
  beforeEach(() => { localStorage.clear() })

  it('round-trips saved prefs across a (simulated) session', () => {
    save_output_prefs({
      compress_preset: 'Custom', custom_dpi: 220, output_colours: 'Grayscale', export_format: 'PNG',
      paper_size: 'A4', custom_paper_in: 11.69,
    })
    expect(load_output_prefs()).toEqual({
      compress_preset: 'Custom', custom_dpi: 220, output_colours: 'Grayscale', export_format: 'PNG',
      paper_size: 'A4', custom_paper_in: 11.69,
    })
  })

  it('round-trips a custom paper size', () => {
    save_output_prefs({
      compress_preset: 'High — 300 dpi', custom_dpi: 300, output_colours: 'Original colors',
      export_format: 'PDF', paper_size: 'Custom', custom_paper_in: 20,
    })
    expect(load_output_prefs().paper_size).toBe('Custom')
    expect(load_output_prefs().custom_paper_in).toBe(20)
  })

  it('returns {} when nothing is stored', () => {
    expect(load_output_prefs()).toEqual({})
  })

  it('returns {} on corrupt JSON instead of throwing', () => {
    localStorage.setItem('scw.output.v1', '{not json')
    expect(load_output_prefs()).toEqual({})
  })
})
