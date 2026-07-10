// AppController — owns AppModel, drives BatchJobs, single error-catch site (ARCHITECTURE §6).
// Wires the three-column layout (sidebar | detail panel | canvas).

import { AppModel } from '@core/model'
import type { BatchJob } from '@core/batch'
import { Failed } from '@core/batch'
import { PdfRendererAdapter } from '@pdf/loader'
import { CanvasView } from './canvas_view'
import { ProgressOverlay } from './overlay'
import { PagesPanel } from './panels/pages_panel'
import { CropPanel } from './panels/crop_panel'
import { ScanPanel } from './panels/scan_panel'
import { OutputPanel } from './panels/output_panel'
import { NavBar } from './nav_bar'
import { DetailPanel } from './detail_panel'
import { apply_theme } from './theme'
import type { DetailPanel as DetailPanelType } from './constants'
import { FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_DEFAULT, UI_SCALE_MIN, UI_SCALE_MAX } from './constants'
import { requireEl } from './dom'
import { load_output_prefs, save_output_prefs } from './persist'

// UIConfig — presentation-only state that drives NO domain computation (ARCHITECTURE §10);
// owned here, invisible to core/. theme/font_size/ui_scale/remember_folder.
export interface UIConfig {
  theme: 'dark' | 'light' | 'system'
  font_size: number
  ui_scale: number
  remember_folder: boolean
}

export class AppController {
  private readonly _model: AppModel
  private readonly _adapter: PdfRendererAdapter
  private _current_job: BatchJob | null = null

  // Layout elements
  private readonly _root: HTMLElement
  private readonly _sidebar: HTMLElement
  private readonly _detail_col: HTMLElement
  private readonly _canvas_col: HTMLElement

  // UI components
  private readonly _canvas_view: CanvasView
  private readonly _overlay: ProgressOverlay
  private readonly _drop_zone: HTMLElement
  private readonly _pages_panel: PagesPanel
  private readonly _crop_panel: CropPanel
  private readonly _scan_panel: ScanPanel
  private readonly _output_panel: OutputPanel
  private readonly _nav_bar: NavBar
  private readonly _detail_panel: DetailPanel

  constructor(root: HTMLElement) {
    this._root    = root
    this._adapter = new PdfRendererAdapter()
    this._model   = new AppModel(this._adapter)
    this._restore_output_prefs()   // apply persisted output-quality settings before first render

    // Wire download handlers
    this._model.set_download_handlers(
      (bytes, name) => { this._download_blob(new Blob([bytes as BlobPart], { type: 'application/pdf' }), name) },
      (bytes, base) => { this._download_blob(new Blob([bytes as BlobPart], { type: 'application/zip' }), `${base}.zip`) },
    )

    // Build layout
    root.innerHTML = `
      <div class="sidebar"></div>
      <div></div>
      <div class="canvas-area"></div>`

    this._sidebar    = requireEl(root, '.sidebar')
    this._detail_col = root.children[1] as HTMLElement
    this._canvas_col = requireEl(root, '.canvas-area')

    // Canvas + overlay
    this._canvas_view = new CanvasView(this._model)
    this._canvas_col.appendChild(this._canvas_view.el)
    this._overlay = new ProgressOverlay(this._canvas_col)

    // Drop zone (empty-state hint + drag-and-drop file load)
    this._drop_zone = document.createElement('div')
    this._drop_zone.className = 'drop-zone'
    this._drop_zone.innerHTML = `
      <div class="drop-zone__icon">⊞</div>
      <div>Drop PDF or image files here</div>`
    this._canvas_col.appendChild(this._drop_zone)
    this._wire_drop_zone()

    // Panels inside sidebar scroll area
    const scroll = document.createElement('div')
    scroll.className = 'sidebar-scroll'
    this._sidebar.appendChild(scroll)

    this._pages_panel  = new PagesPanel(scroll, this._model, this)
    this._scan_panel   = new ScanPanel(scroll, this._model, this)
    this._crop_panel   = new CropPanel(scroll, this._model, this)
    this._output_panel = new OutputPanel(scroll, this._model, this)

    // Pinned nav bar
    this._nav_bar = new NavBar(this._sidebar, this._model, this)

    // Detail panel (settings / help)
    this._detail_panel = new DetailPanel(this._detail_col, this._model, this)

    // Canvas repaint loop
    this._canvas_view.set_on_change(() => void this._refresh_async())

    // Global keyboard shortcuts (spec §21)
    window.addEventListener('keydown', this._on_shortcut)

    // Start with synthetic placeholder document (frozen spec §1: shown when no file is
    // open). load_files([]) with no prior files yields the SYNTH_PAGES-page demo doc; the
    // prior code only called _refresh_async(), leaving has_document false and view_total 0.
    apply_theme('dark')
    this.dispatch_async(() => this._model.load_files([]))
  }

  // ---------------------------------------------------------------------------
  // Command dispatch — the ONLY error catch sites (ARCHITECTURE §6)
  // ---------------------------------------------------------------------------

  dispatch(command: () => void): void {
    try {
      command()
    } catch (e) {
      this._show_error(e)
    }
    this._persist_output_prefs()
    void this._refresh_async()
  }

  dispatch_async(command: () => Promise<void>): void {
    command()
      .then(() => void this._refresh_async())
      .catch((e: unknown) => { this._show_error(e); void this._refresh_async() })
  }

  dispatch_job(make_job: () => BatchJob): void {
    let job: BatchJob
    try {
      job = make_job()
    } catch (e) {
      this._show_error(e)
      void this._refresh_async()
      return
    }

    this._current_job = job

    if (job.total > 1) {
      this._overlay.show(job, () => { job.cancel() })
    }
    void this._refresh_async()

    job.onProgress((done, total) => { this._overlay.update(done, total) })

    job.result().then(result => {
      this._overlay.hide()
      this._current_job = null
      if (result instanceof Failed) this._show_error(result.error)
      void this._refresh_async()
    }).catch((e: unknown) => {
      this._overlay.hide()
      this._current_job = null
      this._show_error(e)
      void this._refresh_async()
    })
  }

  get busy(): boolean { return this._current_job !== null }

  // ---------------------------------------------------------------------------
  // Detail panel toggle (settings / help)
  // ---------------------------------------------------------------------------

  toggle_detail(panel: DetailPanelType): void {
    const current = this._detail_panel.active
    if (current === panel) {
      this._close_detail()
    } else if (panel !== null) {
      this._open_detail(panel)
    }
  }

  private _open_detail(panel: NonNullable<DetailPanelType>): void {
    this._detail_panel.show(panel)
    this._detail_col.classList.add('open')
  }

  private _close_detail(): void {
    this._detail_panel.hide()
    this._detail_col.classList.remove('open')
  }

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------

  // Test-only accessor (Playwright reads view_snapshot() via window.__model in DEV — see main.ts).
  get model(): AppModel { return this._model }

  async refresh_all(): Promise<void> {
    await this._refresh_async()
  }

  private async _refresh_async(): Promise<void> {
    // Ensure current page bitmap is ready (async)
    if (this._model.has_document) {
      await this._model.prepare_current_view()
    }
    const snap = this._model.view_snapshot()
    const busy = this.busy

    this._canvas_view.paint(snap)
    this._drop_zone.classList.toggle('hidden', this._model.has_document)
    this._pages_panel.refresh(this._model, busy)
    this._scan_panel.refresh(this._model, busy)
    this._crop_panel.refresh(this._model, busy)
    this._output_panel.refresh(this._model, busy)
    this._nav_bar.refresh(this._model, busy)
    this._detail_panel.refresh(this._model, this._ui_config)
  }

  // ---------------------------------------------------------------------------
  // Drag-and-drop file load
  // ---------------------------------------------------------------------------

  private _wire_drop_zone(): void {
    const col = this._canvas_col
    col.addEventListener('dragover', ev => {
      ev.preventDefault()
      this._drop_zone.classList.add('drag-over')
    })
    col.addEventListener('dragleave', () => { this._drop_zone.classList.remove('drag-over') })
    col.addEventListener('drop', ev => {
      ev.preventDefault()
      this._drop_zone.classList.remove('drag-over')
      const files = Array.from(ev.dataTransfer?.files ?? [])
      if (files.length) this.dispatch_async(() => this._model.load_files(files))
    })
  }

  // ---------------------------------------------------------------------------
  // UIConfig — theme / font size / UI scale / behaviour toggles (called by SettingsView).
  // Owned here per ARCHITECTURE §10: presentation-only, drives no domain computation.
  // ---------------------------------------------------------------------------

  private _ui_config: UIConfig = {
    theme: 'dark',
    font_size: FONT_SIZE_DEFAULT,
    ui_scale: 1.0,
    remember_folder: true,
  }

  get ui_config(): Readonly<UIConfig> { return this._ui_config }

  set_theme(t: 'dark' | 'light' | 'system'): void {
    this._ui_config.theme = t
    apply_theme(t)
  }

  set_font_size(n: number): void {
    this._ui_config.font_size = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, n))
    this._apply_scale()
  }

  set_remember_folder(on: boolean): void { this._ui_config.remember_folder = on }

  // Ctrl +/- (spec §21): scales the whole UI on top of font_size, does not change font_size
  // itself — the two are separate settings (spec §15).
  zoom(dir: number): void {
    if (dir === 0) {
      this._ui_config.ui_scale = 1.0
    } else {
      const step = 0.1
      this._ui_config.ui_scale = Math.max(UI_SCALE_MIN,
        Math.min(UI_SCALE_MAX, this._ui_config.ui_scale + dir * step))
    }
    this._apply_scale()
  }

  // Set the UI scale directly (Settings dropdown). Ctrl +/- still uses zoom() for stepping.
  set_ui_scale(scale: number): void {
    this._ui_config.ui_scale = Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, scale))
    this._apply_scale()
  }

  private _apply_scale(): void {
    document.documentElement.style.fontSize =
      `${this._ui_config.font_size * this._ui_config.ui_scale}px`
  }

  // Output-quality persistence (task 12): survive new-doc loads and browser sessions via
  // localStorage (ui/persist.ts). core/ never sees storage — the controller mediates.
  private _restore_output_prefs(): void {
    const p = load_output_prefs()
    if (p.compress_preset !== undefined) this._model.set_compress_preset(p.compress_preset)
    if (typeof p.custom_dpi === 'number') this._model.set_custom_dpi(p.custom_dpi)
    if (p.paper_size !== undefined)      this._model.set_paper_size(p.paper_size)
    if (p.output_colours !== undefined)  this._model.set_output_colours(p.output_colours)
    if (p.export_format !== undefined)   this._model.set_export_format(p.export_format)
  }

  private _persist_output_prefs(): void {
    save_output_prefs({
      compress_preset: this._model.compress_preset,
      custom_dpi:      this._model.custom_dpi,
      paper_size:      this._model.paper_size,
      output_colours:  this._model.output_colours,
      export_format:   this._model.export_format,
    })
  }

  // ---------------------------------------------------------------------------
  // Error display
  // ---------------------------------------------------------------------------

  private _show_error(e: unknown): void {
    // DocumentLoadError (and similar) carry the underlying worker/library error on
    // cause_error (core/errors.ts) but Error.message alone doesn't include it — surface it
    // here so failures are diagnosable from the toast/console instead of a bare wrapper
    // message like "Failed to load x.pdf" with no indication of why.
    const cause = e instanceof Error ? (e as { cause_error?: unknown }).cause_error : undefined
    const base  = e instanceof Error ? e.message : String(e)
    const msg   = cause !== undefined ? `${base} — ${stringify_cause(cause)}` : base
    const toast = document.createElement('div')
    toast.className = 'error-toast'
    toast.textContent = msg
    this._root.appendChild(toast)
    // Auto-dismiss after 5 s (unhandled errors from callbacks)
    setTimeout(() => { toast.remove() }, 5000)
    console.error('[SmartCrop]', msg)
  }

  // ---------------------------------------------------------------------------
  // File download helpers
  // ---------------------------------------------------------------------------

  private _download_blob(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob)
    const a   = document.createElement('a')
    a.href = url; a.download = name
    a.click()
    setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
  }

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts (spec §21)
  // ---------------------------------------------------------------------------

  private _on_shortcut = (ev: KeyboardEvent): void => {
    // Esc closes the detail panel (spec-web §W4; no desktop equivalent — no floating window).
    // Handled before the Ctrl gate since Esc carries no modifier. Drag-cancel Esc is handled
    // separately in canvas_view against the canvas element.
    if (ev.key === 'Escape') { this._close_detail(); return }
    const ctrl = ev.ctrlKey || ev.metaKey
    if (!ctrl) return
    switch (ev.key) {
      case 'o': ev.preventDefault(); this._pages_panel.trigger_load(); break
      case 'Enter': ev.preventDefault(); this.dispatch(() => { this._model.apply_crop() }); break
      case 's': ev.preventDefault(); this._trigger_export(); break
      case 'z': ev.preventDefault(); this.dispatch(() => { this._model.undo() }); break
      case 'y': ev.preventDefault(); this.dispatch(() => { this._model.redo() }); break
      case '=': case '+': ev.preventDefault(); this.zoom(1); break
      case '-': ev.preventDefault(); this.zoom(-1); break
      case '0': ev.preventDefault(); this.zoom(0); break
    }
  }

  private _trigger_export(): void {
    const name = this._model.suggested_export_name()
    this.dispatch_job(() => this._model.export(name))
  }

  destroy(): void {
    this._canvas_view.destroy()
    this._adapter.close()
    window.removeEventListener('keydown', this._on_shortcut)
  }
}

// Safe unknown -> string for error causes: Error.message for Errors, the value itself for
// strings, JSON for plain objects (never the default `[object Object]`), String() for the
// rest (numbers, etc).
function stringify_cause(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === 'string') return cause
  if (typeof cause === 'object' && cause !== null) {
    try { return JSON.stringify(cause) } catch { return 'unknown error' }
  }
  return String(cause)
}
