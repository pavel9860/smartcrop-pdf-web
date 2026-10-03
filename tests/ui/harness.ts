// Shared jsdom harness for src/ui/ tests. Panels run against a real AppModel (core harness adapter)
// and a duck-typed AppController stand-in that runs every command synchronously, so a click
// exercises both the panel wiring and the model method it reaches.
import { vi } from 'vitest'
import { AppController } from '@ui/app'
import type { RendererAdapter } from '@core/model'
import { make_adapter } from '../core/harness'

export { make_adapter, loaded } from '../core/harness'

// jsdom has no canvas backend, ResizeObserver or pointer capture; CanvasView only needs permissive
// stand-ins. Pair with vi.restoreAllMocks() + vi.unstubAllGlobals() in afterEach.
export function stub_canvas_apis(): void {
  const ctx = new Proxy({}, { get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined) })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} })
  Element.prototype.setPointerCapture = (): void => undefined
  Element.prototype.releasePointerCapture = (): void => undefined
}

// A fresh container in a cleared body: jsdom resolves a scoped `#id` query through a document-wide
// lookup, so a stale duplicate id elsewhere in the body would make it return null.
export function mount(): HTMLElement {
  document.body.innerHTML = ''
  return document.body.appendChild(document.createElement('div'))
}

// A real AppController past its startup load (the manual fetch fails under jsdom, so the adapter's
// placeholder document opens).
export async function boot(adapter: RendererAdapter = make_adapter()): Promise<{ ctrl: AppController; root: HTMLElement }> {
  stub_canvas_apis()
  const root = mount()
  const ctrl = new AppController(root, adapter)
  await vi.waitFor(() => { if (!ctrl.model.has_document) throw new Error('startup load pending') })
  await ctrl.refresh_all()
  return { ctrl, root }
}

export interface CtrlCall { kind: string; arg?: unknown }

export interface FakeController {
  ctrl: AppController
  calls: CtrlCall[]
}

export function make_ctrl(): FakeController {
  const calls: CtrlCall[] = []
  const rec = (kind: string) => (arg?: unknown): void => { calls.push({ kind, arg }) }
  const obj = {
    dispatch(cmd: () => void): void { rec('dispatch')(); cmd() },
    dispatch_async(cmd: () => Promise<void>): void { rec('dispatch_async')(); void cmd() },
    dispatch_job(make: () => unknown): void { rec('dispatch_job')(); make() },
    toggle_detail: rec('toggle_detail'),
    set_theme: rec('set_theme'),
    set_font_size: rec('set_font_size'),
    set_remember_folder: rec('set_remember_folder'),
    set_offline_enabled: rec('set_offline_enabled'),
    set_ui_scale: rec('set_ui_scale'),
    delete_selected_pages: rec('delete_selected_pages'),
    trigger_export: rec('trigger_export'),
    busy: false,
  }
  return { ctrl: obj as unknown as AppController, calls }
}

// Every interactive control under `root` carries a non-empty `title` tooltip; a hidden file input
// is triggered by a labelled button and never hovered.
export function untitled_controls(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button, select, input:not([type="file"]), textarea'))
    .filter(el => !(el.getAttribute('title') ?? '').trim())
    .map(el => el.id || el.className || el.tagName)
}
