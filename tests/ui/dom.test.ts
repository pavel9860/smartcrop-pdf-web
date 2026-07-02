import { describe, it, expect } from 'vitest'
import { requireEl } from '@ui/dom'

describe('requireEl', () => {
  it('returns the matching element', () => {
    const root = document.createElement('div')
    root.innerHTML = '<button id="go">go</button>'
    expect(requireEl<HTMLButtonElement>(root, '#go').textContent).toBe('go')
  })

  it('throws a descriptive error when the selector matches nothing', () => {
    const root = document.createElement('div')
    expect(() => requireEl(root, '#missing')).toThrow('Element not found: #missing')
  })
})
