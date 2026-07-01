// Output Quality + Export cards (spec §7.6, §7.7a). Two separate cards, matching the desktop's
// actual `_build_compress`/`_build_export` split (ui/panels.py:427-456) — the card is titled
// "Output Quality" there (not the spec prose's literal "Compress Document"); see
// ARCHITECTURE.md for the spec-text-vs-app note.

import type { AppModel } from '@core/model'
import type { AppController } from '../app'
import { DPI_PRESETS, EXPORT_FORMATS } from '@core/constants'
import { requireEl } from '../dom'

export class OutputPanel {
  private readonly _compress_sel: HTMLSelectElement
  private readonly _colours_sel:  HTMLSelectElement
  private readonly _export_btn:   HTMLButtonElement
  private readonly _format_sel:   HTMLSelectElement

  constructor(container: HTMLElement, model: AppModel, ctrl: AppController) {
    const compress_opts = Object.keys(DPI_PRESETS)
      .map(k => `<option>${k}</option>`).join('')
    const format_opts = EXPORT_FORMATS
      .map(f => `<option>${f}</option>`).join('')

    const compress_el = document.createElement('div')
    compress_el.className = 'panel-card'
    compress_el.innerHTML = `
      <div class="card-header"><span class="card-title">Output Quality</span></div>
      <select class="select w-full" id="op-compress">${compress_opts}</select>
      <select class="select w-full mt-1" id="op-colours">
        <option>Original colors</option>
        <option>Grayscale</option>
      </select>`
    container.appendChild(compress_el)

    const export_el = document.createElement('div')
    export_el.className = 'panel-card'
    export_el.innerHTML = `
      <div class="card-header"><span class="card-title">Export</span></div>
      <div class="export-row">
        <button class="btn btn-primary flex-1" id="op-export">💾  Export PDF</button>
        <select class="select export-fmt" id="op-format">${format_opts}</select>
      </div>`
    container.appendChild(export_el)

    this._compress_sel = requireEl(compress_el, '#op-compress')
    this._colours_sel  = requireEl(compress_el, '#op-colours')
    this._export_btn   = requireEl(export_el, '#op-export')
    this._format_sel   = requireEl(export_el, '#op-format')

    this._compress_sel.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_compress_preset(this._compress_sel.value) }) })
    this._colours_sel.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_output_colours(this._colours_sel.value) }) })
    this._format_sel.addEventListener('change', () => {
      ctrl.dispatch(() => { model.set_export_format(this._format_sel.value) })
    })
    this._export_btn.addEventListener('click', () => {
      const [name] = model.suggested_export_name()
      ctrl.dispatch_job(() => model.export(name))
    })
  }

  refresh(model: AppModel, busy: boolean): void {
    this._compress_sel.value = model.compress_preset
    this._colours_sel.value  = model.output_colours
    this._format_sel.value   = model.export_format
    this._export_btn.textContent = `💾  Export ${model.export_format}`
    this._compress_sel.disabled = busy
    this._colours_sel.disabled  = busy
    this._format_sel.disabled   = busy
    this._export_btn.disabled   = busy || !model.has_document
  }
}
