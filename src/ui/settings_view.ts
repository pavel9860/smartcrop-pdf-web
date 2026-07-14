// Settings content rendered inside the detail panel (spec §15).
// Four section blocks, in spec order: Appearance, Output, Behaviour, Scan.

import type { AppModel } from '@core/model'
import type { AppController, UIConfig } from './app'
import {
  UNDO_DEPTH_OPTIONS, PAPER_SIZES, CUSTOM_DPI_PRESET, CUSTOM_DPI_MIN, CUSTOM_DPI_MAX,
  CUSTOM_PAPER_PRESET, CUSTOM_PAPER_MIN, CUSTOM_PAPER_MAX, DETECT_OUTLIER_OPTIONS,
} from '@core/constants'
import { FONT_SIZE_PRESETS, ZOOM_PRESETS, THEMES } from './constants'
import { requireEl, syncCustomReveal } from './dom'

export class SettingsView {
  private readonly _el: HTMLElement

  // Appearance
  private readonly _theme_btns: HTMLButtonElement[]
  private readonly _font_sel:   HTMLSelectElement
  private readonly _zoom_sel:   HTMLSelectElement

  // Output
  private readonly _postfix_inp:  HTMLInputElement
  private readonly _custom_dpi_inp: HTMLInputElement
  private readonly _paper_sel:      HTMLSelectElement
  private readonly _custom_paper_row: HTMLElement
  private readonly _custom_paper_inp: HTMLInputElement

  // Behaviour
  private readonly _remember_cb: HTMLInputElement
  private readonly _undo_sel:  HTMLSelectElement
  private readonly _outlier_sel: HTMLSelectElement

  // Scan
  private readonly _supersample_inp: HTMLInputElement

  constructor(container: HTMLElement, model: AppModel, ctrl: AppController) {
    this._el = document.createElement('div')
    this._el.className = 'settings-view'

    const undo_opts = UNDO_DEPTH_OPTIONS.map(n =>
      `<option value="${n}">${n}</option>`).join('')
    const outlier_opts = DETECT_OUTLIER_OPTIONS.map(n =>
      `<option value="${n}">${n === 0 ? 'Off (use largest)' : n}</option>`).join('')
    const font_opts = FONT_SIZE_PRESETS.map(n => `<option value="${n}">${n}</option>`).join('')
    const zoom_opts = ZOOM_PRESETS.map(p =>
      `<option value="${p}">${Math.round(p * 100)}%</option>`).join('')
    const paper_opts = Object.keys(PAPER_SIZES).map(n =>
      `<option value="${n}">${n}</option>`).join('')
      + `<option value="${CUSTOM_PAPER_PRESET}">Custom…</option>`
    // L3: generated from THEMES (ui/constants.ts), not three hand-duplicated buttons — adding a
    // theme only ever means updating that one array.
    const theme_btns = THEMES.map(t =>
      `<button class="btn btn-seg" data-theme="${t}" title="${t.charAt(0).toUpperCase()}${t.slice(1)} colour scheme">${t.charAt(0).toUpperCase()}${t.slice(1)}</button>`)
      .join('')

    this._el.innerHTML = `
      <section class="settings-section">
        <h3 class="settings-section__title">Appearance</h3>
        <div class="settings-row">
          <span class="settings-label">Colour scheme</span>
          <div class="btn-group">${theme_btns}</div>
        </div>
        <div class="settings-row">
          <span class="settings-label">Font size</span>
          <select class="select" id="sv-font" title="UI text size">${font_opts}</select>
        </div>
        <div class="settings-row">
          <span class="settings-label">Zoom (UI scale)</span>
          <select class="select" id="sv-zoom" title="Scale the whole UI (Ctrl +/-, Ctrl 0 to reset)">${zoom_opts}</select>
        </div>
      </section>

      <section class="settings-section">
        <h3 class="settings-section__title">Output</h3>
        <div class="settings-row">
          <span class="settings-label">Output postfix</span>
          <input class="text-input" id="sv-postfix" type="text" title="Appended to the file name before the extension on export" />
        </div>
        <div class="settings-row">
          <span class="settings-label">Custom DPI</span>
          <input class="text-input" id="sv-custom-dpi" type="number"
                 min="${CUSTOM_DPI_MIN}" max="${CUSTOM_DPI_MAX}" step="1"
                 title="Export resolution when the compress preset is Custom — shared with the sidebar Output Quality card" />
        </div>
        <div class="settings-row">
          <span class="settings-label">Paper size</span>
          <select class="select" id="sv-paper" title="Export sizing base: output long side = DPI × this paper's height">${paper_opts}</select>
        </div>
        <div class="settings-row" id="sv-custom-paper-row" hidden>
          <span class="settings-label">Custom height (in)</span>
          <input class="text-input" id="sv-custom-paper" type="number"
                 min="${CUSTOM_PAPER_MIN}" max="${CUSTOM_PAPER_MAX}" step="0.1"
                 title="Paper height in inches, used when Paper size is Custom" />
        </div>
      </section>

      <section class="settings-section">
        <h3 class="settings-section__title">Behaviour</h3>
        <div class="settings-row">
          <span class="settings-label">Remember last folder</span>
          <label class="toggle-label"><input type="checkbox" id="sv-remember" title="Remember the last-used folder between sessions" /></label>
        </div>
        <div class="settings-row">
          <span class="settings-label">Undo / redo depth</span>
          <select class="select" id="sv-undo" title="How many steps of history are kept">${undo_opts}</select>
        </div>
        <div class="settings-row">
          <span class="settings-label" title="When sizing the shared auto-crop, ignore the N pages with the largest detected content; Off = use the largest">Ignore N outlier pages</span>
          <select class="select" id="sv-outlier"
                  title="When sizing the shared auto-crop, ignore the N pages with the largest detected content; Off = use the largest">${outlier_opts}</select>
        </div>
      </section>

      <section class="settings-section">
        <h3 class="settings-section__title">Scan</h3>
        <div class="settings-row">
          <span class="settings-label">Dewarp supersample</span>
          <input class="text-input" id="sv-supersample" type="number" step="0.5" min="1" max="4"
                 title="Renders larger before straightening, trading time for a sharper result — 1.0 = off" />
        </div>
      </section>`

    container.appendChild(this._el)

    this._theme_btns = Array.from(this._el.querySelectorAll('[data-theme]'))
    this._font_sel   = requireEl(this._el, '#sv-font')
    this._zoom_sel   = requireEl(this._el, '#sv-zoom')

    this._postfix_inp  = requireEl(this._el, '#sv-postfix')
    this._custom_dpi_inp = requireEl(this._el, '#sv-custom-dpi')
    this._paper_sel      = requireEl(this._el, '#sv-paper')
    this._custom_paper_row = requireEl(this._el, '#sv-custom-paper-row')
    this._custom_paper_inp = requireEl(this._el, '#sv-custom-paper')

    this._remember_cb = requireEl(this._el, '#sv-remember')
    this._undo_sel    = requireEl(this._el, '#sv-undo')
    this._outlier_sel = requireEl(this._el, '#sv-outlier')

    this._supersample_inp = requireEl(this._el, '#sv-supersample')

    for (const btn of this._theme_btns) {
      btn.addEventListener('click', () => { ctrl.set_theme(btn.dataset['theme'] as 'dark'|'light'|'system') })
    }
    this._font_sel.addEventListener('change', () =>
      { ctrl.set_font_size(parseInt(this._font_sel.value, 10)) })
    this._zoom_sel.addEventListener('change', () =>
      { ctrl.set_ui_scale(parseFloat(this._zoom_sel.value)) })

    // Output quality (compress preset / colour / format) lives in the sidebar Output Quality
    // card; this section adds two shared-state fields (spec-web §W3): Custom DPI (same
    // settings.custom_dpi as the sidebar field — editing it switches the preset to Custom)
    // and Paper size (the export sizing base, §W2 row 8).
    this._postfix_inp.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_output_postfix(this._postfix_inp.value) }) })
    this._custom_dpi_inp.addEventListener('change', () => {
      const v = parseInt(this._custom_dpi_inp.value, 10)
      if (!isNaN(v)) {
        ctrl.dispatch(() => {
          model.set_custom_dpi(v)
          model.set_compress_preset(CUSTOM_DPI_PRESET)
        })
      }
    })
    this._paper_sel.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_paper_size(this._paper_sel.value) }) })
    this._custom_paper_inp.addEventListener('change', () => {
      const v = parseFloat(this._custom_paper_inp.value)
      if (!isNaN(v)) ctrl.dispatch(() => { model.set_custom_paper_in(v) })
    })

    this._remember_cb.addEventListener('change', () =>
      { ctrl.set_remember_folder(this._remember_cb.checked) })
    this._undo_sel.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_undo_depth(parseInt(this._undo_sel.value, 10)) }) })
    this._outlier_sel.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_detect_outlier_pages(parseInt(this._outlier_sel.value, 10)) }) })

    this._supersample_inp.addEventListener('change', () => {
      const v = parseFloat(this._supersample_inp.value)
      if (!isNaN(v)) ctrl.dispatch(() => { model.set_dewarp_supersample(v) })
    })
  }

  refresh(model: AppModel, ui: Readonly<UIConfig>): void {
    for (const btn of this._theme_btns) {
      btn.classList.toggle('active', btn.dataset['theme'] === ui.theme)
    }
    this._font_sel.value = String(ui.font_size)
    // ui_scale is always an exact ZOOM_PRESETS value by construction — both this dropdown and
    // Ctrl +/- keyboard stepping only ever set one (M1: display always equals live state, never
    // an approximated "nearest" preset).
    this._zoom_sel.value = String(ui.ui_scale)

    if (document.activeElement !== this._postfix_inp) this._postfix_inp.value = model.output_postfix
    if (document.activeElement !== this._custom_dpi_inp) {
      this._custom_dpi_inp.value = String(model.custom_dpi)
    }
    this._paper_sel.value = model.paper_size
    syncCustomReveal(this._paper_sel, this._custom_paper_row, this._custom_paper_inp,
      CUSTOM_PAPER_PRESET, String(model.custom_paper_in))

    this._remember_cb.checked = ui.remember_folder
    this._undo_sel.value = String(model.undo_depth)
    this._outlier_sel.value = String(model.detect_outlier_pages)

    if (document.activeElement !== this._supersample_inp) {
      this._supersample_inp.value = model.dewarp_supersample.toFixed(1)
    }
  }

  get el(): HTMLElement { return this._el }
}
