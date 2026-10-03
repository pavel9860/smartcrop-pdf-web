// AppModel through its public interface only: document lifecycle, navigation, page selection,
// history, output settings, rotate/delete, export and view preparation. Crop/detect/gestures live in
// model_detect.test.ts and model_gestures.test.ts, scan toggles in model_scan.test.ts.
import { describe, it, expect } from 'vitest'
import { AppModel, type RendererAdapter, type OutputPage, type VectorExportPage } from '@core/model'
import { Mode, FilterMode, PagesMode } from '@core/enums'
import { Ok, Failed, Cancelled } from '@core/batch'
import { NoDocumentError, EmptySelectionError, DeleteAllPagesError } from '@core/errors'
import {
  CUSTOM_DPI_MIN, CUSTOM_DPI_MAX, CUSTOM_PAPER_MIN, CUSTOM_PAPER_MAX, DEFAULT_CUSTOM_PAPER_IN,
  SRC_DPI, NORMAL_DPI, NORMAL_DISPLAY_DPI_MAX, DEWARP_SUPERSAMPLE_MAX, DEFAULT_DETECT_OUTLIER, PAPER_SIZES,
} from '@core/constants'
import {
  make_adapter, spy, n_calls, loaded, bmp, FILE, draw, select, recording_sink, round6,
} from './harness'

const A4 = PAPER_SIZES.A4.height_in
const dims = (m: AppModel): [number, number] => [m.view_snapshot().page_w, m.view_snapshot().page_h]

describe('document lifecycle', () => {
  it('with no document every query is empty and every command is a no-op or NoDocumentError', async () => {
    const m = new AppModel(make_adapter())
    expect([m.has_document, m.page_count(), m.resolve_pages(), m.document_name, m.mode])
      .toEqual([false, 0, [], '', Mode.NORMAL])
    expect(m.view_snapshot()).toMatchObject({ image: null, total: 0, overlay: [] })
    expect(m.suggested_export_name()).toMatch(/^document/)
    expect(m.estimate_export_bytes()).toBe(0)
    await m.prepare_current_view()
    await m.reset()
    expect(m.view_snapshot().image).toBeNull()
    for (const cmd of [() => m.detect_content(), () => m.export('x'), () => m.rotate_pages(), () => m.delete_pages()]) {
      expect(cmd).toThrow(NoDocumentError)
    }
    expect(() => { draw(m, 0, 0, 50, 50) }).not.toThrow()
  })

  it('load_files reports page count and document name; several files read "+N more"', async () => {
    const m = new AppModel(make_adapter({ page_count: 4 }))
    await m.load_files([FILE('scan.pdf')])
    expect([m.has_document, m.page_count(), m.document_name]).toEqual([true, 4, 'scan.pdf'])
    await m.load_files([FILE('a.pdf'), FILE('b.pdf'), FILE('c.pdf')])
    expect(m.document_name).toBe('a.pdf +2 more')
  })

  it('reset re-opens the same files and clears interaction state', async () => {
    const { adapter, calls } = spy(make_adapter())
    const m = await loaded(adapter)
    m.set_split(2)
    m.rotate_pages()
    await m.reset()
    expect([m.split_count, m.can_undo, n_calls(calls, 'load_files')]).toEqual([1, false, 2])
    expect(dims(m)).toEqual([200, 300])
  })

  it('a synthetic (placeholder) document renders via make_synth_page, never get_source_image', async () => {
    const { adapter, calls } = spy(make_adapter({ page_count: 1, synthetic: true }))
    const m = await loaded(adapter)
    await m.prepare_current_view()
    expect([n_calls(calls, 'make_synth_page'), n_calls(calls, 'get_source_image')]).toEqual([1, 0])
  })
})

describe('navigation', () => {
  it('next/prev/jump move between output pages and clamp at both ends', async () => {
    const m = await loaded({ page_count: 5 })
    expect([m.view_position, m.view_total]).toEqual([1, 5])
    m.prev_page()
    expect(m.view_position).toBe(1)
    for (let i = 0; i < 9; i++) m.next_page()
    expect(m.view_position).toBe(5)
    m.jump_to_output_page(3)
    expect(m.view_position).toBe(3)
    m.jump_to_output_page(999)
    expect(m.view_position).toBe(5)
    m.jump_to_output_page(-5)
    expect(m.view_position).toBe(1)
  })

  it('committed split pages multiply the output pages navigation walks', async () => {
    const m = await loaded({ page_count: 3 })
    m.set_split(2)
    m.apply_crop()
    expect(m.view_total).toBe(6)
    for (let i = 0; i < 10; i++) m.next_page()
    expect(m.view_position).toBe(6)
  })

  it('leaving split mode from a late split view keeps the position on the same source page', async () => {
    const m = await loaded({ page_count: 4 })
    m.set_split(4)
    m.apply_crop()
    m.jump_to_output_page(11)
    m.set_split(1)
    expect([m.view_position, m.view_total]).toEqual([3, 4])
  })

  it('undo of a split crop keeps showing the same source page', async () => {
    const m = await loaded({ page_count: 3 })
    m.jump_to_output_page(2)
    m.set_split(2)
    m.apply_crop()
    expect(m.view_position).toBe(3)
    m.undo()
    expect(m.view_position).toBe(2)
  })
})

describe('page selection', () => {
  it('resolve_pages follows ALL / ODD / EVEN / SELECT', async () => {
    const m = await loaded({ page_count: 6 })
    const got = (mode: PagesMode): number[] => { m.set_pages_mode(mode); return m.resolve_pages() }
    expect(got(PagesMode.ALL)).toEqual([0, 1, 2, 3, 4, 5])
    expect(got(PagesMode.ODD)).toEqual([0, 2, 4])
    expect(got(PagesMode.EVEN)).toEqual([1, 3, 5])
    m.set_select_pattern('2-4')
    expect(got(PagesMode.SELECT)).toEqual([1, 2, 3])
  })

  it('an empty selection makes every page command raise EmptySelectionError', async () => {
    const m = await loaded({ page_count: 4, mode: Mode.SCANNED })
    select(m, '99')
    expect(m.resolve_pages()).toEqual([])
    for (const cmd of [() => m.detect_content(), () => m.rotate_pages(), () => m.run_dewarp(), () => m.set_filter_strength(2)]) {
      expect(cmd).toThrow(EmptySelectionError)
    }
  })

  it('current-page follow selects the current page, re-syncs on navigation, and ends on a manual edit', async () => {
    const m = await loaded({ page_count: 10 })
    m.jump_to_output_page(3)
    m.set_current_follow(true)
    expect([m.pages_mode, m.select_pattern]).toEqual([PagesMode.SELECT, '3'])
    m.next_page()
    expect(m.select_pattern).toBe('4')
    m.prev_page(); m.prev_page()
    expect([m.select_pattern, m.resolve_pages()]).toEqual(['2', [1]])
    m.set_select_pattern('5-6')
    expect(m.current_follow).toBe(false)
    m.set_current_follow(true)
    m.set_pages_mode(PagesMode.ALL)
    expect(m.current_follow).toBe(false)
  })
})

describe('history', () => {
  it('a drawn window is not undoable; Crop is, and undo/redo toggle it', async () => {
    const m = await loaded()
    draw(m, 10, 10, 150, 250)
    expect(m.can_undo).toBe(false)
    m.apply_crop()
    expect([m.can_undo, m.document.applied.size]).toEqual([true, 3])
    m.undo()
    expect([m.can_redo, m.document.applied.size]).toEqual([true, 0])
    m.redo()
    expect(m.document.applied.size).toBe(3)
  })

  it('set_split drops committed crops and undo restores them exactly', async () => {
    const m = await loaded({ page_count: 2 })
    draw(m, 10, 10, 150, 250)
    m.apply_crop()
    m.set_split(2)
    expect(m.document.applied.size).toBe(0)
    m.undo()
    expect([...m.document.applied]).toEqual([0, 1].map(p => [p, [{ x0: 10, y0: 10, x1: 150, y1: 250 }]]))
  })

  it('a new committing action clears the redo stack', async () => {
    const m = await loaded()
    draw(m, 10, 10, 150, 250); m.apply_crop()
    m.rotate_pages()
    m.undo()
    expect(m.can_redo).toBe(true)
    draw(m, 20, 20, 140, 240); m.apply_crop()
    expect(m.can_redo).toBe(false)
  })

  it('undo depth bounds the reversible steps exactly', async () => {
    const m = await loaded()
    m.set_undo_depth(2)
    m.rotate_pages(); m.rotate_pages(); m.rotate_pages()
    let steps = 0
    while (m.can_undo) { m.undo(); steps++ }
    expect(steps).toBe(2)
    expect(dims(m)).toEqual([300, 200])
  })

  it('anchors and output settings sit outside history', async () => {
    const m = await loaded()
    m.set_output_colours('Grayscale')
    draw(m, 10, 10, 150, 250); m.apply_crop()
    m.set_anchor(false, false)
    m.undo()
    expect([m.anchor_left, m.anchor_top, m.output_colours]).toEqual([false, false, 'Grayscale'])
  })

  for (const mode of [Mode.NORMAL, Mode.SCANNED]) {
    it(`${mode}: undoing every step then redoing every step lands on the same states`, async () => {
      const m = await loaded({ page_count: 4, mode })
      m.set_undo_depth(8)
      const sig = (): string => JSON.stringify([m.view_total, m.page_count(), m.split_count, m.filter_mode,
        m.filter_strength, m.dewarp_on, m.view_snapshot().overlay.length, dims(m)])
      const start = sig()
      if (mode === Mode.SCANNED) { m.set_filter_mode(FilterMode.BW); m.set_filter_strength(3); m.run_dewarp() }
      await m.detect_content().result()
      m.apply_crop()
      m.rotate_pages()
      draw(m, 10, 10, 150, 250); m.apply_crop()
      const end = sig()
      while (m.can_undo) m.undo()
      m.cancel_drag()
      expect(sig()).toBe(start)
      while (m.can_redo) m.redo()
      expect(sig()).toBe(end)
    })
  }
})

describe('rotate / delete', () => {
  it('rotate swaps page dims, four rotations restore them, undo reverts one', async () => {
    const m = await loaded()
    m.rotate_pages()
    expect(dims(m)).toEqual([300, 200])
    m.undo()
    expect(dims(m)).toEqual([200, 300])
    for (let i = 0; i < 4; i++) m.rotate_pages()
    expect(dims(m)).toEqual([200, 300])
  })

  it('delete removes the selection, refuses to delete everything, and undo restores without re-rendering', async () => {
    const { adapter, calls } = spy(make_adapter({ page_count: 4 }))
    const m = await loaded(adapter)
    expect(() => { m.delete_pages() }).toThrow(DeleteAllPagesError)
    draw(m, 20, 20, 120, 220)
    select(m, '2'); m.apply_crop()
    m.set_pages_mode(PagesMode.ALL)
    for (let p = 1; p <= 4; p++) { m.jump_to_output_page(p); await m.prepare_current_view() }
    const renders = n_calls(calls, 'get_source_image')

    m.jump_to_output_page(3)
    select(m, '1-2'); m.delete_pages()
    expect([m.page_count(), m.view_position]).toEqual([2, 1])
    m.undo()
    expect([m.page_count(), m.view_position]).toEqual([4, 3])
    m.jump_to_output_page(2)
    await m.prepare_current_view()
    expect(m.view_snapshot().page_w).toBe(100)
    expect(n_calls(calls, 'get_source_image')).toBe(renders)
    m.redo()
    expect(m.page_count()).toBe(2)
  })
})

describe('output settings', () => {
  it('setters accept known values, reject unknown ones and clamp numbers', async () => {
    const m = await loaded()
    m.set_compress_preset('nope')
    expect(m.compress_preset).not.toBe('nope')
    m.set_compress_preset('Medium — 150 dpi')
    m.set_export_format('nope')
    m.set_export_format('JPG')
    m.set_paper_size('A2')
    m.set_paper_size('nope')
    m.set_output_postfix('_x')
    expect([m.compress_preset, m.export_format, m.paper_size, m.output_postfix])
      .toEqual(['Medium — 150 dpi', 'JPG', 'A2', '_x'])
    expect([m.custom_paper_in, m.detect_outlier_pages]).toEqual([DEFAULT_CUSTOM_PAPER_IN, DEFAULT_DETECT_OUTLIER])
    const clamps: [(v: number) => void, () => number, number, number][] = [
      [v => { m.set_custom_dpi(v) }, () => m.custom_dpi, 999999, CUSTOM_DPI_MAX],
      [v => { m.set_custom_dpi(v) }, () => m.custom_dpi, 1, CUSTOM_DPI_MIN],
      [v => { m.set_custom_paper_in(v) }, () => m.custom_paper_in, 9999, CUSTOM_PAPER_MAX],
      [v => { m.set_custom_paper_in(v) }, () => m.custom_paper_in, -5, CUSTOM_PAPER_MIN],
      [v => { m.set_dewarp_supersample(v) }, () => m.dewarp_supersample, 99, DEWARP_SUPERSAMPLE_MAX],
      [v => { m.set_detect_outlier_pages(v) }, () => m.detect_outlier_pages, -5, 0],
      [v => { m.set_detect_outlier_pages(v) }, () => m.detect_outlier_pages, 2.7, 3],
    ]
    for (const [set, get, input, want] of clamps) { set(input); expect(get()).toBe(want) }
  })

  async function export_long_px(setup: (m: AppModel) => void): Promise<{ long: (number | null)[]; grey: boolean[] }> {
    const { adapter, calls } = spy(make_adapter())
    const m = await loaded(adapter)
    draw(m, 10, 10, 150, 250); m.apply_crop()
    setup(m)
    await m.export('out.pdf').result()
    const args = calls['render_output_image'] ?? []
    return { long: args.map(a => a[4] as number | null), grey: args.map(a => a[5] as boolean) }
  }

  it('export long side = DPI × paper height; Custom DPI/paper honoured; Original keeps source size', async () => {
    const cases: [(m: AppModel) => void, number | null][] = [
      [m => { m.set_compress_preset('High — 300 dpi') }, Math.round(300 * A4)],
      [m => { m.set_compress_preset('Low — 75 dpi') }, Math.round(75 * A4)],
      [m => { m.set_compress_preset('Custom'); m.set_custom_dpi(600) }, Math.round(600 * A4)],
      [m => { m.set_compress_preset('High — 300 dpi'); m.set_paper_size('Custom'); m.set_custom_paper_in(20) }, 6000],
      [m => { m.set_compress_preset('Original resolution') }, null],
    ]
    for (const [setup, want] of cases) expect((await export_long_px(setup)).long).toEqual([want, want, want])
  })

  it('output quality applies to export only — the committed-crop preview stays full resolution and colour', async () => {
    const { adapter, calls } = spy(make_adapter({ page_count: 1 }))
    const m = await loaded(adapter)
    m.set_compress_preset('Low — 75 dpi')
    m.set_output_colours('Grayscale')
    draw(m, 10, 10, 150, 250); m.apply_crop()
    await m.prepare_current_view()
    expect(calls['render_output_image']?.map(a => [a[4], a[5]])).toEqual([[null, false]])
    await m.export('out.pdf').result()
    expect(calls['render_output_image']?.at(-1)?.slice(4)).toEqual([Math.round(75 * A4), true])
  })
})

describe('export', () => {
  it('suggested name derives from the first file, the postfix and the format extension', async () => {
    const m = await loaded()
    const names = (['PDF', 'JPG', 'PNG', 'TIFF'] as const).map(f => { m.set_export_format(f); return m.suggested_export_name() })
    expect(names).toEqual(['a_cropped.pdf', 'a_cropped.jpg', 'a_cropped.png', 'a_cropped.tif'])
  })

  it('PDF goes to the PDF handler; image formats go to one zip named without the extension', async () => {
    const m = await loaded({ page_count: 2 })
    const got: [string, string][] = []
    m.set_download_handlers(() => { got.push(['pdf', '']) }, (_b, base) => { got.push(['zip', base]) })
    await m.export('out.pdf').result()
    for (const f of ['JPG', 'PNG', 'TIFF']) { m.set_export_format(f); await m.export(`doc.${f.toLowerCase()}`).result() }
    expect(got).toEqual([['pdf', ''], ['zip', 'doc'], ['zip', 'doc'], ['zip', 'doc']])
  })

  it('exports committed crops at crop size and never applies an uncommitted auto-crop', async () => {
    const pages: OutputPage[] = []
    const m = await loaded({ ...make_adapter({ page_count: 2 }), begin_export: () => recording_sink(pages) })
    await m.detect_content().result()
    select(m, '1'); m.apply_crop()
    expect((await m.export('out.pdf').result())).toBeInstanceOf(Ok)
    expect(pages.map(p => [p.bitmap.width, p.bitmap.height])).toEqual([[160, 260], [200, 300]])
  })

  it('progress counts output pages for every format', async () => {
    const m = await loaded({ page_count: 3 })
    m.set_split(2); m.apply_crop()
    for (const f of ['PDF', 'JPG']) { m.set_export_format(f); expect(m.export('out').total).toBe(6) }
  })

  it('NORMAL PDF uses the adapter vector path with one entry per source page', async () => {
    let received: readonly VectorExportPage[] = []
    const m = await loaded({ ...make_adapter({ page_count: 2 }), export_pdf_vector: p => { received = p; return Promise.resolve(new Uint8Array([7])) } })
    let bytes: Uint8Array | null = null
    m.set_download_handlers(b => { bytes = b }, () => undefined)
    expect(await m.export('a.pdf').result()).toBeInstanceOf(Ok)
    expect([received.length, bytes]).toEqual([2, new Uint8Array([7])])
  })

  it('a failure in render, sink or vector assembly resolves Failed; cancel during vector assembly downloads nothing', async () => {
    const boom = (): Promise<never> => Promise.reject(new Error('boom'))
    const failing: Partial<RendererAdapter>[] = [
      { render_output_image: boom },
      { begin_export: () => ({ ...recording_sink(), finish: boom }) },
      { export_pdf_vector: boom },
    ]
    for (const f of failing) expect(await (await loaded({ ...make_adapter(), ...f })).export('a.pdf').result()).toBeInstanceOf(Failed)

    const m = await loaded({ ...make_adapter(), export_pdf_vector: () => new Promise(r => setTimeout(() => { r(new Uint8Array([1])) }, 5)) })
    const downloads: unknown[] = []
    m.set_download_handlers(b => downloads.push(b), b => downloads.push(b))
    const job = m.export('a.pdf')
    job.cancel()
    expect(await job.result()).toBeInstanceOf(Cancelled)
    expect(downloads).toEqual([])
  })

  it('estimate_export_bytes scales with the pages left', async () => {
    const m = await loaded({ page_count: 4 })
    m.set_export_format('PNG')
    const four = m.estimate_export_bytes()
    expect(four).toBeGreaterThan(0)
    select(m, '1'); m.delete_pages()
    expect(m.estimate_export_bytes()).toBeCloseTo(four * 3 / 4)
  })
})

describe('view preparation', () => {
  it('the image is null until prepare_current_view fetches it, in both modes and on committed pages', async () => {
    for (const mode of [Mode.NORMAL, Mode.SCANNED]) {
      const m = await loaded({ mode })
      expect(m.view_snapshot().image).toBeNull()
      await m.prepare_current_view()
      expect(m.view_snapshot().image).not.toBeNull()
      draw(m, 10, 10, 150, 250); m.apply_crop()
      await m.prepare_current_view()
      expect(m.view_snapshot()).toMatchObject({ page_w: 140, page_h: 240, image: { width: 140, height: 240 } })
    }
  })

  const supersede: Record<string, (m: AppModel) => void> = {
    navigate: m => { m.jump_to_output_page(2) },
    rotate: m => { m.rotate_pages() },
    delete: m => { select(m, '1'); m.delete_pages(); m.set_pages_mode(PagesMode.ALL) },
  }
  for (const [name, act] of Object.entries(supersede)) {
    it(`a late fetch started before ${name} never replaces the newer view`, async () => {
      let release = (): void => undefined
      const gate = new Promise<void>(r => { release = r })
      const base = make_adapter({ page_sizes: [{ width: 200, height: 300 }, { width: 201, height: 300 }, { width: 202, height: 300 }] })
      let first = true
      const m = await loaded({
        ...base,
        get_source_image: async (p, dpi, rot) => { if (first) { first = false; await gate } return base.get_source_image(p, dpi, rot) },
      })
      const stale = m.prepare_current_view()
      act(m)
      await m.prepare_current_view()
      const shown = m.view_snapshot().image
      release()
      await stale
      expect(m.view_snapshot().image).toBe(shown)
      expect(shown?.width).toBe(name === 'rotate' ? 300 : 201)
    })
  }

  it('NORMAL display scale picks the render DPI, clamped, only re-rendering for a >10% sharper need', async () => {
    const { adapter, calls } = spy(make_adapter({ page_count: 1 }))
    const m = await loaded(adapter)
    const dpis = async (scale: number): Promise<unknown[]> => {
      m.set_display_scale(scale)
      const before = n_calls(calls, 'get_source_image')
      await m.prepare_current_view()
      return (calls['get_source_image'] ?? []).slice(before).map(a => a[1])
    }
    expect(await dpis(0)).toEqual([NORMAL_DPI])
    expect(await dpis(151 / 72)).toEqual([])
    expect(await dpis(3)).toEqual([216])
    expect(await dpis(1)).toEqual([])
    expect(await dpis(1000)).toEqual([NORMAL_DISPLAY_DPI_MAX])
  })

  it('SCANNED ignores display scale — the source always renders at SRC_DPI', async () => {
    const { adapter, calls } = spy(make_adapter({ page_count: 1, mode: Mode.SCANNED }))
    const m = await loaded(adapter)
    m.set_display_scale(10)
    await m.prepare_current_view()
    expect(calls['get_source_image']?.map(a => a[1])).toEqual([SRC_DPI])
  })

  it('split and drawn windows are page-proportional across mixed page sizes', async () => {
    const mixed = (): Promise<AppModel> => loaded({ page_sizes: [{ width: 600, height: 800 }, { width: 150, height: 150 }] })
    const a = await mixed()
    a.set_split(2)
    a.jump_to_output_page(2)
    expect(a.view_snapshot().overlay.map(o => round6(o.box)))
      .toEqual([{ x0: 0, y0: 0, x1: 75, y1: 150 }, { x0: 75, y0: 0, x1: 150, y1: 150 }])

    const b = await mixed()
    draw(b, 300, 400, 600, 800, 8)
    b.apply_crop()
    b.jump_to_output_page(2)
    const v = b.view_snapshot()
    expect([v.crop_origin.x, v.crop_origin.y, v.page_w, v.page_h].map(n => +n.toFixed(6))).toEqual([75, 75, 75, 75])
  })

  it('invalidating committed previews (Rotate) closes every one, and the snapshot never shows a closed bitmap', async () => {
    const closed: number[] = []
    let n = 0
    const m = await loaded({ ...make_adapter({ page_count: 1 }), render_output_image: () => { const i = n++; return Promise.resolve(bmp(50, 50, () => closed.push(i))) } })
    m.set_split(4)
    m.apply_crop()
    for (let pos = 1; pos <= 4; pos++) { m.jump_to_output_page(pos); await m.prepare_current_view() }
    expect(closed).toEqual([])
    m.rotate_pages()
    expect(closed.sort()).toEqual([0, 1, 2, 3])
    expect(m.view_snapshot().image).toBeNull()
  })
})
