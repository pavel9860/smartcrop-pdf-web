// NavBar — pinned bottom bar: Settings | Help | Undo | Redo | Reset | page nav (spec §7.8).

import type { AppModel } from '@core/model'
import type { AppController } from './app'
import { requireEl } from './dom'

export class NavBar {
  private readonly _undo_btn:  HTMLButtonElement
  private readonly _redo_btn:  HTMLButtonElement
  private readonly _reset_btn: HTMLButtonElement
  private readonly _prev_btn:  HTMLButtonElement
  private readonly _next_btn:  HTMLButtonElement
  private readonly _page_inp:  HTMLInputElement
  private readonly _total_el:  HTMLElement
  private readonly _set_btn:   HTMLButtonElement
  private readonly _help_btn:  HTMLButtonElement

  constructor(sidebar: HTMLElement, model: AppModel, ctrl: AppController) {
    const bar = document.createElement('div')
    bar.className = 'nav-bar'
    bar.innerHTML = `
      <div class="nav-bar__row nav-bar__row--top">
        <button class="btn btn-secondary nav-btn" data-id="settings">⚙ Settings</button>
        <button class="btn btn-secondary nav-btn" data-id="help">? Help</button>
      </div>
      <div class="nav-bar__row">
        <button class="btn btn-secondary flex-1" id="nav-undo">↩ Undo</button>
        <button class="btn btn-secondary flex-1" id="nav-redo">↪ Redo</button>
        <button class="btn btn-secondary flex-1" id="nav-reset">⟲ Reset</button>
      </div>
      <div class="nav-bar__row nav-bar__row--pages">
        <button class="btn btn-icon" id="nav-prev" aria-label="Previous page">&lt;</button>
        <input  class="page-input" id="nav-page" type="number" min="1" value="1" />
        <span class="page-total" id="nav-total">/ 0</span>
        <button class="btn btn-icon" id="nav-next" aria-label="Next page">&gt;</button>
      </div>`

    sidebar.appendChild(bar)

    this._undo_btn  = requireEl(bar, '#nav-undo')
    this._redo_btn  = requireEl(bar, '#nav-redo')
    this._reset_btn = requireEl(bar, '#nav-reset')
    this._prev_btn  = requireEl(bar, '#nav-prev')
    this._next_btn  = requireEl(bar, '#nav-next')
    this._page_inp  = requireEl(bar, '#nav-page')
    this._total_el  = requireEl(bar, '#nav-total')
    this._set_btn   = requireEl(bar, '[data-id="settings"]')
    this._help_btn  = requireEl(bar, '[data-id="help"]')

    this._undo_btn.addEventListener('click',
      () => { ctrl.dispatch(() => { model.undo() }) })
    this._redo_btn.addEventListener('click',
      () => { ctrl.dispatch(() => { model.redo() }) })
    this._reset_btn.addEventListener('click',
      () => { ctrl.dispatch_async(() => model.reset()) })
    this._prev_btn.addEventListener('click',
      () => { ctrl.dispatch(() => { model.prev_page() }) })
    this._next_btn.addEventListener('click',
      () => { ctrl.dispatch(() => { model.next_page() }) })
    this._page_inp.addEventListener('change', () => {
      const n = parseInt(this._page_inp.value, 10)
      if (!isNaN(n)) ctrl.dispatch(() => { model.jump_to_output_page(n) })
    })
    this._set_btn.addEventListener('click',
      () => { ctrl.toggle_detail('settings') })
    this._help_btn.addEventListener('click',
      () => { ctrl.toggle_detail('help') })
  }

  refresh(model: AppModel, busy: boolean): void {
    this._undo_btn.disabled  = busy || !model.can_undo
    this._redo_btn.disabled  = busy || !model.can_redo
    this._reset_btn.disabled = busy || !model.has_document
    this._prev_btn.disabled  = busy || model.view_position <= 1
    this._next_btn.disabled  = busy || model.view_position >= model.view_total
    this._page_inp.value     = String(model.view_position)
    this._page_inp.max       = String(model.view_total)
    this._page_inp.disabled  = busy || !model.has_document
    this._total_el.textContent = `/ ${model.view_total}`
  }
}
