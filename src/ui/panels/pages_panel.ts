// Document & State + Pages to Process cards (spec §7.1, §7.5).

import type { AppModel } from '@core/model'
import type { AppController } from '../app'
import { PagesMode } from '@core/enums'
import { requireEl } from '../dom'

export class PagesPanel {
  private readonly _badge: HTMLElement
  private readonly _load_btn: HTMLButtonElement
  private readonly _doc_name: HTMLElement
  private readonly _file_input: HTMLInputElement
  private readonly _mode_btns: Record<PagesMode, HTMLButtonElement>
  private readonly _pattern_row: HTMLElement
  private readonly _pattern_inp: HTMLInputElement
  private readonly _current_btn: HTMLButtonElement

  constructor(container: HTMLElement, model: AppModel, ctrl: AppController) {
    // Two separate cards (desktop panels.py: Document & State, then Pages to Process).
    const doc_card = document.createElement('div')
    doc_card.className = 'panel-card'
    doc_card.innerHTML = `
      <div class="card-header">
        <span class="card-title">Document &amp; State</span>
        <span class="mode-badge" id="pp-badge">NORMAL</span>
      </div>
      <button class="btn btn-secondary w-full" id="pp-load">📂︎  Load PDF/Image Files</button>
      <div class="doc-name hidden" id="pp-docname" title=""></div>
      <input type="file" id="pp-file" multiple accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff" hidden />`
    container.appendChild(doc_card)

    const pages_card = document.createElement('div')
    pages_card.className = 'panel-card'
    pages_card.innerHTML = `
      <div class="card-header"><span class="card-title">Pages to Process</span></div>
      <div class="btn-group" id="pp-modes">
        <button class="btn btn-seg" data-mode="${PagesMode.ALL}">All</button>
        <button class="btn btn-seg" data-mode="${PagesMode.ODD}">Odd</button>
        <button class="btn btn-seg" data-mode="${PagesMode.EVEN}">Even</button>
        <button class="btn btn-seg" data-mode="${PagesMode.SELECT}">Selected</button>
      </div>
      <div class="pattern-row hidden" id="pp-pat-row">
        <input class="text-input flex-1" id="pp-pattern" type="text"
               placeholder="1,3,5-9" title="Page pattern: 1,3, 5-9, ::2, 10:" />
        <button class="btn btn-seg" id="pp-current" title="Follow current page">Current</button>
      </div>`
    container.appendChild(pages_card)

    this._badge       = requireEl(doc_card, '#pp-badge')
    this._load_btn    = requireEl(doc_card, '#pp-load')
    this._doc_name    = requireEl(doc_card, '#pp-docname')
    this._file_input  = requireEl(doc_card, '#pp-file')
    this._pattern_row = requireEl(pages_card, '#pp-pat-row')
    this._pattern_inp = requireEl(pages_card, '#pp-pattern')
    this._current_btn = requireEl(pages_card, '#pp-current')

    this._mode_btns = {
      [PagesMode.ALL]:    requireEl(pages_card, `[data-mode="${PagesMode.ALL}"]`),
      [PagesMode.ODD]:    requireEl(pages_card, `[data-mode="${PagesMode.ODD}"]`),
      [PagesMode.EVEN]:   requireEl(pages_card, `[data-mode="${PagesMode.EVEN}"]`),
      [PagesMode.SELECT]: requireEl(pages_card, `[data-mode="${PagesMode.SELECT}"]`),
    }

    this._load_btn.addEventListener('click', () => { this._file_input.click() })
    this._file_input.addEventListener('change', () => {
      const files = Array.from(this._file_input.files ?? [])
      if (files.length) ctrl.dispatch_async(() => model.load_files(files))
      this._file_input.value = ''
    })

    for (const [mode, btn] of Object.entries(this._mode_btns)) {
      btn.addEventListener('click', () =>
        { ctrl.dispatch(() => { model.set_pages_mode(mode as PagesMode) }) })
    }

    this._pattern_inp.addEventListener('input', () =>
      { ctrl.dispatch(() => { model.set_select_pattern(this._pattern_inp.value) }) })

    this._current_btn.addEventListener('click', () =>
      { ctrl.dispatch(() => { model.set_current_follow(!model.current_follow) }) })
  }

  trigger_load(): void { this._load_btn.click() }

  refresh(model: AppModel, busy: boolean): void {
    this._badge.textContent  = model.mode
    this._badge.className    = `mode-badge mode-badge--${model.mode.toLowerCase()}`
    this._load_btn.disabled  = busy

    const name = model.document_name
    this._doc_name.textContent = name
    this._doc_name.title = name
    this._doc_name.classList.toggle('hidden', name === '')

    const mode = model.pages_mode
    for (const [m, btn] of Object.entries(this._mode_btns)) {
      btn.classList.toggle('active', (m as PagesMode) === mode)
      btn.disabled = busy
    }

    const is_select = mode === PagesMode.SELECT
    this._pattern_row.classList.toggle('hidden', !is_select)

    if (is_select) {
      if (document.activeElement !== this._pattern_inp) {
        this._pattern_inp.value = model.select_pattern
      }
      this._current_btn.classList.toggle('active', model.current_follow)
      this._current_btn.disabled = busy
      this._pattern_inp.disabled = busy
    }
  }
}
