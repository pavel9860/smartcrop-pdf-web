// Sidebar panels, nav bar, settings and detail panel: each control reaches the right model method
// (asserted on the model's state), refresh() mirrors the model, busy disables, every control has a
// tooltip (spec-web §4).
import { describe, it, expect, vi } from 'vitest'
import type { AppModel } from '@core/model'
import { Mode, FilterMode, PagesMode } from '@core/enums'
import { CropPanel } from '@ui/panels/crop_panel'
import { OutputPanel } from '@ui/panels/output_panel'
import { PagesPanel } from '@ui/panels/pages_panel'
import { ScanPanel } from '@ui/panels/scan_panel'
import { NavBar } from '@ui/nav_bar'
import { SettingsView } from '@ui/settings_view'
import { DetailPanel } from '@ui/detail_panel'
import { requireEl } from '@ui/dom'
import type { UIConfig } from '@ui/app'
import { loaded, make_ctrl, mount, untitled_controls, type FakeController } from './harness'

const UI: Readonly<UIConfig> = { theme: 'light', font_size: 15, ui_scale: 1.15, remember_folder: true, offline_enabled: false }

type Control = HTMLInputElement & HTMLSelectElement
type PanelCtor<P> = new (root: HTMLElement, model: AppModel, ctrl: FakeController['ctrl']) => P

async function setup<P>(Ctor: PanelCtor<P>, mode = Mode.NORMAL): Promise<{
  panel: P; model: AppModel; fc: FakeController; root: HTMLElement
  $: (sel: string) => Control
  change: (sel: string, value?: string | boolean) => void
}> {
  const root = mount()
  const model = await loaded({ mode })
  const fc = make_ctrl()
  const panel = new Ctor(root, model, fc.ctrl)
  const $ = (sel: string): Control => requireEl<Control>(root, sel)
  const change = (sel: string, value?: string | boolean): void => {
    const el = $(sel)
    if (typeof value === 'boolean') el.checked = value
    else if (value !== undefined) el.value = value
    el.dispatchEvent(new Event('change'))
  }
  return { panel, model, fc, root, $, change }
}
const hidden = (el: HTMLElement): boolean => el.classList.contains('hidden')

describe('CropPanel', () => {
  it('split buttons set the split, reveal same-size and relabel Crop; detect and anchors stay enabled', async () => {
    const { panel, model, $ } = await setup(CropPanel)
    $('[data-n="2"]').click()
    panel.refresh(model, false)
    expect([model.split_count, hidden($('#cp-same-row')), $('#cp-crop').textContent]).toEqual([2, false, expect.stringContaining('Split & Crop')])
    for (const id of ['#cp-detect', '#cp-anchor-l', '#cp-anchor-t']) expect($(id).disabled).toBe(false)
    $('#cp-same-size').click()
    expect(model.same_size).toBe(true)
  })

  it('anchor and keep-ratio switches and the ratio field reach the model', async () => {
    const { model, change } = await setup(CropPanel)
    change('#cp-anchor-l', false)
    change('#cp-anchor-t', false)
    change('#cp-keep-ratio', true)
    change('#cp-ratio', '1.5')
    expect([model.anchor_left, model.anchor_top, model.keep_ratio, model.ratio]).toEqual([false, false, true, 1.5])
  })

  it('the edge fields appear only for a drawn window and edit it', async () => {
    const { panel, model, $, change } = await setup(CropPanel)
    expect(hidden($('#cp-offset-body'))).toBe(true)
    model.begin_drag(20, 30, 5); model.update_drag(180, 270); model.end_drag()
    panel.refresh(model, false)
    expect([hidden($('#cp-offset-body')), $('#cp-off-l').value]).toEqual([false, '10.0'])
    change('#cp-off-l', '5')
    expect(model.drawn_offsets).toEqual({ left: 5, top: 10, right: 10, bottom: 10 })
    model.cancel_drag()
    panel.refresh(model, false)
    expect(hidden($('#cp-offset-body'))).toBe(true)
  })

  it('Auto-detect starts the job; Crop and Rotate reach the model; Delete goes through the controller', async () => {
    const { model, fc, $ } = await setup(CropPanel)
    $('#cp-detect').click()
    await vi.waitFor(() => { expect(model.auto_active).toBe(true) })
    $('#cp-crop').click()
    $('#cp-rotate').click()
    $('#cp-delete').click()
    expect([model.document.applied.size, model.view_snapshot().page_w]).toEqual([3, 260])
    expect(fc.calls.map(c => c.kind)).toEqual(['dispatch_job', 'dispatch', 'dispatch', 'delete_selected_pages'])
  })

  it('busy disables the actions; every control has a tooltip', async () => {
    const { panel, model, $, root } = await setup(CropPanel)
    panel.refresh(model, true)
    expect(['#cp-crop', '#cp-rotate', '#cp-detect'].map(id => $(id).disabled)).toEqual([true, true, true])
    expect(untitled_controls(root)).toEqual([])
  })
})

describe('ScanPanel', () => {
  it('shows only for SCANNED documents', async () => {
    const { panel, model, $ } = await setup(ScanPanel, Mode.SCANNED)
    panel.refresh(model, false)
    expect(hidden($('.panel-card'))).toBe(false)
    panel.refresh(await loaded(), false)
    expect(hidden($('.panel-card'))).toBe(true)
  })

  it('Dewarp, filter and strength buttons start warm jobs on the model and mark the active filter', async () => {
    const { panel, model, fc, $, root } = await setup(ScanPanel, Mode.SCANNED)
    $('#sp-dewarp').click()
    $('#sp-sharpen').click()
    expect(model.filter_mode).toBe(FilterMode.SHARPEN)
    $('#sp-bw').click()
    $('[data-str="3"]').click()
    expect([model.dewarp_on, model.filter_mode, model.filter_strength]).toEqual([true, FilterMode.BW, 3])
    expect(fc.calls.map(c => c.kind)).toEqual(['dispatch_job', 'dispatch_job', 'dispatch_job', 'dispatch_job'])
    panel.refresh(model, false)
    expect([$('#sp-bw').classList.contains('active'), $('#sp-sharpen').classList.contains('active')]).toEqual([true, false])
    panel.refresh(model, true)
    expect($('#sp-dewarp').disabled).toBe(true)
    expect(untitled_controls(root)).toEqual([])
  })
})

describe('PagesPanel', () => {
  it('mirrors mode and pages-mode; SELECT reveals the pattern row whose input edits the pattern', async () => {
    const { panel, model, $ } = await setup(PagesPanel)
    panel.refresh(model, false)
    expect([$('#pp-badge').textContent, $(`[data-mode="${PagesMode.ALL}"]`).classList.contains('active')]).toEqual([Mode.NORMAL, true])
    $(`[data-mode="${PagesMode.SELECT}"]`).click()
    panel.refresh(model, false)
    expect(hidden($('#pp-pat-row'))).toBe(false)
    const inp = $('#pp-pattern')
    inp.value = '1,3'
    inp.dispatchEvent(new Event('input'))
    expect([model.pages_mode, model.resolve_pages()]).toEqual([PagesMode.SELECT, [0, 2]])
  })

  it('picked files open through the model and the picker resets; Current toggles page follow', async () => {
    const { model, fc, $ } = await setup(PagesPanel)
    const input = $('#pp-file')
    const files = [new File(['%PDF'], 'b.pdf'), new File(['%PDF'], 'c.pdf')]
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    input.dispatchEvent(new Event('change'))
    await vi.waitFor(() => { expect(model.document_name).toBe('b.pdf +1 more') })
    Object.defineProperty(input, 'files', { value: [], configurable: true })
    input.dispatchEvent(new Event('change'))
    expect(fc.calls.map(c => c.kind)).toEqual(['dispatch_async'])
    $('#pp-current').click()
    expect([model.current_follow, model.select_pattern]).toEqual([true, '1'])
    $('#pp-current').click()
    expect(model.current_follow).toBe(false)
  })

  it('trigger_load opens the file dialog; busy disables loading; every control has a tooltip', async () => {
    const { panel, model, $, root } = await setup(PagesPanel)
    let opened = false
    $('#pp-file').click = () => { opened = true }
    panel.trigger_load()
    panel.refresh(model, true)
    model.set_pages_mode(PagesMode.SELECT)
    panel.refresh(model, true)
    expect([opened, $('#pp-load').disabled, untitled_controls(root)]).toEqual([true, true, []])
  })
})

describe('OutputPanel', () => {
  it('quality, colour and format controls reach the model; refresh mirrors format and size', async () => {
    const { panel, model, $, change } = await setup(OutputPanel)
    expect($('#op-custom-dpi').hidden).toBe(true)
    change('#op-compress', 'Custom')
    panel.refresh(model, false)
    expect($('#op-custom-dpi').hidden).toBe(false)
    change('#op-custom-dpi', '300')
    change('#op-colours', 'Grayscale')
    change('#op-format', 'TIFF')
    panel.refresh(model, false)
    expect([model.compress_preset, model.custom_dpi, model.output_colours, model.export_format]).toEqual(['Custom', 300, 'Grayscale', 'TIFF'])
    expect($('#op-export').textContent).toContain('Save TIFF')
    expect($('#op-size').textContent).toMatch(/^≈ \d+(\.\d)? (KB|MB)$/)
  })

  it('Save goes through the controller; busy disables it; every control has a tooltip', async () => {
    const { panel, model, fc, $, root } = await setup(OutputPanel)
    $('#op-export').click()
    panel.refresh(model, true)
    expect([fc.calls.map(c => c.kind), $('#op-export').disabled, untitled_controls(root)]).toEqual([['trigger_export'], true, []])
  })
})

describe('NavBar', () => {
  it('prev/next and the page field navigate; refresh shows the total and disables prev on page 1', async () => {
    const { panel, model, $, change } = await setup(NavBar)
    panel.refresh(model, false)
    expect([$('#nav-total').textContent, $('#nav-prev').disabled]).toEqual(['/ 3', true])
    $('#nav-next').click()
    expect(model.view_position).toBe(2)
    change('#nav-page', '3')
    expect(model.view_position).toBe(3)
    panel.refresh(model, false)
    $('#nav-prev').click()
    expect(model.view_position).toBe(2)
  })

  it('undo/redo reach the model; settings/help toggle the detail panel; busy disables reset', async () => {
    const { panel, model, fc, $, root } = await setup(NavBar)
    model.rotate_pages()
    $('#nav-undo').click()
    expect([model.can_undo, model.can_redo]).toEqual([false, true])
    $('#nav-redo').click()
    expect(model.can_undo).toBe(true)
    $('#nav-reset').click()
    await vi.waitFor(() => { expect(model.can_undo).toBe(false) })
    $('[data-id="settings"]').click()
    $('[data-id="help"]').click()
    expect(fc.calls.filter(c => c.kind === 'toggle_detail').map(c => c.arg)).toEqual(['settings', 'help'])
    panel.refresh(model, true)
    expect([$('#nav-reset').disabled, $('#nav-page').disabled, untitled_controls(root)]).toEqual([true, true, []])
  })
})

describe('SettingsView', () => {
  it('refresh mirrors UIConfig and the shared output settings', async () => {
    const { panel, model, $ } = await setup(SettingsView)
    panel.refresh(model, UI)
    expect([
      $('[data-theme="light"]').classList.contains('active'), $('#sv-font').value,
      $('#sv-zoom').value, $('#sv-remember').checked,
      $('#sv-offline').checked, $('#sv-paper').value,
    ]).toEqual([true, '15', '1.15', true, false, 'A4'])
    expect(Array.from($('#sv-paper').options).map(o => o.value)).toEqual(['A2', 'A3', 'A4', 'A5', 'A6', 'Custom'])
    expect(Array.from($('#sv-outlier').options).map(o => o.value)).toEqual(['0', '1', '2', '5', '10'])
  })

  it('appearance and behaviour controls call the controller', async () => {
    const { fc, $, change } = await setup(SettingsView)
    $('[data-theme="system"]').click()
    change('#sv-zoom', '1.5')
    change('#sv-font', $('#sv-font').options[0]!.value)
    change('#sv-remember', false)
    change('#sv-offline', true)
    expect(fc.calls.map(c => [c.kind, c.arg])).toEqual([
      ['set_theme', 'system'], ['set_ui_scale', 1.5], ['set_font_size', expect.any(Number)],
      ['set_remember_folder', false], ['set_offline_enabled', true],
    ])
  })

  it('output and scan fields reach the model; Custom paper reveals its height field', async () => {
    const { panel, model, $, change } = await setup(SettingsView)
    expect($('#sv-custom-paper-row').hidden).toBe(true)
    change('#sv-custom-dpi', '240')
    change('#sv-paper', 'Custom')
    panel.refresh(model, UI)
    expect($('#sv-custom-paper-row').hidden).toBe(false)
    change('#sv-custom-paper', '20')
    change('#sv-postfix', '_crop')
    change('#sv-supersample', '2')
    change('#sv-undo', '4')
    change('#sv-outlier', '5')
    expect([model.custom_dpi, model.compress_preset, model.paper_size, model.custom_paper_in, model.output_postfix,
      model.dewarp_supersample, model.undo_depth, model.detect_outlier_pages]).toEqual([240, 'Custom', 'Custom', 20, '_crop', 2, 4, 5])
    panel.refresh(model, UI)
    expect([$('#sv-custom-dpi').value, $('#sv-outlier').value]).toEqual(['240', '5'])
  })

  it('carries no duplicated sidebar output controls or browser-meaningless folder controls; every control has a tooltip', async () => {
    const { root } = await setup(SettingsView)
    expect(['#sv-compress', '#sv-format', '#sv-confirm', '#sv-folder', '#sv-folder-pick'].filter(s => root.querySelector(s))).toEqual([])
    expect(untitled_controls(root)).toEqual([])
  })
})

describe('DetailPanel', () => {
  it('shows one view at a time; the close button asks the controller to toggle; hide clears it', async () => {
    const { panel, fc, $ } = await setup(DetailPanel)
    expect(panel.active).toBeNull()
    panel.show('settings')
    expect([panel.active, $('.detail-panel__title').textContent]).toEqual(['settings', 'Settings'])
    panel.show('help')
    expect([panel.active, $('.detail-panel__title').textContent]).toEqual(['help', 'Help'])
    $('.detail-panel__close').click()
    expect(fc.calls).toEqual([{ kind: 'toggle_detail', arg: 'help' }])
    panel.hide()
    expect(panel.active).toBeNull()
  })

  it('refresh updates the settings view only while it is shown', async () => {
    const { panel, model, root } = await setup(DetailPanel)
    const zoom = (): string => requireEl<HTMLSelectElement>(root, '#sv-zoom').value
    const initial = zoom()
    panel.refresh(model, UI)
    expect(zoom()).toBe(initial)
    panel.show('settings')
    panel.refresh(model, UI)
    expect(zoom()).toBe('1.15')
  })
})

describe('requireEl', () => {
  it('returns the match or throws naming the selector', () => {
    const root = document.createElement('div')
    root.innerHTML = '<button id="go">go</button>'
    expect(requireEl(root, '#go').textContent).toBe('go')
    expect(() => requireEl(root, '#missing')).toThrow('Element not found: #missing')
  })
})

