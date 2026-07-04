// End-to-end workflow tests over AppModel's public interface only: multi-step NORMAL and SCANNED
// pipelines with undo/redo in varying order, plus order-independence (permutability) of commuting
// operations. Uses the shared jsdom harness mock adapter (no real PDF.js/OpenCV).
import { describe, it, expect } from 'vitest'
import { make_model } from '../ui/harness'
import { Mode, FilterMode } from '@core/enums'
import type { AppModel } from '@core/model'

// Side-effect-free signature of the document/history state that these workflows move through.
interface Sig {
  view_total: number; page_count: number; split: number
  filter: FilterMode; strength: number; dewarp: boolean
  overlay: number; can_undo: boolean; can_redo: boolean
}
function sig(m: AppModel): Sig {
  return {
    view_total: m.view_total, page_count: m.page_count(), split: m.split_count,
    filter: m.filter_mode, strength: m.filter_strength, dewarp: m.dewarp_on,
    overlay: m.view_snapshot().overlay.length,
    can_undo: m.can_undo, can_redo: m.can_redo,
  }
}

// Commit a manual crop window via the drag gesture (pushes one history entry).
function draw_crop(m: AppModel): void {
  m.begin_drag(10, 10, 5)
  m.update_drag(150, 250)
  m.end_drag()
}

describe('NORMAL workflow — detect / crop / rotate with undo-redo round trips', () => {
  it('undo unwinds and redo replays a multi-step sequence exactly', async () => {
    const m = await make_model({ mode: Mode.NORMAL, page_count: 4 })
    m.set_undo_depth(8)
    const start = sig(m)

    await m.detect_content().result()
    m.apply_crop()
    m.rotate_pages()
    draw_crop(m)
    m.apply_crop()
    const end = sig(m)
    expect(m.can_undo).toBe(true)

    // Unwind everything, then replay everything: state must match at both ends.
    for (let i = 0; i < 8 && m.can_undo; i++) m.undo()
    expect(m.can_undo).toBe(false)
    expect(sig(m)).toEqual({ ...start, can_redo: true })

    for (let i = 0; i < 8 && m.can_redo; i++) m.redo()
    expect(sig(m)).toEqual(end)
  })

  it('interleaved undo/redo/new-op discards the redo stack (linear history)', async () => {
    const m = await make_model({ mode: Mode.NORMAL, page_count: 3 })
    m.set_undo_depth(8)
    draw_crop(m); m.apply_crop()      // op A
    m.rotate_pages()                  // op B
    m.undo()                          // back to A
    expect(m.can_redo).toBe(true)
    draw_crop(m); m.apply_crop()      // op C — must clear the B redo
    expect(m.can_redo).toBe(false)
  })
})

describe('SCANNED workflow — filter / dewarp / crop', () => {
  it('runs the full pipeline and round-trips through undo/redo', async () => {
    const m = await make_model({ mode: Mode.SCANNED, page_count: 3 })
    m.set_undo_depth(8)
    const start = sig(m)

    m.set_filter_mode(FilterMode.BW)
    m.set_filter_strength(3)
    m.run_dewarp()
    draw_crop(m); m.apply_crop()
    const end = sig(m)
    expect(end.filter).toBe(FilterMode.BW)
    expect(end.dewarp).toBe(true)

    for (let i = 0; i < 8 && m.can_undo; i++) m.undo()
    expect(sig(m)).toEqual({ ...start, can_redo: true })
    for (let i = 0; i < 8 && m.can_redo; i++) m.redo()
    expect(sig(m)).toEqual(end)
  })

  it('current view is never blank after a filter change (no "invisible page")', async () => {
    const m = await make_model({ mode: Mode.SCANNED, page_count: 3 })
    m.set_filter_mode(FilterMode.BW)
    await m.prepare_current_view()
    expect(m.view_snapshot().image).not.toBeNull()
  })
})

describe('permutability — order-independent operations reach the same state', () => {
  it('filter-mode then dewarp equals dewarp then filter-mode (SCANNED)', async () => {
    const a = await make_model({ mode: Mode.SCANNED, page_count: 2 })
    a.set_filter_mode(FilterMode.BW)
    a.run_dewarp()

    const b = await make_model({ mode: Mode.SCANNED, page_count: 2 })
    b.run_dewarp()
    b.set_filter_mode(FilterMode.BW)

    expect(a.filter_mode).toBe(b.filter_mode)
    expect(a.dewarp_on).toBe(b.dewarp_on)
  })

  it('split then anchor equals anchor then split (both pre-crop settings, NORMAL)', async () => {
    const a = await make_model({ mode: Mode.NORMAL, page_count: 2 })
    a.set_split(2); a.set_anchor(false, true)

    const b = await make_model({ mode: Mode.NORMAL, page_count: 2 })
    b.set_anchor(false, true); b.set_split(2)

    expect(a.split_count).toBe(b.split_count)
    expect(a.anchor_left).toBe(b.anchor_left)
    expect(a.anchor_top).toBe(b.anchor_top)
  })
})

describe('history depth bound', () => {
  it('undo cannot go past the configured depth', async () => {
    const m = await make_model({ mode: Mode.NORMAL, page_count: 5 })
    m.set_undo_depth(2)
    m.rotate_pages(); m.rotate_pages(); m.rotate_pages()   // 3 history entries, depth 2
    let steps = 0
    while (m.can_undo) { m.undo(); steps++ }
    expect(steps).toBeLessThanOrEqual(2)
  })
})
