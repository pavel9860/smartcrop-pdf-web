// Shared test doubles for src/core/ tests (AppModel and its extracted services) and, one layer up,
// tests/ui/harness.ts. The mock adapter is geometry-faithful (per-page sizes, rotation swaps the
// rendered raster, detection is region-aware) so every suite can share it; spy() records calls.
import { AppModel, type RendererAdapter, type PageSize, type OutputPage, type ExportSink } from '@core/model'
import { PageRasterPipeline, type RasterContext } from '@core/page_raster_pipeline'
import { PageIndexMap } from '@core/page_index_map'
import type { Box } from '@core/geometry'
import { Mode, PagesMode } from '@core/enums'

export const bmp = (w = 200, h = 300, close: () => void = () => undefined): ImageBitmap =>
  ({ width: w, height: h, close }) as unknown as ImageBitmap

export const FILE = (name = 'a.pdf'): File => new File(['x'], name, { type: 'application/pdf' })

export const INSET = 20
export const inset = (r: Box, d = INSET): Box => ({ x0: r.x0 + d, y0: r.y0 + d, x1: r.x1 - d, y1: r.y1 - d })

export interface AdapterOpts {
  page_count?: number
  mode?: Mode
  page_w?: number
  page_h?: number
  page_sizes?: PageSize[]
  synthetic?: boolean
}

export function make_adapter(opts: AdapterOpts = {}): RendererAdapter {
  const { page_count = 3, mode = Mode.NORMAL, page_w = 200, page_h = 300, synthetic } = opts
  const sizes = opts.page_sizes ?? Array.from({ length: page_count }, () => ({ width: page_w, height: page_h }))
  const full = (p: number): Box => ({ x0: 0, y0: 0, x1: sizes[p]!.width, y1: sizes[p]!.height })
  return {
    load_files: files => Promise.resolve({
      page_count: sizes.length, page_sizes: sizes, file_names: files.map(f => f.name), mode, ...(synthetic ? { synthetic } : {}),
    }),
    get_source_image: (p, _dpi, rotation) => {
      const { width: w, height: h } = sizes[p]!
      return Promise.resolve(rotation % 180 ? bmp(h, w) : bmp(w, h))
    },
    get_work_image: src => Promise.resolve(bmp(src.width, src.height)),
    rotate_bitmap: (b, degrees) => Promise.resolve(degrees % 180 ? bmp(b.height, b.width) : bmp(b.width, b.height)),
    render_output_image: (_s, box) =>
      Promise.resolve(bmp(Math.max(1, Math.round(box.x1 - box.x0)), Math.max(1, Math.round(box.y1 - box.y0)))),
    detect_content_box: (_i, w, h, _m, region) => Promise.resolve(inset(region ?? { x0: 0, y0: 0, x1: w, y1: h })),
    detect_text_box: (p, region) => Promise.resolve(inset(region ?? full(p))),
    begin_export: () => recording_sink(),
    make_synth_page: (_i, w, h) => Promise.resolve(bmp(w, h)),
    close: () => undefined,
  }
}

export type Calls = Record<string, unknown[][]>

// Wraps every adapter method to record its arguments: calls.get_source_image[i] = args of call i.
export function spy(adapter: RendererAdapter): { adapter: RendererAdapter; calls: Calls } {
  const calls: Calls = {}
  const wrapped = Object.fromEntries(Object.entries(adapter).map(([k, f]) => [k,
    (...args: unknown[]): unknown => { (calls[k] ??= []).push(args); return (f as (...a: unknown[]) => unknown)(...args) },
  ])) as unknown as RendererAdapter
  return { adapter: wrapped, calls }
}

export const n_calls = (calls: Calls, k: string): number => calls[k]?.length ?? 0

export async function loaded(a: RendererAdapter | AdapterOpts = {}): Promise<AppModel> {
  const m = new AppModel('load_files' in a ? a : make_adapter(a))
  await m.load_files([FILE()])
  return m
}

export function make_raster(
  adapter: RendererAdapter, pages: number | PageIndexMap = 1, ctx: Partial<RasterContext> = {},
): PageRasterPipeline {
  const idx = typeof pages === 'number' ? new PageIndexMap() : pages
  if (typeof pages === 'number') idx.reset(pages)
  return new PageRasterPipeline(adapter, idx, {
    mode: () => Mode.NORMAL, display_dpi: () => 96, is_synthetic: () => false, rotation: () => 0,
    process_intent: () => ({ dewarp: false, filter: null }), dewarp_supersample: () => 1, undo_depth: () => 2,
    ...ctx,
  })
}

export const round6 = (b: Box): Box => ({
  x0: +b.x0.toFixed(6), y0: +b.y0.toFixed(6), x1: +b.x1.toFixed(6), y1: +b.y1.toFixed(6),
})

export const boxes_of = (m: AppModel, kind: string): Box[] =>
  m.view_snapshot().overlay.filter(o => o.kind === kind).map(o => round6(o.box))

export const split_rects = (m: AppModel): Box[] => boxes_of(m, 'split')

export function overlay_box(m: AppModel, kind: string): Box {
  const b = boxes_of(m, kind)[0]
  if (!b) throw new Error(`no ${kind} overlay`)
  return b
}

export function draw(m: AppModel, x0: number, y0: number, x1: number, y1: number, tol = 5): void {
  m.begin_drag(x0, y0, tol); m.update_drag(x1, y1); m.end_drag()
}

export function select(m: AppModel, pattern: string): void {
  m.set_select_pattern(pattern); m.set_pages_mode(PagesMode.SELECT)
}

export function recording_sink(pages: OutputPage[] = [], bytes = new Uint8Array([1, 2, 3])): ExportSink {
  return {
    add: page => { pages.push(page); return Promise.resolve() },
    finish: () => Promise.resolve(bytes),
    abort: () => undefined,
  }
}

export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
}
