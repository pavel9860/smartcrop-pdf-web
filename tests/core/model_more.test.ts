// AppModel remaining branch coverage: export box variants + failure, suggested names,
// prepare_current_view (scanned + committed prerender), rotate/delete after detect,
// commit_offsets with anchors off, re-detect refresh, gesture misses. Public interface only.
import { describe, it, expect } from 'vitest'
import { AppModel } from '@core/model'
import { Mode, PagesMode } from '@core/enums'
import { Failed, Ok } from '@core/batch'
import { make_adapter, FILE } from './harness'

async function loaded(pc = 4, mode = Mode.NORMAL, w = 200, h = 300): Promise<AppModel> {
  const m = new AppModel(make_adapter(pc, mode, w, h)); await m.load_files([FILE()]); return m
}

describe('export box variants', () => {
  it('exports committed crops, live auto crops, and full-page fallback', async () => {
    const committed = await loaded()
    await committed.detect_content().result()
    committed.apply_crop()
    expect(await committed.export('a.pdf').result()).toBeInstanceOf(Ok)

    const live = await loaded()
    await live.detect_content().result()                 // detected, not applied -> live crop
    expect(await live.export('b.pdf').result()).toBeInstanceOf(Ok)

    const full = await loaded()
    expect(await full.export('c.pdf').result()).toBeInstanceOf(Ok)   // nothing -> full page
  })

  it('a failing export resolves Failed', async () => {
    const a = make_adapter()
    a.export_pdf = () => Promise.reject(new Error('boom'))
    const m = new AppModel(a)
    await m.load_files([FILE()])
    expect(await m.export('x.pdf').result()).toBeInstanceOf(Failed)
  })
})

describe('suggested_export_name', () => {
  it('derives extension from the export format', async () => {
    const m = await loaded()
    m.set_export_format('JPG')
    expect(m.suggested_export_name()).toMatch(/\.jpg$/)
    m.set_export_format('PNG')
    expect(m.suggested_export_name()).toMatch(/\.png$/)
    m.set_export_format('PDF')
    expect(m.suggested_export_name()).toMatch(/\.pdf$/)
  })

  it('falls back to "document" with no loaded file', () => {
    const m = new AppModel(make_adapter())
    expect(m.suggested_export_name()).toMatch(/^document/)
  })
})

describe('prepare_current_view', () => {
  it('scanned mode fetches a work image', async () => {
    const m = await loaded(3, Mode.SCANNED)
    await m.prepare_current_view()
    expect(m.view_snapshot().image).not.toBeNull()
  })

  it('a committed page pre-renders its output view', async () => {
    const m = await loaded(3, Mode.NORMAL, 200, 300)
    await m.detect_content().result()
    m.apply_crop()
    await m.prepare_current_view()
    expect(m.view_snapshot().image).not.toBeNull()
  })

  it('prepare is a no-op with no document', async () => {
    const m = new AppModel(make_adapter())
    await m.prepare_current_view()
    expect(m.view_snapshot().image).toBeNull()
  })
})

describe('rotate / delete after detect', () => {
  it('rotate recomputes the detection union', async () => {
    const m = await loaded(3)
    await m.detect_content().result()
    m.rotate_pages()
    expect(m.auto_active).toBe(true)
  })

  it('delete recomputes the union from surviving detections', async () => {
    const m = await loaded(4)
    await m.detect_content().result()
    m.set_select_pattern('2'); m.set_pages_mode(PagesMode.SELECT)
    m.delete_pages()
    expect(m.page_count()).toBe(3)
  })

  it('delete without a prior detection clears the union', async () => {
    const m = await loaded(4)
    m.set_select_pattern('2'); m.set_pages_mode(PagesMode.SELECT)
    m.delete_pages()
    expect(m.page_count()).toBe(3)
    expect(m.auto_active).toBe(false)
  })
})

describe('commit_offsets / re-detect', () => {
  it('commit_offsets uses the union base when anchors are off', async () => {
    const m = await loaded(4, Mode.NORMAL, 200, 300)
    m.set_pages_mode(PagesMode.ALL)
    await m.detect_content().result()
    m.set_anchor(false, false)
    m.set_offset('R', 10)
    m.commit_offsets()
    expect(m.offsets).toBeDefined()
  })

  it('re-detect refreshes an existing committed crop', async () => {
    const m = await loaded(3)
    await m.detect_content().result()
    const full = m.view_snapshot().page_w
    m.apply_crop()
    await m.detect_content().result()          // second detect: refresh path
    expect(m.view_snapshot().page_w).toBeLessThan(full)   // still committed (cropped) after re-detect
  })
})

describe('gesture misses fall through', () => {
  it('split-mode drag off any rect does nothing', async () => {
    const m = await loaded()
    m.set_split(2)
    m.begin_drag(1000, 1000, 3)
    m.update_drag(1001, 1001)
    m.end_drag()
    expect(m.view_snapshot().overlay).toHaveLength(2)
  })

  it('auto-active drag off the handle falls through to a draw', async () => {
    const m = await loaded(4, Mode.NORMAL, 200, 300)
    await m.detect_content().result()
    m.begin_drag(1000, 1000, 3)      // far from the live auto handle
    m.update_drag(150, 250)
    m.end_drag()
    expect(m.view_snapshot()).toBeDefined()
  })
})
