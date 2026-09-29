// Page strip (spec-web §3): one numbered thumbnail per source page under the canvas. Thumbnails
// render lazily (only when scrolled into view), one at a time, and are redrawn only when the page
// they show changes (original page or rotation); a refresh otherwise just toggles classes.
import type { AppModel } from '@core/model'
import type { AppController } from './app'
import { CONTEXT_2D_UNAVAILABLE } from '@core/errors'

export class PageStrip {
  readonly el: HTMLElement
  private readonly _items: HTMLButtonElement[] = []
  private readonly _shown: string[] = []          // thumbnail_key currently drawn per item
  private readonly _visible = new Set<number>()
  private readonly _io: IntersectionObserver
  private _rendering = false

  constructor(container: HTMLElement, private readonly _model: AppModel, ctrl: AppController) {
    this.el = document.createElement('div')
    this.el.className = 'page-strip hidden'
    container.appendChild(this.el)
    this.el.addEventListener('click', ev => {
      const item = (ev.target as HTMLElement).closest<HTMLButtonElement>('.page-strip__item')
      if (item) ctrl.dispatch(() => { this._model.go_to_page(Number(item.dataset['p'])) })
    })
    this._io = new IntersectionObserver(entries => {
      for (const e of entries) {
        const p = Number((e.target as HTMLElement).dataset['p'])
        if (e.isIntersecting) this._visible.add(p)
        else this._visible.delete(p)
      }
      void this._render_next()
    }, { root: this.el, rootMargin: '0px 200px' })
  }

  refresh(model: AppModel): void {
    const n = model.is_placeholder ? 0 : model.page_count()
    this.el.classList.toggle('hidden', n <= 1)
    while (this._items.length < n) this._add_item(this._items.length)
    while (this._items.length > n) {
      const item = this._items.pop()
      if (item) { this._io.unobserve(item); item.remove() }
      this._shown.pop()
      this._visible.delete(this._items.length)
    }
    const selected = new Set(model.resolve_pages())
    this._items.forEach((item, p) => {
      item.classList.toggle('current', p === model.current_page)
      item.classList.toggle('selected', selected.has(p))
    })
    this._items[model.current_page]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    void this._render_next()
  }

  destroy(): void { this._io.disconnect() }

  private _add_item(p: number): void {
    const item = document.createElement('button')
    item.className = 'page-strip__item'
    item.dataset['p'] = String(p)
    item.title = `Page ${p + 1}`
    item.innerHTML = `<canvas width="51" height="72"></canvas><span>${p + 1}</span>`
    this.el.appendChild(item)
    this._items.push(item)
    this._shown.push('')
    this._io.observe(item)
  }

  // Renders the first visible thumbnail that is out of date, then the next, one at a time.
  private async _render_next(): Promise<void> {
    if (this._rendering) return
    const p = [...this._visible].sort((a, b) => a - b)
      .find(i => i < this._items.length && this._shown[i] !== this._model.thumbnail_key(i))
    if (p === undefined) return
    const job = this._model.thumbnail(p)
    if (!job) return
    this._rendering = true
    const key = this._model.thumbnail_key(p)
    try {
      const bitmap = await job
      const canvas = this._items[p]?.querySelector('canvas')
      if (canvas && this._model.thumbnail_key(p) === key) {
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error(CONTEXT_2D_UNAVAILABLE)
        ctx.drawImage(bitmap, 0, 0)
        this._shown[p] = key
      }
      bitmap.close()
    } catch {
      this._shown[p] = key   // a page that cannot render keeps its blank slot instead of retrying forever
    } finally {
      this._rendering = false
    }
    setTimeout(() => { void this._render_next() }, 0)
  }
}
