// AppController tests, using the shared mock RendererAdapter (harness.ts) — no real PDF.js/
// OpenCV/ONNX. dispatch_job's error-surfacing is exercised with a hand-built BatchJob rather than
// a real model command, isolating the boundary this test targets (ARCHITECTURE §6).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { AppController } from '@ui/app'
import type { BatchJob } from '@core/batch'
import { Failed } from '@core/batch'
import { ImagingError } from '@core/errors'
import { PagesMode } from '@core/enums'
import { mount, make_adapter, stub_canvas_apis } from './harness'

function failing_job(message: string): BatchJob {
  return {
    title: 'test job',
    total: 1,
    display_total: 1,
    done: 0,
    cancel: (): void => { /* no-op */ },
    onProgress: (): void => { /* no-op */ },
    result: (): Promise<Failed> => Promise.resolve(new Failed(new ImagingError(message))),
  }
}

describe('AppController.dispatch_job', () => {
  let ctrl: AppController | null = null
  afterEach(() => { ctrl?.destroy(); ctrl = null; vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('a Failed job result shows an error dialog (the one error-catch site, ARCHITECTURE §6)', async () => {
    stub_canvas_apis()
    const root = mount()
    ctrl = new AppController(root, make_adapter())
    await ctrl.refresh_all()   // let the initial synthetic-doc load_files([]) settle

    ctrl.dispatch_job(() => failing_job('boom'))
    await new Promise(resolve => setTimeout(resolve, 0))   // let job.result().then(...) run

    // ProgressOverlay (constructed alongside AppController) has its own, separate .overlay__title
    // element — query all of them, since the error dialog's is a second, later one.
    const titles = Array.from(root.querySelectorAll('.overlay__title')).map(el => el.textContent)
    expect(titles.some(t => t.includes('boom'))).toBe(true)
  })
})

describe('AppController keyboard shortcuts', () => {
  let ctrl: AppController | null = null
  afterEach(() => {
    ctrl?.destroy(); ctrl = null
    vi.restoreAllMocks(); vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  function key(k: string, opts: Partial<KeyboardEventInit> = {}, target: EventTarget = window): void {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }))
  }

  it('ArrowLeft/ArrowRight and PageUp/PageDown navigate pages, matching the mouse wheel', async () => {
    stub_canvas_apis()
    const root = mount()
    ctrl = new AppController(root, make_adapter(3))
    await ctrl.refresh_all()
    ctrl.model.jump_to_output_page(2)
    expect(ctrl.model.view_position).toBe(2)

    key('ArrowLeft')
    expect(ctrl.model.view_position).toBe(1)
    key('ArrowRight')
    expect(ctrl.model.view_position).toBe(2)
    key('PageUp')
    expect(ctrl.model.view_position).toBe(1)
    key('PageDown')
    expect(ctrl.model.view_position).toBe(2)
  })

  it('leaves ArrowLeft/ArrowRight and Ctrl+Z alone while a text input has focus', async () => {
    stub_canvas_apis()
    const root = mount()
    ctrl = new AppController(root, make_adapter(3))
    await ctrl.refresh_all()
    ctrl.model.jump_to_output_page(2)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    key('ArrowLeft', {}, input)
    expect(ctrl.model.view_position).toBe(2)   // unchanged — left to the field's own cursor movement

    const applied_before = ctrl.model.can_undo
    key('z', { ctrlKey: true }, input)
    expect(ctrl.model.can_undo).toBe(applied_before)   // Ctrl+Z did not reach model.undo()
  })

  it('holding Delete (OS key-repeat) opens only one confirm dialog, not one per repeat tick', async () => {
    stub_canvas_apis()
    const root = mount()
    ctrl = new AppController(root, make_adapter(3))
    await ctrl.refresh_all()
    // A selection smaller than "every page" — deleting everything takes the alert() branch
    // instead of confirm() (crop_panel.ts pre-checks this same condition).
    ctrl.model.set_pages_mode(PagesMode.SELECT)
    ctrl.model.set_select_pattern('1')

    key('Delete')                       // first press: opens the confirm dialog
    key('Delete', { repeat: true })     // OS key-repeat: must be ignored
    key('Delete', { repeat: true })
    const dialogs = root.querySelectorAll('.overlay__card .confirm-actions [data-act="confirm"]')
    expect(dialogs.length).toBe(1)
  })
})

describe('AppController.delete_selected_pages / trigger_export', () => {
  let ctrl: AppController | null = null
  afterEach(() => { ctrl?.destroy(); ctrl = null; vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('deleting every page shows an info alert instead of the confirm dialog (bug 18)', async () => {
    stub_canvas_apis()
    const root = mount()
    ctrl = new AppController(root, make_adapter(3))
    await ctrl.refresh_all()   // default Pages selection is All == every page

    ctrl.delete_selected_pages()
    expect(root.querySelector('.overlay__card .confirm-actions [data-act="confirm"]')).toBeNull()
    const titles = Array.from(root.querySelectorAll('.overlay__title')).map(el => el.textContent)
    expect(titles.some(t => t.includes('Cannot delete all pages'))).toBe(true)
  })

  it('declining the delete confirm does not delete', async () => {
    stub_canvas_apis()
    const root = mount()
    ctrl = new AppController(root, make_adapter(3))
    await ctrl.refresh_all()
    ctrl.model.set_pages_mode(PagesMode.SELECT)
    ctrl.model.set_select_pattern('1')
    const count_before = ctrl.model.page_count()

    ctrl.delete_selected_pages()
    root.querySelector<HTMLButtonElement>('[data-act="cancel"]')!.click()
    await Promise.resolve()
    expect(ctrl.model.page_count()).toBe(count_before)
  })

  it('accepting the delete confirm deletes the selected pages', async () => {
    stub_canvas_apis()
    const root = mount()
    ctrl = new AppController(root, make_adapter(3))
    await ctrl.refresh_all()
    ctrl.model.set_pages_mode(PagesMode.SELECT)
    ctrl.model.set_select_pattern('1')

    ctrl.delete_selected_pages()
    root.querySelector<HTMLButtonElement>('[data-act="confirm"]')!.click()
    await Promise.resolve()
    expect(ctrl.model.page_count()).toBe(2)
  })

  it('trigger_export dispatches a job using suggested_export_name', async () => {
    stub_canvas_apis()
    const root = mount()
    ctrl = new AppController(root, make_adapter(3))
    await ctrl.refresh_all()
    expect(ctrl.busy).toBe(false)

    ctrl.trigger_export()
    expect(ctrl.busy).toBe(true)   // dispatch_job set a current job synchronously
  })
})
