// Architecture invariants (CLAUDE.md "Hard rules"): core/ is pure TS and the layer
// dependency direction is one-way (core/ -> pdf/ + workers/ -> ui/ -> main.ts). These
// are CI failures, not style notes, so they are asserted here rather than only in prose.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(process.cwd(), 'src') + '/'

function ts_files(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(SRC + dir, { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...ts_files(rel))
    else if (e.name.endsWith('.ts')) out.push(rel)
  }
  return out
}

function specifiers(src: string): string[] {
  const out: string[] = []
  const re = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.push(m[1] as string)
  return out
}

// Strip comments and string/template literals so identifier scans see code only.
function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\.|[^`\\])*`/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ')
}

// Match genuine DOM/Worker *global usage*, not domain identifiers that happen to be
// spelled the same (AppModel has a `document: DocumentState` field and `this.document.*`
// access — neither is the DOM global). A global read is `<global>.member`; a Worker/
// OffscreenCanvas is only ever constructed `new X(`. The lookbehind excludes member
// access (`this.document`) and identifier parts (`_document`).
const GLOBAL_ACCESS = /(?<![.\w$])(document|window|navigator|self|localStorage|sessionStorage)\s*\./
const GLOBAL_CTOR = /(?<![.\w$])(Worker|SharedWorker|OffscreenCanvas)\s*\(/

describe('core/ is pure and self-contained', () => {
  for (const f of ts_files('core')) {
    it(`${f}: imports only relative modules within core/`, () => {
      for (const s of specifiers(readFileSync(SRC + f, 'utf8'))) {
        expect(s.startsWith('./'), `${f} imports '${s}' (must be ./ within core)`).toBe(true)
      }
    })
    it(`${f}: uses no DOM/Worker globals`, () => {
      const body = strip(readFileSync(SRC + f, 'utf8'))
      expect(GLOBAL_ACCESS.test(body), `${f} accesses a DOM global`).toBe(false)
      expect(GLOBAL_CTOR.test(body), `${f} constructs a Worker/OffscreenCanvas`).toBe(false)
    })
  }
})

describe('pdf/ and workers/ never import ui/', () => {
  for (const f of [...ts_files('pdf'), ...ts_files('workers')]) {
    it(`${f}: no @ui/ or ui/ import`, () => {
      for (const s of specifiers(readFileSync(SRC + f, 'utf8'))) {
        expect(/^@ui\/|(^|\/)ui\//.test(s), `${f} imports ui via '${s}'`).toBe(false)
      }
    })
  }
})
