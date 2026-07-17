// Progress overlay — centred card over the canvas (spec §14).
// Shown only when batch total > 1; never a separate window.

import type { BatchJob } from '@core/batch'
import { requireEl } from './dom'

export class ProgressOverlay {
  private readonly _el: HTMLElement
  private readonly _title_el: HTMLElement
  private readonly _bar_el: HTMLElement
  private readonly _counter_el: HTMLElement
  private readonly _cancel_btn: HTMLButtonElement
  private _on_cancel: (() => void) | null = null

  constructor(container: HTMLElement) {
    this._el = document.createElement('div')
    this._el.className = 'overlay hidden'
    this._el.innerHTML = `
      <div class="overlay__card">
        <div class="overlay__title"></div>
        <div class="overlay__bar-track"><div class="overlay__bar"></div></div>
        <div class="overlay__counter"></div>
        <button class="overlay__cancel btn btn-secondary">Cancel</button>
      </div>`

    this._title_el   = requireEl(this._el, '.overlay__title')
    this._bar_el     = requireEl(this._el, '.overlay__bar')
    this._counter_el = requireEl(this._el, '.overlay__counter')
    this._cancel_btn = requireEl(this._el, '.overlay__cancel')

    this._cancel_btn.addEventListener('click', () => this._on_cancel?.())
    container.appendChild(this._el)
  }

  show(job: BatchJob, on_cancel: () => void): void {
    this._on_cancel = on_cancel
    this._title_el.textContent = job.title
    this._display_total = job.display_total
    this._update(0, job.total)
    this._el.classList.remove('hidden')
  }

  update(done: number, total: number): void {
    this._update(done, total)
  }

  hide(): void {
    this._el.classList.add('hidden')
    this._on_cancel = null
  }

  // display_total is the real, user-facing count (e.g. page count) — total may be inflated
  // (image exports double it so the bar keeps moving through the encode phase) and must never
  // show as "N / 2×pages" in the counter (bug: export progress). The bar still uses the full,
  // possibly-inflated total/done so its width keeps animating smoothly through both phases.
  private _display_total = 0
  private _update(done: number, total: number): void {
    const pct = total > 0 ? (done / total) * 100 : 0
    this._bar_el.style.width = `${pct.toFixed(1)}%`
    this._counter_el.textContent = `${Math.min(done, this._display_total)} / ${this._display_total}`
  }
}
