// raster.ts grid_unwarp (docuwarp stage 2) on hand-checkable grids.
import { describe, it, expect } from 'vitest'
import { grid_unwarp } from '@pdf/raster'

const src = Uint8Array.from({ length: 3 * 2 * 4 }, (_, i) => (i % 4 === 3 ? 7 : i * 10))   // 3×2 RGBA
const rgb = (a: Uint8Array): number[] => Array.from(a).filter((_, i) => i % 4 !== 3)
const alpha = (a: Uint8Array): number[] => Array.from(a).filter((_, i) => i % 4 === 3)

describe('grid_unwarp', () => {
  it('an identity grid reproduces the source, with opaque alpha', () => {
    const out = grid_unwarp(src, 3, 2, Float32Array.from([-1, 1, -1, 1, -1, -1, 1, 1]), 2, 2, 3, 2)
    expect(rgb(out)).toEqual(rgb(src))
    expect(alpha(out)).toEqual([255, 255, 255, 255, 255, 255])
  })

  it('samples outside the source read zero (GridSample zero padding)', () => {
    const out = grid_unwarp(src, 3, 2, Float32Array.from([3, 3, 3, 3, 3, 3, 3, 3]), 2, 2, 2, 2)
    expect(rgb(out)).toEqual(Array(12).fill(0))
  })

  it('a half-pixel shift interpolates bilinearly between neighbours', () => {
    const shift = 0.5 * 2 / (3 - 1)
    const out = grid_unwarp(src, 3, 2, Float32Array.from([-1 + shift, -1 + shift, -1 + shift, -1 + shift, -1, -1, -1, -1]), 2, 2, 1, 1)
    expect(Array.from(out.subarray(0, 3))).toEqual([20, 30, 40])
  })
})
