// Split + Detect Text Borders + Advanced (offsets) + Actions cards (spec §7.3, §7.4, §7.7).

import type { AppModel } from '@core/model'
import type { AppController } from '../app'
import { requireEl } from '../dom'

export class CropPanel {
  // Split
  private readonly _split_btns: HTMLButtonElement[]
  private readonly _same_size_row: HTMLElement
  private readonly _same_size_sw: HTMLInputElement
  // Detect
  private readonly _detect_btn: HTMLButtonElement
  private readonly _anchor_l: HTMLInputElement
  private readonly _anchor_t: HTMLInputElement
  private readonly _keep_ratio_sw: HTMLInputElement
  private readonly _ratio_inp: HTMLInputElement
  // Advanced
  private readonly _adv_toggle: HTMLButtonElement
  private readonly _adv_body: HTMLElement
  private readonly _offset_l: HTMLInputElement
  private readonly _offset_t: HTMLInputElement
  private readonly _offset_r: HTMLInputElement
  private readonly _offset_b: HTMLInputElement
  // Actions
  private readonly _crop_btn: HTMLButtonElement
  private readonly _rotate_btn: HTMLButtonElement
  private readonly _delete_btn: HTMLButtonElement

  constructor(container: HTMLElement, model: AppModel, ctrl: AppController) {
    const el = document.createElement('div')
    el.className = 'panel-card'
    el.innerHTML = `
      <!-- Split -->
      <div class="card-header"><span class="card-title">Split Each Page Into</span></div>
      <div class="btn-group" id="cp-split">
        <button class="btn btn-seg active" data-n="1">1</button>
        <button class="btn btn-seg" data-n="2">2</button>
        <button class="btn btn-seg" data-n="4">4</button>
      </div>
      <div class="same-size-row hidden" id="cp-same-row">
        <label class="toggle-label">
          <input type="checkbox" id="cp-same-size" />
          Same size
        </label>
      </div>
      <label class="toggle-label">
        <input type="checkbox" id="cp-keep-ratio" />
        Keep ratio
        <input class="ratio-input" id="cp-ratio" type="number" step="0.001" min="0.1" value="1.000" />
      </label>

      <!-- Detect -->
      <div class="card-header mt-2"><span class="card-title">Detect Text Borders</span></div>
      <button class="btn btn-primary w-full" id="cp-detect">✶  Auto-detect</button>
      <div class="anchor-row">
        <label class="toggle-label">
          <input type="checkbox" id="cp-anchor-l" checked /> Anchor Left
        </label>
        <label class="toggle-label">
          <input type="checkbox" id="cp-anchor-t" checked /> Anchor Top
        </label>
      </div>

      <!-- Advanced / offsets -->
      <button class="advanced-toggle" id="cp-adv-toggle">▸ Advanced</button>
      <div class="advanced-body hidden" id="cp-adv-body">
        <div class="offset-grid">
          <label>L <input class="offset-inp" id="cp-off-l" type="number" step="0.1" value="0" /></label>
          <label>T <input class="offset-inp" id="cp-off-t" type="number" step="0.1" value="0" /></label>
          <label>R <input class="offset-inp" id="cp-off-r" type="number" step="0.1" value="0" /></label>
          <label>B <input class="offset-inp" id="cp-off-b" type="number" step="0.1" value="0" /></label>
        </div>
      </div>

      <!-- Actions -->
      <div class="card-header mt-2"><span class="card-title">Actions</span></div>
      <button class="btn btn-primary w-full" id="cp-crop">✂ Crop</button>
      <div class="btn-group mt-1">
        <button class="btn btn-secondary flex-1" id="cp-rotate">↻ Rotate</button>
        <button class="btn btn-danger flex-1"    id="cp-delete">🗑 Delete</button>
      </div>`
    container.appendChild(el)

    this._split_btns    = Array.from(el.querySelectorAll('[data-n]'))
    this._same_size_row = requireEl(el, '#cp-same-row')
    this._same_size_sw  = requireEl(el, '#cp-same-size')
    this._detect_btn    = requireEl(el, '#cp-detect')
    this._anchor_l      = requireEl(el, '#cp-anchor-l')
    this._anchor_t      = requireEl(el, '#cp-anchor-t')
    this._keep_ratio_sw = requireEl(el, '#cp-keep-ratio')
    this._ratio_inp     = requireEl(el, '#cp-ratio')
    this._adv_toggle    = requireEl(el, '#cp-adv-toggle')
    this._adv_body      = requireEl(el, '#cp-adv-body')
    this._offset_l      = requireEl(el, '#cp-off-l')
    this._offset_t      = requireEl(el, '#cp-off-t')
    this._offset_r      = requireEl(el, '#cp-off-r')
    this._offset_b      = requireEl(el, '#cp-off-b')
    this._crop_btn      = requireEl(el, '#cp-crop')
    this._rotate_btn    = requireEl(el, '#cp-rotate')
    this._delete_btn    = requireEl(el, '#cp-delete')

    // Split buttons
    for (const btn of this._split_btns) {
      btn.addEventListener('click', () => {
        const n = parseInt(btn.dataset['n'] ?? '1', 10) as 1 | 2 | 4
        ctrl.dispatch(() => { model.set_split(n) })
      })
    }
    this._same_size_sw.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_same_size(this._same_size_sw.checked) }) })

    // Detect / anchors / ratio
    this._detect_btn.addEventListener('click', () =>
      { ctrl.dispatch_job(() => model.detect_content()) })
    this._anchor_l.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_anchor(this._anchor_l.checked, null) }) })
    this._anchor_t.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_anchor(null, this._anchor_t.checked) }) })
    this._keep_ratio_sw.addEventListener('change', () =>
      { ctrl.dispatch(() => { model.set_keep_ratio(this._keep_ratio_sw.checked) }) })
    this._ratio_inp.addEventListener('change', () => {
      const r = parseFloat(this._ratio_inp.value)
      if (r > 0) ctrl.dispatch(() => { model.set_keep_ratio(model.keep_ratio, r) })
    })

    // Advanced toggle
    this._adv_toggle.addEventListener('click', () => {
      const open = !this._adv_body.classList.toggle('hidden')
      this._adv_toggle.textContent = (open ? '▾' : '▸') + ' Advanced'
    })

    // Offsets (commit on blur / Enter)
    const commit_offset = (edge: 'L'|'T'|'R'|'B', inp: HTMLInputElement): () => void => () => {
      const v = parseFloat(inp.value)
      if (!isNaN(v)) {
        ctrl.dispatch(() => { model.set_offset(edge, v); model.commit_offsets() })
      }
    }
    this._offset_l.addEventListener('change', commit_offset('L', this._offset_l))
    this._offset_t.addEventListener('change', commit_offset('T', this._offset_t))
    this._offset_r.addEventListener('change', commit_offset('R', this._offset_r))
    this._offset_b.addEventListener('change', commit_offset('B', this._offset_b))

    // Actions
    this._crop_btn.addEventListener('click', () =>
      { ctrl.dispatch(() => { model.apply_crop() }) })
    this._rotate_btn.addEventListener('click', () =>
      { ctrl.dispatch(() => { model.rotate_pages() }) })
    this._delete_btn.addEventListener('click', () => {
      if (confirm('Delete selected pages?')) ctrl.dispatch(() => { model.delete_pages() })
    })
  }

  refresh(model: AppModel, busy: boolean): void {
    const n = model.split_count
    for (const btn of this._split_btns) {
      btn.classList.toggle('active', btn.dataset['n'] === String(n))
      btn.disabled = busy
    }
    this._same_size_row.classList.toggle('hidden', n === 1)
    this._same_size_sw.checked  = model.same_size
    this._same_size_sw.disabled = busy

    const detect_only = n === 1
    this._detect_btn.disabled  = busy || !model.can_detect || !detect_only
    this._anchor_l.checked     = model.anchor_left
    this._anchor_t.checked     = model.anchor_top
    this._anchor_l.disabled    = busy || !detect_only
    this._anchor_t.disabled    = busy || !detect_only
    this._keep_ratio_sw.checked  = model.keep_ratio
    this._ratio_inp.disabled     = busy
    if (document.activeElement !== this._ratio_inp) {
      this._ratio_inp.value = model.ratio.toFixed(3)
    }

    const o = model.offsets
    if (document.activeElement !== this._offset_l) this._offset_l.value = o.left.toFixed(1)
    if (document.activeElement !== this._offset_t) this._offset_t.value = o.top.toFixed(1)
    if (document.activeElement !== this._offset_r) this._offset_r.value = o.right.toFixed(1)
    if (document.activeElement !== this._offset_b) this._offset_b.value = o.bottom.toFixed(1)
    this._offset_l.disabled = this._offset_t.disabled =
    this._offset_r.disabled = this._offset_b.disabled = busy || !detect_only

    // Crop button label changes when split > 1 (spec TODO §16)
    this._crop_btn.textContent = n > 1 ? '✂ Split & Crop' : '✂ Crop'
    this._crop_btn.disabled    = busy || !model.can_apply
    this._rotate_btn.disabled  = busy || !model.has_document
    this._delete_btn.disabled  = busy || !model.has_document
  }
}
