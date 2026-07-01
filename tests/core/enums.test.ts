// Enum tests (spec §4). Ported from desktop tests/test_enums.py.
import { describe, it, expect } from 'vitest'
import { Mode, FilterMode, PagesMode } from '@core/enums'
import { resolve_pages } from '@core/parsing'

describe('Mode', () => {
  it('has NORMAL and SCANNED, string-backed', () => {
    expect(Mode.NORMAL).toBe('NORMAL')
    expect(Mode.SCANNED).toBe('SCANNED')
  })
})

describe('FilterMode', () => {
  it('has NONE, BW, SHARPEN, string-backed', () => {
    expect(FilterMode.NONE).toBe('NONE')
    expect(FilterMode.BW).toBe('BW')
    expect(FilterMode.SHARPEN).toBe('SHARPEN')
  })
})

describe('PagesMode', () => {
  it('has ALL, ODD, EVEN, SELECT, string-backed', () => {
    expect(PagesMode.ALL).toBe('ALL')
    expect(PagesMode.ODD).toBe('ODD')
    expect(PagesMode.EVEN).toBe('EVEN')
    expect(PagesMode.SELECT).toBe('SELECT')
  })
  it('the pure parser (resolve_pages) accepts a PagesMode value directly, no boundary conversion', () => {
    expect(resolve_pages(PagesMode.ALL, 3, '')).toEqual([0, 1, 2])
  })
})
