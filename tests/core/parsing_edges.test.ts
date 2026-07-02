// Page-pattern parsing (spec §11) — malformed/edge inputs the happy-path suite skips.
import { describe, it, expect } from 'vitest'
import { resolve_pages } from '@core/parsing'
import { PagesMode } from '@core/enums'

const sel = (p: string, total = 10): number[] => resolve_pages(PagesMode.SELECT, total, p)

describe('resolve_pages SELECT malformed input', () => {
  it('non-numeric single tokens are ignored', () => { expect(sel('x')).toEqual([]) })
  it('out-of-range single numbers are ignored', () => { expect(sel('99')).toEqual([]) })
  it('a range with the wrong part count is skipped', () => { expect(sel('1-2-3')).toEqual([]) })
  it('a range with non-numeric ends is skipped', () => { expect(sel('foo-bar')).toEqual([]) })
  it('a slice with too many parts is skipped', () => { expect(sel('1:2:3:4')).toEqual([]) })
  it('a slice with a non-positive step is skipped', () => { expect(sel('1:9:0')).toEqual([]) })
  it('a slice with non-numeric bounds is skipped', () => { expect(sel('a:b')).toEqual([]) })
  it('blank parts are skipped, valid ones kept', () => { expect(sel(' ,,3, ')).toEqual([2]) })
  it('a full open slice ":" selects every page', () => { expect(sel(':', 4)).toEqual([0, 1, 2, 3]) })
  it('mixed valid tokens union and dedupe', () => { expect(sel('1,3-4,3')).toEqual([0, 2, 3]) })
})
