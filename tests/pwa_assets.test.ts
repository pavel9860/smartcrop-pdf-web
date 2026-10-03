// Icon/manifest static assets (T7). Guards two real bugs found while wiring these up:
// - the web app manifest's icon `src` values must be relative, not root-absolute — Vite copies
//   public/ files verbatim (no %BASE_URL% substitution, unlike index.html), and per the Web App
//   Manifest spec icons[].src resolves relative to the manifest's own URL; a leading "/" resolves
//   to the domain root regardless of a GitHub Pages project-page subpath base.
// - index.html's icon/manifest links must use %BASE_URL% (or another base-aware mechanism), never
//   a hardcoded absolute path, for the same subpath-deploy reason.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// vitest runs from the project root (package.json's "test" script, and every gate command in
// this repo), so process.cwd() is the repo root — not import.meta.url, which vitest's transform
// pipeline doesn't give a real file:// URL.
const ROOT = `${process.cwd()}/`

describe('PWA icon/manifest assets', () => {
  it('site.webmanifest icon src values are relative, not root-absolute', () => {
    const manifest = JSON.parse(readFileSync(`${ROOT}public/site.webmanifest`, 'utf8')) as {
      icons: { src: string }[]
    }
    expect(manifest.icons.length).toBeGreaterThan(0)
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/')).toBe(false)
    }
  })

  it('index.html references icons/manifest via %BASE_URL%, never a hardcoded absolute path', () => {
    const html = readFileSync(`${ROOT}index.html`, 'utf8')
    for (const file of [
      'favicon.svg', 'favicon-96x96.png', 'favicon.ico', 'apple-touch-icon.png', 'site.webmanifest',
    ]) {
      expect(html).toContain(`%BASE_URL%${file}`)
      expect(html).not.toContain(`href="/${file}"`)
    }
  })
})
