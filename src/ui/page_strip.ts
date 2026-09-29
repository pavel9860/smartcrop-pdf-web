// Page strip (spec-web §3): one numbered chip per source page under the canvas — the current page
// highlighted, the Pages-to-process selection outlined, click to show a page. Nothing is rendered.
import type { AppModel } from '@core/model'
import type { AppController } from './app'

export class PageStrip {
  readonly el: HTMLElement
  private readonly _items: HTMLButtonElement[] = []
  private _current = -1

  constructor(container: HTMLElement, model: AppModel, ctrl: AppController) {
    this.el = document.createElement('div')
    this.el.className = 'page-strip hidden'
    container.appendChild(this.el)
    this.el.addEventListener('click', ev => {
      const item = (ev.target as HTMLElement).closest<HTMLButtonElement>('.page-strip__item')
      if (item) ctrl.dispatch(() => { model.go_to_page(Number(item.dataset['p'])) })
    })
  }

  refresh(model: AppModel): void {
    const n = model.is_placeholder ? 0 : model.page_count()
    this.el.classList.toggle('hidden', n <= 1)
    while (this._items.length < n) {
      const item = document.createElement('button')
      item.className = 'page-strip__item'
      item.dataset['p'] = String(this._items.length)
      item.textContent = String(this._items.length + 1)
      this.el.appendChild(item)
      this._items.push(item)
    }
    while (this._items.length > n) this._items.pop()?.remove()
    const selected = new Set(model.resolve_pages())
    this._items.forEach((item, p) => {
      item.classList.toggle('current', p === model.current_page)
      item.classList.toggle('selected', selected.has(p))
    })
    if (model.current_page !== this._current) {
      this._current = model.current_page
      this._items[this._current]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }
}
