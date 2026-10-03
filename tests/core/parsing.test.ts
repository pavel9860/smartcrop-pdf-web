// Page-selection parsing (spec-web §11): 1-based patterns in, sorted unique 0-based indices out.
import { describe, it, expect } from 'vitest'
import { resolve_pages } from '@core/parsing'
import { PagesMode } from '@core/enums'
import { rng } from './harness'

const sel = (pattern: string, total = 20): number[] => resolve_pages(PagesMode.SELECT, total, pattern)

describe('resolve_pages', () => {
  it('ALL / ODD / EVEN count 1-based pages; an empty document resolves to nothing', () => {
    expect(resolve_pages(PagesMode.ALL, 5, '')).toEqual([0, 1, 2, 3, 4])
    expect(resolve_pages(PagesMode.ODD, 6, '')).toEqual([0, 2, 4])
    expect(resolve_pages(PagesMode.EVEN, 6, '')).toEqual([1, 3, 5])
    for (const mode of Object.values(PagesMode)) expect(resolve_pages(mode, 0, '1-5')).toEqual([])
  })

  it.each([
    ['1,3,5', 20, [0, 2, 4]],
    ['2-5', 20, [1, 2, 3, 4]],
    ['1:4', 20, [0, 1, 2, 3]],
    ['1:20:5', 20, [0, 5, 10, 15]],
    ['::2', 10, [0, 2, 4, 6, 8]],
    ['10:', 12, [9, 10, 11]],
    [':', 4, [0, 1, 2, 3]],
    ['1:4, 10:12, 15', 20, [0, 1, 2, 3, 9, 10, 11, 14]],
    ['1,999,3', 5, [0, 2]],
    ['1,1,2,1-2', 20, [0, 1]],
    [' 1 , 3 , 5 ', 20, [0, 2, 4]],
    [' ,,3, ', 20, [2]],
    ['-999999999:3', 20, [0, 1, 2]],
  ])('SELECT %j of %i pages -> %j', (pattern, total, want) => {
    expect(sel(pattern, total)).toEqual(want)
  })

  it.each(['abc', 'x', '99', '1-2-3', 'foo-bar', '1:2:3:4', '1:9:0', 'a:b', '-5'])(
    'malformed or out-of-range token %j selects nothing', pattern => {
      expect(sel(pattern, 10)).toEqual([])
    })

  it('any pattern yields sorted, unique, in-range indices (2000 seeded patterns)', () => {
    const atoms = ['', ' ', ',', '-', ':', 'x', '0', '1', '3', '7', '12', '40']
    for (let seed = 1; seed <= 2000; seed++) {
      const r = rng(seed)
      const total = Math.floor(r() * 30)
      const pattern = Array.from({ length: 1 + Math.floor(r() * 10) }, () => atoms[Math.floor(r() * atoms.length)]).join('')
      const out = sel(pattern, total)
      expect(out.every((p, i) => p >= 0 && p < total && (i === 0 || p > out[i - 1]!)), `${pattern} / ${total}`).toBe(true)
    }
  })
})
