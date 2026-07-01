// DetailPanel — the third column that slides in for Settings or Help (ARCHITECTURE §3.2).

import type { AppModel } from '@core/model'
import type { AppController, UIConfig } from './app'
import type { DetailPanel as DetailPanelType } from './constants'
import { SettingsView } from './settings_view'
import { HelpView } from './help_view'
import { requireEl } from './dom'

export class DetailPanel {
  private readonly _el: HTMLElement
  private readonly _settings: SettingsView
  private readonly _help:     HelpView
  private _active: DetailPanelType = null

  constructor(el: HTMLElement, model: AppModel, ctrl: AppController) {
    this._el = el
    this._el.className = 'detail-panel'

    const header = document.createElement('div')
    header.className = 'detail-panel__header'
    header.innerHTML = `
      <span class="detail-panel__title"></span>
      <button class="detail-panel__close icon-btn" title="Close">✕</button>`
    requireEl<HTMLElement>(header, '.detail-panel__close')
      .addEventListener('click', () => { ctrl.toggle_detail(this._active) })
    this._el.appendChild(header)

    const body = document.createElement('div')
    body.className = 'detail-panel__body'
    this._el.appendChild(body)

    this._settings = new SettingsView(body, model, ctrl)
    this._help     = new HelpView(body)
  }

  get active(): DetailPanelType { return this._active }

  show(panel: NonNullable<DetailPanelType>): void {
    this._active = panel
    const title = requireEl<HTMLElement>(this._el, '.detail-panel__title')
    title.textContent = panel === 'settings' ? 'Settings' : 'Help'
    this._settings.el.classList.toggle('hidden', panel !== 'settings')
    this._help.el.classList.toggle('hidden', panel !== 'help')
  }

  hide(): void {
    this._active = null
  }

  refresh(model: AppModel, ui: Readonly<UIConfig>): void {
    if (this._active === 'settings') this._settings.refresh(model, ui)
  }
}
