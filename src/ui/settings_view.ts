// Settings content rendered inside the detail panel (spec §15).
// Four section blocks, in spec order: Appearance, Output, Behaviour, Scan.

import type { AppModel } from '@core/model'
import type { AppController, UIConfig } from './app'
import { UNDO_DEPTH_OPTIONS, DPI_PRESETS, EXPORT_FORMATS } from '@core/constants'
import { FONT_SIZE_MIN, FONT_SIZE_MAX, ZOOM_PRESETS } from './constants'
import { requireEl } from './dom'

export class SettingsView {
  private readonly _el: HTMLElement

  // Appearance
  private readonly _theme_btns: HTMLButtonElement[]
  private readonly _font_sel:   HTMLSelectElement
  private readonly _zoom_sel:   HTMLSelectElement

  // Output
  private readonly _compress_sel: HTMLSelectElement
  private readonly _format_sel:   HTMLSelectElement
  private readonly _folder_inp:   HTMLInputElement
  private readonly _folder_pick:  HTMLButtonElement
  private readonly _postfix_inp:  HTMLInputElement

  // Behaviour
  private readonly _confirm_cb: HTMLInputElement
  private readonly _remember_cb: HTMLInputElement
  private readonly _undo_sel:  HTMLSelectElement

  // Scan
  private readonly _supersample_inp: HTMLInputElement

  constructor(container: HTMLElement, model: AppModel, ctrl: AppController) {
    this._el = document.createElement('div')
    this._el.className = 'settings-view'

    const undo_opts = UNDO_DEPTH_OPTIONS.map(n =>
      `<option value="${n}">${n}</option>`).join('')
    const font_opts = Array.from(
      { length: FONT_SIZE_MAX - FONT_SIZE_MIN + 1 }, (_, i) => FONT_SIZE_MIN + i,
    ).map(n => `<option value="${n}">${n}</option>`).join('')
    const compress_opts = Object.keys(DPI_PRESETS).map(k => `<option>${k}</option>`).join('')
    const format_opts = EXPORT_FORMATS.map(f => `<option>${f}</option>`).join('')
    const zoom_opts = ZOOM_PRESETS.map(p =>
      `<option value="${p}">${Math.round(p * 100)}%</option>`).join('')

    this._el.innerHTML = `
      <section class="settings-section">
        <h3 class="settings-section__title">Appearance</h3>
        <div class="settings-row">
          <span class="settings-label">Colour scheme</span>
          <div class="btn-group">
            <button class="btn btn-seg" data-theme="dark">Dark</button>
            <button class="btn btn-seg" data-theme="light">Light</button>
            <button class="btn btn-seg" data-theme="system">System</button>
          </div>
        </div>
        <div class="settings-row">
          <span class="settings-label">Font size</span>
          <select class="select" id="sv-font">${font_opts}</select>
        </div>
        <div class="settings-row">
          <span class="settings-label">Zoom (UI scale)</span>
          <select class="select" id="sv-zoom">${zoom_opts}</select>
        </div>
      </section>

      <section class="settings-section">
        <h3 class="settings-section__title">Output</h3>
        <div class="settings-row">
          <span class="settings-label">Compress to</span>
          <select class="select" id="sv-compress">${compress_opts}</select>
        </div>
        <div class="settings-row">
          <span class="settings-label">Default format</span>
          <select class="select" id="sv-format">${format_opts}</select>
        </div>
        <div class="settings-row">
          <span class="settings-label">Output folder</span>
          <div class="folder-row">
            <input class="text-input" id="sv-folder" type="text" placeholder="same as source" />
            <button class="btn btn-secondary" id="sv-folder-pick" title="Choose folder…">…</button>
          </div>
        </div>
        <div class="settings-row">
          <span class="settings-label">Output postfix</span>
          <input class="text-input" id="sv-postfix" type="text" />
        </div>
      </section>

      <section class="settings-section">
        <h3 class="settings-section__title">Behaviour</h3>
        <div class="settings-row">
          <span class="settings-label">Confirm before overwrite</span>
          <label class="toggle-label"><input type="checkbox" id="sv-confirm" /></label>
        </div>
        <div class="settings-row">
          <span class="settings-label">Remember last folder</span>
          <label class="toggle-label"><input type="checkbox" id="sv-remember" /></label>
        </div>
        <div class="settings-row">
          <span class="settings-label">Undo / redo depth</span>
          <select class="select" id="sv-undo">${undo_opts}</select>
        </div>
      </section>

      <section class="settings-section">
        <h3 class="settings-section__title">Scan</h3>
        <div class="settings-row">
          <span class="settings-label">Dewarp supersample</span>
          <input class="text-input" id="sv-supersample" type="number" step="0.5" min="1" max="4" />
        </div>
      </section>`

    container.appendChild(this._el)

    this._theme_btns = Array.from(this._el.querySelectorAll('[data-theme]'))
    this._font_sel   = requireEl(this._el, '#sv-font')
    this._zoom_sel   = requireEl(this._el, '#sv-zoom')

    this._compress_sel = requireEl(this._el, '#sv-compress')
    this._format_sel   = requireEl(this._el, '#sv-format')
    this._folder_inp   = requireEl(this._el, '#sv-folder')
    this._folder_pick  = requireEl(this._el, '#sv-folder-pick')
    this._postfix_inp  = requireEl(this._el, '#sv-postfix')

    this._confirm_cb  = requireEl(this._el, '#sv-confirm')
    this._remember_cb = requireEl(this._el, '#sv-remember')
    this._undo_sel    = requireEl(this._el, '#sv-undo')

    this._supersample_inp = requireEl(this._el, '#sv-supersample')

    for (const btn of this._theme_btns) {
      btn.addEventListener('click', () => { ctrl.set_theme(btn.dataset['theme'] as 'dark'|'light'|'system') })
    }
    this._font_sel.addEventListener('change', () =>
      { ctrl.set_font_size(parseInt(this._font_sel.value, 10)) })
    this._zoom_sel.addEventListener('change', () =>
      { ctrl.set_ui_scale(parseFloat(this._zoom_sel.value)) })

    // Compress preset / default format are the SAME setting as the sidebar Output Quality
    // card (spec §15: "the menu there and this one are the same setting") — both write
    // through the one AppModel setter, so either control always reflects the other.
    this._compress_sel.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_compress_preset(this._compress_sel.value) }) })
    this._format_sel.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_export_format(this._format_sel.value) }) })
    this._folder_inp.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_output_folder(this._folder_inp.value) }) })
    this._folder_pick.addEventListener('click', () => { void this._pick_folder(model, ctrl) })
    this._postfix_inp.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_output_postfix(this._postfix_inp.value) }) })

    this._confirm_cb.addEventListener('change', () =>
      { ctrl.set_confirm_overwrite(this._confirm_cb.checked) })
    this._remember_cb.addEventListener('change', () =>
      { ctrl.set_remember_folder(this._remember_cb.checked) })
    this._undo_sel.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_undo_depth(parseInt(this._undo_sel.value, 10)) }) })

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
    const nearest = ZOOM_PRESETS.reduce((a, b) =>
      Math.abs(b - ui.ui_scale) < Math.abs(a - ui.ui_scale) ? b : a)
    this._zoom_sel.value = String(nearest)

    this._compress_sel.value = model.compress_preset
    this._format_sel.value   = model.export_format
    if (document.activeElement !== this._folder_inp) this._folder_inp.value = model.output_folder
    if (document.activeElement !== this._postfix_inp) this._postfix_inp.value = model.output_postfix

    this._confirm_cb.checked  = ui.confirm_overwrite
    this._remember_cb.checked = ui.remember_folder
    this._undo_sel.value = String(model.undo_depth)

    if (document.activeElement !== this._supersample_inp) {
      this._supersample_inp.value = model.dewarp_supersample.toFixed(1)
    }
  }

  // Best-effort directory picker (File System Access API, Chromium only). Sets the display
  // folder; web export still downloads via the browser, so this does not change the export path.
  private async _pick_folder(model: AppModel, ctrl: AppController): Promise<void> {
    const picker = (window as unknown as {
      showDirectoryPicker?: () => Promise<{ name: string }>
    }).showDirectoryPicker
    if (!picker) return
    try {
      const dir = await picker()
      this._folder_inp.value = dir.name
      ctrl.dispatch(() => { model.set_output_folder(dir.name) })
    } catch { /* user cancelled the picker */ }
  }

  get el(): HTMLElement { return this._el }
}
