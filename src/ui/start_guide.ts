// Start guide (spec-web §1): three illustrated pages over the placeholder document — the whole
// workflow first (native PDF and scan branches side by side), then Split/Pages, then tips.
import { requireEl } from './dom'

const svg = (body: string): string =>
  `<svg viewBox="0 0 48 48" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

const PAGE = '<rect x="11" y="6" width="26" height="36" rx="2"/>'
const LINES = '<path d="M16 14h16M16 19h16M16 24h16M16 29h12"/>'
const ICONS = {
  open:   svg('<path d="M6 14h13l4 4h19v20H6z"/><path d="M24 34V22m-5 5 5-5 5 5" class="acc"/>'),
  pdf:    svg(`${PAGE}${LINES}`),
  scan:   svg('<path d="M11 8q13 4 26 0v32q-13 4-26 0z"/><path d="M15 16q9 3 18 0M15 22q9 3 18 0M15 28q9 3 18 0"/>'),
  dewarp: svg(`${PAGE}${LINES}<path d="M4 24h3m34 0h3" class="acc"/>`),
  filter: svg(`${PAGE}<path d="M24 6v36" class="acc"/><path d="M27 14h5M27 19h5M27 24h5" stroke-width="3"/>`),
  detect: svg(`${PAGE}${LINES}<rect x="14" y="11" width="20" height="21" stroke-dasharray="3 2" class="acc"/>`),
  crop:   svg('<path d="M14 6v28h28M6 14h28v28" class="acc"/>'),
  save:   svg('<path d="M24 8v22m-8-8 8 8 8-8" class="acc"/><path d="M8 32v8h32v-8"/>'),
  split:  svg('<rect x="5" y="8" width="38" height="30" rx="2"/><path d="M24 8v30" class="acc" stroke-dasharray="3 2"/>'),
  pages:  svg('<rect x="6" y="10" width="14" height="20" rx="1"/><rect x="17" y="14" width="14" height="20" rx="1" class="acc"/><rect x="28" y="18" width="14" height="20" rx="1"/>'),
  ratio:  svg('<rect x="8" y="12" width="32" height="24" rx="2"/><path d="M8 12l32 24" class="acc"/>'),
  undo:   svg('<path d="M14 18H30a8 8 0 0 1 0 16H18"/><path d="M19 12l-6 6 6 6" class="acc"/>'),
  keys:   svg('<rect x="5" y="14" width="38" height="20" rx="3"/><path d="M11 20h2M17 20h2M23 20h2M29 20h2M35 20h2M14 28h20" class="acc"/>'),
  gear:   svg('<circle cx="24" cy="24" r="6" class="acc"/><path d="M24 6v6M24 36v6M6 24h6M36 24h6M11 11l4 4M33 33l4 4M11 37l4-4M33 15l4-4"/>'),
  lock:   svg('<rect x="10" y="22" width="28" height="18" rx="2"/><path d="M16 22v-6a8 8 0 0 1 16 0v6" class="acc"/>'),
} as const

type Step = [keyof typeof ICONS, string, string]
const step = ([icon, title, text]: Step): string =>
  `<div class="guide-step">${ICONS[icon]}<div><b>${title}</b><span>${text}</span></div></div>`
const steps = (list: Step[]): string => list.map(step).join('')

const PAGES: readonly string[] = [
  `<h2>Crop a PDF or scan in a few clicks</h2>
   ${step(['open', '1. Open', 'Press <i>Open PDF/Image Files</i> or drop files anywhere on this window.'])}
   <div class="guide-branches">
     <div><h3>${ICONS.pdf} Normal PDF</h3>
       <p>Text and vector pages. Crops stay vector — no quality loss, small files.</p></div>
     <div><h3>${ICONS.scan} Scan or photo</h3>
       ${steps([
         ['dewarp', 'Dewarp &amp; Deskew', 'Flattens curved pages and straightens tilt.'],
         ['filter', 'B/W or Sharpen', 'Cleans the background; pick strength 1–3.'],
       ])}</div>
   </div>
   ${steps([
     ['detect', '2. Auto-detect', 'Finds the text on every page — or drag a box by hand.'],
     ['crop', '3. Crop', 'Applies the box to the selected pages. Undo any time.'],
     ['save', '4. Save', 'PDF, or JPG / PNG / TIFF in one .zip.'],
   ])}`,
  `<h2>Book spreads and page selection</h2>
   ${steps([
     ['split', 'Split each page into 2 or 4', 'Two-page scans become separate pages. Drag each window; Same size keeps them equal.'],
     ['pages', 'Pages to process', 'All, Odd, Even or Selected (e.g. <code>1-3, 7</code>) — every action applies to this set.'],
     ['ratio', 'Keep ratio &amp; anchors', 'Lock the crop shape; Anchor Left/Top align each page to its own text edge.'],
   ])}`,
  `<h2>Tips</h2>
   ${steps([
     ['undo', 'Undo / Redo', 'Crop, rotate, split, dewarp and filters are all undoable. Reset reopens the files.'],
     ['keys', 'Shortcuts', '<kbd>Ctrl+O</kbd> open · <kbd>Ctrl+Enter</kbd> crop · <kbd>Ctrl+S</kbd> save · <kbd>Ctrl+Z</kbd>/<kbd>Ctrl+Y</kbd> · arrows turn pages.'],
     ['gear', 'Settings', 'Output resolution, paper size, file-name postfix and theme.'],
     ['lock', 'Private by design', 'Everything runs in your browser — files are never uploaded.'],
   ])}`,
]

export class StartGuide {
  private readonly _el: HTMLElement
  private _page = 0
  private _closed = false

  constructor(container: HTMLElement) {
    this._el = document.createElement('div')
    this._el.className = 'start-guide'
    this._el.innerHTML = `
      <div class="guide-card">
        <button class="guide-close" data-act="close" title="Hide the guide (it stays in ? Help)" aria-label="Close">✕</button>
        <div class="guide-body"></div>
        <div class="guide-nav">
          <button class="btn btn-secondary" data-act="prev">◀ Back</button>
          <div class="guide-dots">${PAGES.map((_, i) => `<button data-page="${i}" aria-label="Page ${i + 1}"></button>`).join('')}</div>
          <button class="btn btn-secondary" data-act="next">Next ▶</button>
        </div>
      </div>`
    this._el.addEventListener('click', ev => {
      const t = (ev.target as HTMLElement).closest('button')
      if (!t) return
      const act = t.dataset['act']
      if (act === 'close') { this._closed = true; this.set_visible(false); return }
      this.show_page(act === 'prev' ? this._page - 1 : act === 'next' ? this._page + 1 : Number(t.dataset['page']))
    })
    container.appendChild(this._el)
    this.show_page(0)
  }

  show_page(n: number): void {
    this._page = Math.max(0, Math.min(PAGES.length - 1, n))
    requireEl(this._el, '.guide-body').innerHTML = PAGES[this._page] ?? ''
    requireEl<HTMLButtonElement>(this._el, '[data-act="prev"]').disabled = this._page === 0
    requireEl<HTMLButtonElement>(this._el, '[data-act="next"]').disabled = this._page === PAGES.length - 1
    this._el.querySelectorAll('.guide-dots button').forEach((b, i) => b.classList.toggle('active', i === this._page))
  }

  set_visible(on: boolean): void { this._el.classList.toggle('hidden', !on || this._closed) }
}
