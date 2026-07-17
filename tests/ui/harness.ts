// Shared jsdom harness for src/ui/ panel/view tests. A hand-rolled mock RendererAdapter and a
// duck-typed AppController stand-in let panels run headless: no real PDF.js/OpenCV/canvas. The
// fake controller invokes dispatched commands synchronously so a click exercises both the panel
// wiring AND the underlying AppModel method, then records the call for assertions.
import { AppModel, type RendererAdapter, type DocInfo, type OutputPage } from '@core/model'
import type { AppController } from '@ui/app'
import { Mode } from '@core/enums'

export function make_bitmap(w = 200, h = 300): ImageBitmap {
  return { width: w, height: h, close: (): void => { /* no-op */ } } as unknown as ImageBitmap
}

export function make_adapter(page_count = 3, mode: Mode = Mode.NORMAL): RendererAdapter {
  const pw = 200, ph = 300
  return {
    load_files: (files: File[]): Promise<DocInfo> => Promise.resolve({
      page_count,
      page_sizes: Array.from({ length: page_count }, () => ({ width: pw, height: ph })),
      file_names: files.map(f => f.name),
      mode,
    }),
    get_source_image: () => Promise.resolve(make_bitmap(pw, ph)),
    get_work_image: () => Promise.resolve(make_bitmap(pw, ph)),
    render_output_image: (_s, box) => Promise.resolve(
      make_bitmap(Math.max(1, Math.round(box.x1 - box.x0)), Math.max(1, Math.round(box.y1 - box.y0)))),
    detect_content_box: (_i, w, h) => Promise.resolve({ x0: 20, y0: 20, x1: w - 20, y1: h - 20 }),
    export_pdf: (_p: OutputPage[]) => Promise.resolve(new Uint8Array([1, 2, 3])),
    export_images: () => Promise.resolve(new Uint8Array([4, 5, 6])),
    make_synth_page: (_i, w, h) => Promise.resolve(make_bitmap(w, h)),
    close: (): void => { /* no-op */ },
  }
}

/** Build an AppModel with a mock adapter, optionally pre-loaded with a document. */
export async function make_model(
  opts: { loaded?: boolean; page_count?: number; mode?: Mode } = {},
): Promise<AppModel> {
  const { loaded = true, page_count = 3, mode = Mode.NORMAL } = opts
  const model = new AppModel(make_adapter(page_count, mode))
  if (loaded) await model.load_files([new File(['%PDF'], 'sample.pdf')])
  return model
}

export interface CtrlCall { kind: string; arg?: unknown }

export interface FakeController {
  ctrl: AppController
  calls: CtrlCall[]
  /** Controls what ctrl.confirm() resolves to (default true) — set before triggering the action. */
  set_confirm_result: (v: boolean) => void
}

/** Duck-typed AppController: runs commands synchronously, records every call. */
export function make_ctrl(): FakeController {
  const calls: CtrlCall[] = []
  let confirm_result = true
  const rec = (kind: string, arg?: unknown): void => { calls.push({ kind, arg }) }
  const obj = {
    dispatch(cmd: () => void): void { rec('dispatch'); try { cmd() } catch { /* surfaced elsewhere */ } },
    dispatch_async(cmd: () => Promise<void>): void {
      rec('dispatch_async'); void cmd().catch(() => { /* swallow in tests */ })
    },
    dispatch_job(make: () => unknown): void { rec('dispatch_job'); try { make() } catch { /* ignore */ } },
    confirm(message: unknown): Promise<boolean> {
      rec('confirm', message)
      return Promise.resolve(confirm_result)
    },
    alert(message: unknown, variant: unknown): Promise<void> {
      rec('alert', { message, variant })
      return Promise.resolve()
    },
    toggle_detail(panel: unknown): void { rec('toggle_detail', panel) },
    set_theme(t: unknown): void { rec('set_theme', t) },
    set_font_size(n: unknown): void { rec('set_font_size', n) },
    set_remember_folder(b: unknown): void { rec('set_remember_folder', b) },
    zoom(d: unknown): void { rec('zoom', d) },
    set_ui_scale(s: unknown): void { rec('set_ui_scale', s) },
    get busy(): boolean { return false },
  }
  return { ctrl: obj as unknown as AppController, calls, set_confirm_result: (v: boolean) => { confirm_result = v } }
}

/** A fresh container attached to a cleared document.body. Clearing first keeps element IDs
 * unique across tests: jsdom resolves a scoped `#id` query via a document-wide id lookup and
 * then verifies containment, so a stale duplicate elsewhere in the body makes the scoped query
 * return null. One mount per test (in beforeEach) guarantees uniqueness. */
export function mount(): HTMLElement {
  document.body.innerHTML = ''
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

/** Every interactive control under `root` must expose a non-empty `title` tooltip (T8, #19).
 * A hidden `<input type="file">` is excluded — it's triggered programmatically by a labelled
 * button, never hovered directly. Elements matching `exclude` (e.g. a live-computed tooltip like
 * the doc-name card, or a control checked by its own more specific test) are skipped too. */
export function assert_all_have_tooltips(root: ParentNode, exclude: string[] = []): void {
  const controls = Array.from(
    root.querySelectorAll<HTMLElement>('button, select, input:not([type="file"]), textarea'),
  ).filter(el => !exclude.some(sel => el.matches(sel)))
  const missing = controls.filter(el => !(el.getAttribute('title') ?? '').trim())
  if (missing.length > 0) {
    const desc = missing.map(el =>
      `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className ? `.${el.className.split(' ').join('.')}` : ''}>`)
    throw new Error(`Missing tooltip on: ${desc.join(', ')}`)
  }
}
