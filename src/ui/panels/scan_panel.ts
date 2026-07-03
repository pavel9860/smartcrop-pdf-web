// Scan Processing card — shown only in SCANNED mode (spec §7.2).

import type { AppModel } from '@core/model'
import type { AppController } from '../app'
import { FilterMode, Mode } from '@core/enums'
import { requireEl } from '../dom'

export class ScanPanel {
  private readonly _el: HTMLElement
  private readonly _dewarp_btn:  HTMLButtonElement
  private readonly _bw_btn:      HTMLButtonElement
  private readonly _sharpen_btn: HTMLButtonElement
  private readonly _str_btns:    HTMLButtonElement[]

  constructor(container: HTMLElement, _model: AppModel, ctrl: AppController) {
    this._el = document.createElement('div')
    this._el.className = 'panel-card hidden'
    this._el.innerHTML = `
      <div class="card-header"><span class="card-title">Scan Processing</span></div>
      <button class="btn btn-toggle w-full" id="sp-dewarp">Dewarp &amp; Deskew</button>
      <div class="filter-group">
        <div class="filter-group__title">Filter</div>
        <div class="btn-group">
          <button class="btn btn-seg" id="sp-bw">B/W</button>
          <button class="btn btn-seg" id="sp-sharpen">Sharpen</button>
        </div>
        <div class="strength-row">
          <span class="label">Strength</span>
          <div class="btn-group">
            <button class="btn btn-seg" data-str="1">1</button>
            <button class="btn btn-seg" data-str="2">2</button>
            <button class="btn btn-seg" data-str="3">3</button>
          </div>
        </div>
      </div>`
    container.appendChild(this._el)

    this._dewarp_btn  = requireEl(this._el, '#sp-dewarp')
    this._bw_btn      = requireEl(this._el, '#sp-bw')
    this._sharpen_btn = requireEl(this._el, '#sp-sharpen')
    this._str_btns    = Array.from(this._el.querySelectorAll('[data-str]'))

    this._dewarp_btn.addEventListener('click', () => { ctrl.dispatch_job(() => _model.run_dewarp()) })
    this._bw_btn.addEventListener('click', () =>
      { ctrl.dispatch_job(() => _model.set_filter_mode(FilterMode.BW)) })
    this._sharpen_btn.addEventListener('click', () =>
      { ctrl.dispatch_job(() => _model.set_filter_mode(FilterMode.SHARPEN)) })

    for (const btn of this._str_btns) {
      btn.addEventListener('click', () => {
        const n = parseInt(btn.dataset['str'] ?? '1', 10)
        ctrl.dispatch_job(() => _model.set_filter_strength(n))
      })
    }
  }

  refresh(model: AppModel, busy: boolean): void {
    const visible = model.mode === Mode.SCANNED
    this._el.classList.toggle('hidden', !visible)
    if (!visible) return

    this._dewarp_btn.classList.toggle('active', model.dewarp_on)
    this._dewarp_btn.disabled  = busy
    this._bw_btn.classList.toggle('active', model.filter_mode === FilterMode.BW)
    this._sharpen_btn.classList.toggle('active', model.filter_mode === FilterMode.SHARPEN)
    this._bw_btn.disabled      = busy
    this._sharpen_btn.disabled = busy

    for (const btn of this._str_btns) {
      const n = parseInt(btn.dataset['str'] ?? '1', 10)
      btn.classList.toggle('active', n === model.filter_strength)
      btn.disabled = busy
    }
  }
}
