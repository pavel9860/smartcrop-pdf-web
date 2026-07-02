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
    export_images: () => Promise.resolve([new Blob(['x'])]),
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
}

/** Duck-typed AppController: runs commands synchronously, records every call. */
export function make_ctrl(): FakeController {
  const calls: CtrlCall[] = []
  const rec = (kind: string, arg?: unknown): void => { calls.push({ kind, arg }) }
  const obj = {
    dispatch(cmd: () => void): void { rec('dispatch'); try { cmd() } catch { /* surfaced elsewhere */ } },
    dispatch_async(cmd: () => Promise<void>): void {
      rec('dispatch_async'); void cmd().catch(() => { /* swallow in tests */ })
    },
    dispatch_job(make: () => unknown): void { rec('dispatch_job'); try { make() } catch { /* ignore */ } },
    toggle_detail(panel: unknown): void { rec('toggle_detail', panel) },
    set_theme(t: unknown): void { rec('set_theme', t) },
    set_font_size(n: unknown): void { rec('set_font_size', n) },
    set_confirm_overwrite(b: unknown): void { rec('set_confirm_overwrite', b) },
    set_remember_folder(b: unknown): void { rec('set_remember_folder', b) },
    zoom(d: unknown): void { rec('zoom', d) },
    get busy(): boolean { return false },
  }
  return { ctrl: obj as unknown as AppController, calls }
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
