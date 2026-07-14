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

  it('matches current behavior, not stale claims (T8 rewrite)', () => {
    new HelpView(root)
    const text = root.textContent
    // The commit action is labelled "Crop" in the actual UI (crop_panel.ts), never "Apply".
    expect(text).not.toMatch(/press apply/i)
    // TIFF is supported, and image exports deliver a zip, not one loose file per page.
    expect(text).not.toMatch(/tiff is not available/i)
    expect(text).toMatch(/\.zip/)
    // Output Quality is export-only — the preview is never DPI/colour-adjusted.
    expect(text).toMatch(/never.*preview|preview.*never/i)
    // Genuinely new capabilities this rewrite adds coverage for.
    expect(text).toMatch(/outlier/i)
    expect(text).toMatch(/vector PDF/i)
  })
})
