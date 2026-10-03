// AppController: the one error-catch site (ARCHITECTURE §6), progress/status overlay timing
// (spec-web §11), busy gating, keyboard shortcuts, file drop, delete/export entry points and the
// startup manual (spec-web §1).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { AppController } from '@ui/app'
import { Failed, type BatchJob } from '@core/batch'
import { ImagingError } from '@core/errors'
import { Mode } from '@core/enums'
import { OVERLAY_SHOW_DELAY_MS } from '@ui/constants'
import { with_module_status } from '@pdf/module_status'
import { mount, make_adapter, stub_canvas_apis, boot } from './harness'
import { select } from '../core/harness'

// A job that runs until finish() fails it with `message`.
function pending_job(title = 'Dewarping…', total = 1, message = 'x'): { job: BatchJob; finish: () => void } {
  let finish = (): void => undefined
  const job: BatchJob = {
    title, total, done: 0, cancel: () => undefined, onProgress: () => undefined,
    result: () => new Promise(r => { finish = () => { r(new Failed(new ImagingError(message))) } }),
  }
  return { job, finish: () => { finish() } }
}

const titles = (root: HTMLElement): string[] => Array.from(root.querySelectorAll('.overlay__title')).map(el => el.textContent)
const overlay_hidden = (root: HTMLElement): boolean => root.querySelector('.overlay')!.classList.contains('hidden')
const confirm_buttons = (root: HTMLElement): number => root.querySelectorAll('.overlay__card [data-act="confirm"]').length
const key = (k: string, opts: KeyboardEventInit = {}, target: EventTarget = window): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }))
}
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0))

let ctrl: AppController | null = null
afterEach(() => { ctrl?.destroy(); ctrl = null; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('errors surface as dialogs', () => {
  it('a Failed job result and a page that fails to render both show an error dialog', async () => {
    const booted = await boot({ ...make_adapter(), get_source_image: () => Promise.reject(new ImagingError('render failed')) })
    ctrl = booted.ctrl
    const { job, finish } = pending_job('t', 1, 'boom')
    ctrl.dispatch_job(() => job)
    finish()
    await tick()
    expect(titles(booted.root)).toEqual(expect.arrayContaining([expect.stringContaining('render failed'), expect.stringContaining('boom')]))
  })
})

describe('progress and module status (spec-web §11)', () => {
  it('a single-page job shows the overlay only once it outlasts the delay, and hides it when done', async () => {
    const booted = await boot()
    ctrl = booted.ctrl
    vi.useFakeTimers()
    const { job, finish } = pending_job('Dewarping…')
    ctrl.dispatch_job(() => job)
    expect(overlay_hidden(booted.root)).toBe(true)
    vi.advanceTimersByTime(OVERLAY_SHOW_DELAY_MS)
    expect([overlay_hidden(booted.root), titles(booted.root)[0]]).toEqual([false, 'Dewarping…'])
    finish()
    vi.useRealTimers()
    await tick()
    expect(overlay_hidden(booted.root)).toBe(true)
  })

  it('module loading with no job running shows a status card until it finishes', async () => {
    const booted = await boot()
    ctrl = booted.ctrl
    let done = (): void => undefined
    const loading = with_module_status('Loading image engine…', () => new Promise<void>(r => { done = r }))
    expect([overlay_hidden(booted.root), titles(booted.root)[0]]).toEqual([false, 'Loading image engine…'])
    done()
    await loading
    expect(overlay_hidden(booted.root)).toBe(true)
  })

  it('a SCANNED document starts the background scan-tool pre-load once, and its status never blocks the canvas', async () => {
    vi.resetModules()
    let finish: (ok: boolean) => void = () => undefined
    const prefetch = vi.fn(() => new Promise<boolean>(r => { finish = r }))
    vi.doMock('@ui/sw_register', () => ({ prefetch_scan_tools: prefetch, warm_offline_cache: vi.fn() }))
    try {
      const { AppController: Ctrl } = await import('@ui/app')
      const { with_module_status: status } = await import('@pdf/module_status')
      stub_canvas_apis()
      const root = mount()
      ctrl = new Ctrl(root, make_adapter({ page_count: 1, mode: Mode.SCANNED }))
      await ctrl.model.load_files([new File(['x'], 'scan.jpg')])
      await ctrl.refresh_all()
      await ctrl.refresh_all()
      expect(prefetch).toHaveBeenCalledTimes(1)
      let done = (): void => undefined
      const loading = status('Loading image engine…', () => new Promise<void>(r => { done = r }))
      expect(overlay_hidden(root)).toBe(true)
      done(); await loading; finish(true)
    } finally {
      vi.doUnmock('@ui/sw_register')
      vi.resetModules()
    }
  })
})

describe('commands are ignored while a job runs (spec-web §11)', () => {
  it('controls disable at dispatch, before the page re-renders; Ctrl+Z, Ctrl+S, Delete and drops do nothing', async () => {
    const booted = await boot()
    ctrl = booted.ctrl
    ctrl.model.rotate_pages()
    vi.spyOn(ctrl.model, 'prepare_current_view').mockReturnValue(new Promise(() => undefined))
    const spies = (['undo', 'export', 'load_files'] as const).map(m => vi.spyOn(ctrl!.model, m))
    const { job, finish } = pending_job('Applying filter…', 2)
    ctrl.dispatch_job(() => job)
    expect(booted.root.querySelector<HTMLButtonElement>('#op-export')!.disabled).toBe(true)
    key('z', { ctrlKey: true }); key('s', { ctrlKey: true }); key('Delete')
    drop(booted.root, [new File(['%PDF'], 'b.pdf')])
    expect([...spies.map(s => s.mock.calls.length), confirm_buttons(booted.root)]).toEqual([0, 0, 0, 0])
    finish()
  })
})

describe('keyboard shortcuts', () => {
  it('ArrowLeft/Right and PageUp/Down navigate like the wheel; Ctrl+Z undoes', async () => {
    ctrl = (await boot()).ctrl
    const m = ctrl.model
    m.rotate_pages()
    m.jump_to_output_page(2)
    const seen: number[] = []
    for (const k of ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']) { key(k); seen.push(m.view_position) }
    key('z', { ctrlKey: true })
    expect([seen, m.can_undo]).toEqual([[1, 2, 1, 2], false])
  })

  it('arrows and Ctrl+Z are left to a focused text field', async () => {
    ctrl = (await boot()).ctrl
    ctrl.model.rotate_pages()
    ctrl.model.jump_to_output_page(2)
    const input = document.body.appendChild(document.createElement('input'))
    input.focus()
    key('ArrowLeft', {}, input)
    key('z', { ctrlKey: true }, input)
    expect([ctrl.model.view_position, ctrl.model.can_undo]).toEqual([2, true])
  })

  it('a held Delete (key repeat) opens one confirm dialog, not one per tick', async () => {
    const booted = await boot()
    ctrl = booted.ctrl
    select(ctrl.model, '1')
    key('Delete'); key('Delete', { repeat: true }); key('Delete', { repeat: true })
    expect(confirm_buttons(booted.root)).toBe(1)
  })
})

describe('delete and export entry points', () => {
  it('deleting every page shows an info alert, not a confirm', async () => {
    const booted = await boot()
    ctrl = booted.ctrl
    ctrl.delete_selected_pages()
    expect([confirm_buttons(booted.root), titles(booted.root)]).toEqual([0, expect.arrayContaining([expect.stringContaining('Cannot delete all pages')])])
  })

  it('the delete confirm deletes on accept and keeps the pages on cancel', async () => {
    for (const [act, pages] of [['cancel', 3], ['confirm', 2]] as const) {
      const booted = await boot()
      ctrl = booted.ctrl
      select(ctrl.model, '1')
      ctrl.delete_selected_pages()
      booted.root.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!.click()
      await tick()
      expect(ctrl.model.page_count()).toBe(pages)
      ctrl.destroy()
    }
    ctrl = null
  })

  it('trigger_export starts the export job under the suggested name', async () => {
    ctrl = (await boot()).ctrl
    const exp = vi.spyOn(ctrl.model, 'export')
    ctrl.trigger_export()
    expect([exp.mock.calls, ctrl.busy]).toEqual([[[ctrl.model.suggested_export_name()]], true])
  })
})

function drop(target: Element, files: File[], type = 'drop'): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], files } })
  target.dispatchEvent(ev)
  return ev
}

describe('file drop', () => {
  it('files dropped anywhere on the window open, with an overlay while dragging', async () => {
    const booted = await boot()
    ctrl = booted.ctrl
    const load = vi.spyOn(ctrl.model, 'load_files')
    const sidebar = booted.root.querySelector('.sidebar-scroll')!
    const zone = booted.root.querySelector('.drop-zone')!
    drop(sidebar, [], 'dragenter')
    expect(zone.classList.contains('drag-over')).toBe(true)
    const file = new File(['%PDF'], 'a.pdf')
    expect([drop(sidebar, [], 'dragover').defaultPrevented, drop(sidebar, [file]).defaultPrevented]).toEqual([true, true])
    expect([zone.classList.contains('drag-over'), load.mock.calls]).toEqual([false, [[[file]]]])
  })
})

describe('startup manual (spec-web §1)', () => {
  function start(): { respond: () => void; read: ReturnType<typeof vi.fn> } {
    stub_canvas_apis()
    const read = vi.fn(() => Promise.resolve(new Blob(['%PDF'])))
    let respond = (): void => undefined
    vi.stubGlobal('fetch', () => new Promise<Response>(r => { respond = () => { r({ ok: true, blob: read } as unknown as Response) } }))
    ctrl = new AppController(mount(), make_adapter())
    return { respond: () => { respond() }, read }
  }

  it('opens the manual when no file is open', async () => {
    const { respond } = start()
    const load = vi.spyOn(ctrl!.model, 'load_files')
    respond()
    await vi.waitFor(() => { expect(load).toHaveBeenCalledOnce() })
    expect(load.mock.calls[0]![0].map(f => f.name)).toEqual(['manual.pdf'])
  })

  it('keeps a file opened before the manual arrives', async () => {
    const { respond, read } = start()
    await ctrl!.model.load_files([new File(['%PDF'], 'a.pdf')])
    const load = vi.spyOn(ctrl!.model, 'load_files')
    respond()
    await vi.waitFor(() => { expect(read).toHaveBeenCalled() })
    await tick()
    expect([load.mock.calls.length, ctrl!.model.document_name]).toEqual([0, 'a.pdf'])
  })
})
