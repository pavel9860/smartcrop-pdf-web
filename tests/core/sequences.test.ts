// Seeded random action sequences through AppModel's public interface only, checking spec-web §21
// invariants after every step. A failure prints the seed + the action log, which replays exactly.
import { describe, it, expect } from 'vitest'
import { AppModel, type RendererAdapter } from '@core/model'
import { Mode, FilterMode, PagesMode } from '@core/enums'
import { Failed, type BatchJob } from '@core/batch'
import { SmartCropError } from '@core/errors'
import type { Box } from '@core/geometry'
import { make_adapter, FILE, recording_sink, rng } from './harness'

const SIZES = [{ width: 200, height: 300 }, { width: 420, height: 297 }, { width: 150, height: 150 }, { width: 612, height: 792 }]
const EPS = 1e-6

interface Harness { adapter: RendererAdapter; violations: string[]; exported: () => number }

function adapter(mode: Mode, page_count: number): Harness {
  const base = make_adapter({ mode, page_sizes: Array.from({ length: page_count }, (_, i) => SIZES[i % SIZES.length]!) })
  const violations: string[] = []
  let exported = 0
  const inside = (b: Box, w: number, h: number): boolean =>
    b.x0 >= -EPS && b.y0 >= -EPS && b.x1 <= w + EPS && b.y1 <= h + EPS && b.x1 > b.x0 && b.y1 > b.y0
  return {
    violations,
    exported: () => exported,
    adapter: {
      ...base,
      render_output_image: (src, box, w, h, ...rest) => {
        if (!inside(box, w, h)) violations.push(`render box ${JSON.stringify(box)} outside ${w}x${h}`)
        if (Math.abs(src.width / src.height - w / h) > 0.02) violations.push(`raster ${src.width}x${src.height} vs page ${w}x${h}`)
        return base.render_output_image(src, box, w, h, ...rest)
      },
      detect_content_box: (_i, w, h, _mode, region) => {
        const r = region ?? { x0: 0, y0: 0, x1: w, y1: h }
        const dx = (r.x1 - r.x0) * 0.1, dy = (r.y1 - r.y0) * 0.1
        return Promise.resolve({ x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 - dx, y1: r.y1 - dy })
      },
      detect_text_box: (_i, region) => Promise.resolve(region ?? null),
      begin_export: () => { exported = 0; return { ...recording_sink(), add: () => { exported++; return Promise.resolve() } } },
      export_pdf_vector: pages => { exported = pages.reduce((n, p) => n + p.boxes.length, 0); return Promise.resolve(new Uint8Array([1])) },
    },
  }
}

function state(m: AppModel): string {
  const v = m.view_snapshot()
  return JSON.stringify({
    n: m.page_count(), total: m.view_total, dewarp: m.dewarp_on, filter: m.filter_mode, strength: m.filter_strength,
    offsets: m.offsets, split: m.split_count, page: v.position <= v.total,
  })
}

async function run_job(job: BatchJob, log: string[]): Promise<void> {
  const r = await job.result()
  if (r instanceof Failed) throw new Error(`batch failed: ${String(r.error)}\n${log.join('\n')}`)
}

type Step = (m: AppModel, r: () => number, log: string[]) => Promise<void> | void

const STEPS: Record<string, Step> = {
  next: m => { m.next_page() },
  prev: m => { m.prev_page() },
  jump: (m, r) => { m.jump_to_output_page(1 + Math.floor(r() * m.view_total)) },
  select: (m, r) => {
    const n = m.page_count(), a = 1 + Math.floor(r() * n)
    m.set_select_pattern(r() < 0.5 ? String(a) : `${a}-${n}`)
    m.set_pages_mode(PagesMode.SELECT)
  },
  all: m => { m.set_pages_mode(PagesMode.ALL) },
  follow: (m, r) => { m.set_current_follow(r() < 0.5) },
  detect: (m, _r, log) => run_job(m.detect_content(), log),
  crop: m => { if (m.can_apply) m.apply_crop() },
  split: (m, r) => { m.set_split(([1, 2, 4] as const)[Math.floor(r() * 3)]!) },
  same_size: (m, r) => { m.set_same_size(r() < 0.5) },
  keep_ratio: (m, r) => { m.set_keep_ratio(r() < 0.5, 0.5 + r()) },
  anchor: (m, r) => { m.set_anchor(r() < 0.5, r() < 0.5) },
  offset: (m, r) => { m.set_drawn_offset((['L', 'T', 'R', 'B'] as const)[Math.floor(r() * 4)]!, Math.round(r() * 40)) },
  drag: (m, r) => {
    const v = m.view_snapshot()
    const pt = (): [number, number] => [v.crop_origin.x + r() * v.page_w, v.crop_origin.y + r() * v.page_h]
    m.begin_drag(...pt(), 8)
    m.update_drag(...pt())
    if (r() < 0.9) m.end_drag(); else m.cancel_drag()
  },
  rotate: m => { m.rotate_pages() },
  delete: m => { if (m.resolve_pages().length < m.page_count()) m.delete_pages() },
  dewarp: (m, _r, log) => m.mode === Mode.SCANNED ? run_job(m.run_dewarp(), log) : undefined,
  filter: (m, r, log) => m.mode === Mode.SCANNED
    ? run_job(m.set_filter_mode([FilterMode.NONE, FilterMode.BW, FilterMode.SHARPEN][Math.floor(r() * 3)]!), log) : undefined,
  undo_redo: (m, _r, log) => {
    if (!m.can_undo) return
    const before = state(m)
    m.undo()
    if (m.can_redo) {
      m.redo()
      if (state(m) !== before) throw new Error(`undo+redo changed state\n${before}\n${state(m)}\n${log.join('\n')}`)
    }
  },
  undo: m => { if (m.can_undo) m.undo() },
  format: (m, r) => { m.set_export_format(['PDF', 'JPG', 'PNG', 'TIFF'][Math.floor(r() * 4)]!) },
  save: async (m, _r, log) => { await run_job(m.export('out'), log) },
}
const NAMES = Object.keys(STEPS)

async function check(m: AppModel, h: Harness, log: string[]): Promise<void> {
  await m.prepare_current_view()
  const v = m.view_snapshot()
  const where = `\n${log.join('\n')}`
  expect(v.total, where).toBe(m.view_total)
  expect(v.position >= 1 && v.position <= v.total, `position ${v.position}/${v.total}${where}`).toBe(true)
  expect(v.image, `no image after prepare${where}`).not.toBeNull()
  if (v.image) {
    const { width: w, height: h } = v.image
    expect(Math.max((w - 1) / v.page_w, (h - 1) / v.page_h) <= Math.min((w + 1) / v.page_w, (h + 1) / v.page_h),
      `image ${v.image.width}x${v.image.height} vs page ${v.page_w}x${v.page_h}${where}`).toBe(true)
  }
  for (const o of v.overlay) {
    const b = o.box, x = v.crop_origin.x, y = v.crop_origin.y
    expect(b.x0 >= x - EPS && b.y0 >= y - EPS && b.x1 <= x + v.page_w + EPS && b.y1 <= y + v.page_h + EPS,
      `${o.kind} ${JSON.stringify(b)} outside page ${v.page_w}x${v.page_h}@${x},${y}${where}`).toBe(true)
  }
  expect(h.violations, where).toEqual([])
}

async function run_sequence(seed: number, mode: Mode, steps: number): Promise<void> {
  const r = rng(seed)
  const h = adapter(mode, 2 + Math.floor(r() * 4))
  const m = new AppModel(h.adapter)
  await m.load_files([FILE()])
  const log = [`seed=${seed} mode=${mode}`]
  for (let i = 0; i < steps; i++) {
    const name = NAMES[Math.floor(r() * NAMES.length)]!
    log.push(name)
    try {
      await STEPS[name]!(m, r, log)
    } catch (e) {
      if (!(e instanceof SmartCropError)) throw e
      log.push(`  -> ${e.constructor.name}`)
    }
    if (name === 'save') expect(h.exported(), `saved pages vs view total\n${log.join('\n')}`).toBe(m.view_total)
    await check(m, h, log)
  }
}

describe('random action sequences keep §21 invariants', () => {
  for (const mode of [Mode.NORMAL, Mode.SCANNED]) {
    it(`${mode}: 150 seeded sequences x 40 steps`, async () => {
      for (let seed = 1; seed <= 150; seed++) await run_sequence(seed * 7919 + (mode === Mode.SCANNED ? 1 : 0), mode, 40)
    }, 60_000)
  }
})
