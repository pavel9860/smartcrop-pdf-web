// Help panel content (spec-web §4.10): contents navigation, About version, current-behaviour claims.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { HelpView } from '@ui/help_view'
import { mount } from './harness'

const VERSION = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version

describe('HelpView', () => {
  afterEach(() => { delete (Element.prototype as Partial<Element>).scrollIntoView })

  it('a contents entry scrolls to its own section', () => {
    const root = mount()
    new HelpView(root)
    const scroll = vi.fn<(this: Element) => void>()
    Element.prototype.scrollIntoView = scroll
    const items = root.querySelectorAll<HTMLButtonElement>('.help-toc__item')
    expect(items.length).toBeGreaterThan(3)
    items[1]!.click()
    expect(scroll.mock.contexts.map(el => el.id)).toEqual([items[1]!.dataset['target']])
  })

  it('states current behaviour, the package.json version and both contact addresses', () => {
    const root = mount()
    new HelpView(root)
    const text = root.textContent
    for (const claim of [`version ${VERSION}`, 'Open files', 'hello@smartcroppdf.com', 'support@smartcroppdf.com']) expect(text).toContain(claim)
    for (const claim of [/\.zip/, /never.*preview|preview.*never/i, /outlier/i, /vector PDF/i]) expect(text).toMatch(claim)
    for (const stale of [/press apply/i, /tiff is not available/i]) expect(text).not.toMatch(stale)
  })
})
