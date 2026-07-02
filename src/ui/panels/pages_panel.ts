// Document & State + Pages to Process cards (spec §7.1, §7.5).

import type { AppModel } from '@core/model'
import type { AppController } from '../app'
import { PagesMode } from '@core/enums'
import { requireEl } from '../dom'

export class PagesPanel {
  private readonly _badge: HTMLElement
  private readonly _load_btn: HTMLButtonElement
  private readonly _file_input: HTMLInputElement
  private readonly _mode_btns: Record<PagesMode, HTMLButtonElement>
  private readonly _pattern_row: HTMLElement
  private readonly _pattern_inp: HTMLInputElement
  private readonly _current_btn: HTMLButtonElement

  constructor(container: HTMLElement, model: AppModel, ctrl: AppController) {
    const el = document.createElement('div')
    el.className = 'panel-card'
    el.innerHTML = `
      <div class="card-header">
        <span class="card-title">Document &amp; State</span>
        <span class="mode-badge" id="pp-badge">NORMAL</span>
      </div>
      <button class="btn btn-secondary w-full" id="pp-load">⊞ Load PDF / Image Files</button>
      <input type="file" id="pp-file" multiple accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff" hidden />

      <div class="card-header mt-2"><span class="card-title">Pages to Process</span></div>
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
    container.appendChild(el)

    this._badge       = requireEl(el, '#pp-badge')
    this._load_btn    = requireEl(el, '#pp-load')
    this._file_input  = requireEl(el, '#pp-file')
    this._pattern_row = requireEl(el, '#pp-pat-row')
    this._pattern_inp = requireEl(el, '#pp-pattern')
    this._current_btn = requireEl(el, '#pp-current')

    this._mode_btns = {
      [PagesMode.ALL]:    requireEl(el, `[data-mode="${PagesMode.ALL}"]`),
      [PagesMode.ODD]:    requireEl(el, `[data-mode="${PagesMode.ODD}"]`),
      [PagesMode.EVEN]:   requireEl(el, `[data-mode="${PagesMode.EVEN}"]`),
      [PagesMode.SELECT]: requireEl(el, `[data-mode="${PagesMode.SELECT}"]`),
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
