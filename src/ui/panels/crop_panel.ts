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
    // Four separate cards (desktop panels.py: Split, Detect Text Borders, Advanced, Actions).
    const split_card = document.createElement('div')
    split_card.className = 'panel-card'
    split_card.innerHTML = `
      <div class="card-header"><span class="card-title">Split Each Page Into</span></div>
      <div class="btn-group" id="cp-split">
        <button class="btn btn-seg active" data-n="1">1</button>
        <button class="btn btn-seg" data-n="2">2</button>
        <button class="btn btn-seg" data-n="4">4</button>
      </div>
      <div class="split-row hidden" id="cp-same-row">
        <span class="split-row__label">Same size</span>
        <label class="toggle-label"><input type="checkbox" id="cp-same-size" /></label>
      </div>
      <div class="split-row">
        <span class="split-row__label">Keep ratio</span>
        <label class="toggle-label"><input type="checkbox" id="cp-keep-ratio" /></label>
        <input class="ratio-input" id="cp-ratio" type="number" step="0.001" min="0.1" value="1.000" />
      </div>`
    container.appendChild(split_card)

    const detect_card = document.createElement('div')
    detect_card.className = 'panel-card'
    detect_card.innerHTML = `
      <div class="card-header"><span class="card-title">Detect Text Borders</span></div>
      <button class="btn btn-secondary w-full" id="cp-detect">✦  Auto-detect</button>
      <div class="anchor-row">
        <label class="toggle-label">
          <input type="checkbox" id="cp-anchor-l" checked /> Anchor Left
        </label>
        <label class="toggle-label">
          <input type="checkbox" id="cp-anchor-t" checked /> Anchor Top
        </label>
      </div>`
    container.appendChild(detect_card)

    const adv_card = document.createElement('div')
    adv_card.className = 'panel-card'
    adv_card.innerHTML = `
      <button class="advanced-toggle" id="cp-adv-toggle"><span class="adv-arrow">▶</span> Advanced</button>
      <div class="advanced-body hidden" id="cp-adv-body">
        <div class="offset-title">Set offsets</div>
        <div class="offset-grid">
          <label>L <input class="offset-inp" id="cp-off-l" type="number" step="0.1" value="0" /></label>
          <label>T <input class="offset-inp" id="cp-off-t" type="number" step="0.1" value="0" /></label>
          <label>R <input class="offset-inp" id="cp-off-r" type="number" step="0.1" value="0" /></label>
          <label>B <input class="offset-inp" id="cp-off-b" type="number" step="0.1" value="0" /></label>
        </div>
      </div>`
    container.appendChild(adv_card)

    const actions_card = document.createElement('div')
    actions_card.className = 'panel-card'
    actions_card.innerHTML = `
      <div class="card-header"><span class="card-title">Actions</span></div>
      <button class="btn btn-secondary w-full" id="cp-crop">✂  Crop</button>
      <div class="btn-group mt-1">
        <button class="btn btn-secondary flex-1" id="cp-rotate">↻  Rotate</button>
        <button class="btn btn-secondary flex-1" id="cp-delete">🗑︎  Delete</button>
      </div>`
    container.appendChild(actions_card)

    this._split_btns    = Array.from(split_card.querySelectorAll('[data-n]'))
    this._same_size_row = requireEl(split_card, '#cp-same-row')
    this._same_size_sw  = requireEl(split_card, '#cp-same-size')
    this._detect_btn    = requireEl(detect_card, '#cp-detect')
    this._anchor_l      = requireEl(detect_card, '#cp-anchor-l')
    this._anchor_t      = requireEl(detect_card, '#cp-anchor-t')
    this._keep_ratio_sw = requireEl(split_card, '#cp-keep-ratio')
    this._ratio_inp     = requireEl(split_card, '#cp-ratio')
    this._adv_toggle    = requireEl(adv_card, '#cp-adv-toggle')
    this._adv_body      = requireEl(adv_card, '#cp-adv-body')
    this._offset_l      = requireEl(adv_card, '#cp-off-l')
    this._offset_t      = requireEl(adv_card, '#cp-off-t')
    this._offset_r      = requireEl(adv_card, '#cp-off-r')
    this._offset_b      = requireEl(adv_card, '#cp-off-b')
    this._crop_btn      = requireEl(actions_card, '#cp-crop')
    this._rotate_btn    = requireEl(actions_card, '#cp-rotate')
    this._delete_btn    = requireEl(actions_card, '#cp-delete')

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
      const arrow = this._adv_toggle.querySelector('.adv-arrow')
      if (arrow) arrow.textContent = open ? '▼' : '▶'
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
    this._crop_btn.textContent = n > 1 ? '✂  Split & Crop' : '✂  Crop'
    this._crop_btn.disabled    = busy || !model.can_apply
    this._rotate_btn.disabled  = busy || !model.has_document
    this._delete_btn.disabled  = busy || !model.has_document
  }
}
