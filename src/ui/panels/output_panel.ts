// Output Quality + Export cards (spec §7.6, §7.7a). Two separate cards, matching the desktop's
// actual `_build_compress`/`_build_export` split (ui/panels.py:427-456) — the card is titled
// "Output Quality" there (not the spec prose's literal "Compress Document"); see
// ARCHITECTURE.md for the spec-text-vs-app note.

import type { AppModel } from '@core/model'
import type { AppController } from '../app'
import { Mode } from '@core/enums'
import { DPI_PRESETS, EXPORT_FORMATS, CUSTOM_DPI_PRESET, CUSTOM_DPI_MIN, CUSTOM_DPI_MAX } from '@core/constants'
import { requireEl, syncCustomReveal } from '../dom'

export class OutputPanel {
  private readonly _quality_card:   HTMLElement
  private readonly _compress_sel:   HTMLSelectElement
  private readonly _custom_dpi_inp: HTMLInputElement
  private readonly _colours_sel:    HTMLSelectElement
  private readonly _export_btn:     HTMLButtonElement
  private readonly _format_sel:     HTMLSelectElement

  constructor(container: HTMLElement, model: AppModel, ctrl: AppController) {
    const compress_opts = Object.keys(DPI_PRESETS)
      .map(k => `<option>${k}</option>`).join('')
      + `<option value="${CUSTOM_DPI_PRESET}">Custom…</option>`
    const format_opts = EXPORT_FORMATS
      .map(f => `<option>${f}</option>`).join('')

    const compress_el = document.createElement('div')
    compress_el.className = 'panel-card'
    compress_el.innerHTML = `
      <div class="card-header"><span class="card-title">Output Quality</span></div>
      <select class="select w-full" id="op-compress">${compress_opts}</select>
      <input class="text-input w-full mt-1" id="op-custom-dpi" type="number"
             min="${CUSTOM_DPI_MIN}" max="${CUSTOM_DPI_MAX}" step="10"
             title="Custom export resolution (DPI)" hidden />
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
        <button class="btn btn-secondary flex-1" id="op-export">💾︎  Export PDF</button>
        <select class="select export-fmt" id="op-format">${format_opts}</select>
      </div>`
    container.appendChild(export_el)

    this._quality_card   = compress_el
    this._compress_sel   = requireEl(compress_el, '#op-compress')
    this._custom_dpi_inp = requireEl(compress_el, '#op-custom-dpi')
    this._colours_sel    = requireEl(compress_el, '#op-colours')
    this._export_btn     = requireEl(export_el, '#op-export')
    this._format_sel     = requireEl(export_el, '#op-format')

    this._compress_sel.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_compress_preset(this._compress_sel.value) }) })
    this._custom_dpi_inp.addEventListener('change', () => {
      const v = parseInt(this._custom_dpi_inp.value, 10)
      if (!isNaN(v)) ctrl.dispatch(() => { model.set_custom_dpi(v) })
    })
    this._colours_sel.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_output_colours(this._colours_sel.value) }) })
    this._format_sel.addEventListener('change', () => {
      ctrl.dispatch(() => { model.set_export_format(this._format_sel.value) })
    })
    this._export_btn.addEventListener('click', () => {
      const name = model.suggested_export_name()
      ctrl.dispatch_job(() => model.export(name))
    })
  }

  refresh(model: AppModel, busy: boolean): void {
    // §W9.4: Output Quality only configures a rasterization step. SCANNED always rasterizes;
    // NORMAL rasterizes only for JPG/PNG/TIFF output (§W9.3) — a NORMAL+PDF export is vector,
    // nothing here applies to it.
    const show_quality = model.mode === Mode.SCANNED || model.export_format !== 'PDF'
    this._quality_card.classList.toggle('hidden', !show_quality)

    this._compress_sel.value = model.compress_preset
    syncCustomReveal(this._compress_sel, this._custom_dpi_inp, this._custom_dpi_inp,
      CUSTOM_DPI_PRESET, String(model.custom_dpi))
    this._colours_sel.value  = model.output_colours
    this._format_sel.value   = model.export_format
    this._export_btn.textContent = `💾︎  Export ${model.export_format}`
    this._compress_sel.disabled   = busy || !show_quality
    this._custom_dpi_inp.disabled = busy || !show_quality
    this._colours_sel.disabled    = busy || !show_quality
    this._format_sel.disabled     = busy
    this._export_btn.disabled     = busy || !model.has_document
  }
}
