import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HelpView } from '@ui/help_view'
import { mount } from './harness'

describe('HelpView', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = mount()
    // jsdom has no layout engine; scrollIntoView is unimplemented.
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('renders a table of contents and section blocks', () => {
    const view = new HelpView(root)
    expect(view.el).toBeTruthy()
    const toc = root.querySelectorAll('.help-toc__item')
    expect(toc.length).toBeGreaterThan(3)
    expect(root.textContent).toContain('Open files')
  })

  it('clicking a contents entry scrolls to its section', () => {
    new HelpView(root)
    const first = root.querySelector<HTMLButtonElement>('.help-toc__item')!
    first.click()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })
})
