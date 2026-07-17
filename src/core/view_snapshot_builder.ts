// ViewSnapshotBuilder (§18 AppModel decomposition, extra step beyond the original 7 — needed to
// get model.ts under the 600-line limit) — computes ViewSnapshot from current state (spec-web
// §W8). Synchronous; reads only pre-fetched bitmaps from the raster cache (prepare_current_view()
// must run first, still owned by AppModel, since it's async cache-warming, not view computation).
import type { Box } from './geometry'
import { box_width, box_height, auto_crop_rect, keep_ratio_normalise } from './geometry'
import type { DocumentState } from './document_state'
import { view_to_source } from './viewmodel'
import { SYNTH_W, SYNTH_H } from './constants'
import type { PageSize, ViewSnapshot, OverlayBox } from './model'
import type { PageRasterPipeline } from './page_raster_pipeline'
import type { CropController } from './crop_controller'

export interface ViewContext {
  document(): DocumentState
  page_dims(p: number): PageSize
  current_page(): number
  view_pos(): number
  view_total(): number
  page_count(): number
  drawn(): Box | null
  detected(p: number): Box | null
  union(): Box | null
  auto_active(): boolean
}

export class ViewSnapshotBuilder {
  constructor(
    private readonly _raster: PageRasterPipeline,
    private readonly _crop: CropController,
    private readonly _ctx: ViewContext,
  ) {}

  build(): ViewSnapshot {
    const p = this._ctx.current_page()
    const sz = this._ctx.page_dims(p)
    const view_pos = this._ctx.view_pos()
    const doc = this._ctx.document()
    const { split_idx } = view_to_source(view_pos, this._ctx.page_count(), doc.applied)

    const committed = doc.applied.get(p)

    // A committed page STAYS shown cropped — at the CROP box's own dimensions, origin at the box's
    // top-left (crop_origin, so canvas_view maps pointer/overlay into the cropped view) — even while
    // a drawn window exists: the new window is an outline OVER the cropped view with no zoom change
    // (frozen spec §9.3). A plain committed page carries no outline (bug 18); it only appears once a
    // window is being drawn. The crop unzooms only on Undo or a split-mode switch.
    if (committed && committed.length > 0) {
      const box = committed[Math.min(split_idx, committed.length - 1)] ?? committed[0]
      return {
        image:  this._raster.output_at(p, split_idx),
        page_w: box ? box_width(box)  : sz.width,
        page_h: box ? box_height(box) : sz.height,
        crop_origin: box ? { x: box.x0, y: box.y0 } : { x: 0, y: 0 },
        overlay: this._committed_overlay(box),
        draw_rect:  this._crop.draw_rect,
        position:   view_pos,
        total:      this._ctx.view_total(),
        is_loading: this._raster.is_loading,
      }
    }

    return {
      image:   this._raster.current,
      page_w:  sz.width,
      page_h:  sz.height,
      crop_origin: { x: 0, y: 0 },
      overlay: this._build_overlay(p),
      draw_rect:  this._crop.draw_rect,
      position:   view_pos,
      total:      this._ctx.view_total(),
      is_loading: this._raster.is_loading,
    }
  }

  // The outline shown over a committed (cropped) page: only the drawn window, clamped to the crop
  // box so it can never paint outside the cropped view (spec-web §6.3). Empty when no window is
  // being drawn (a plain committed crop shows no frame — bug 18).
  private _committed_overlay(box: Box | undefined): OverlayBox[] {
    const drawn = this._ctx.drawn()
    if (!drawn || !box) return []
    return [{ kind: 'committed', box: {
      x0: Math.max(box.x0, Math.min(drawn.x0, box.x1)),
      y0: Math.max(box.y0, Math.min(drawn.y0, box.y1)),
      x1: Math.max(box.x0, Math.min(drawn.x1, box.x1)),
      y1: Math.max(box.y0, Math.min(drawn.y1, box.y1)),
    } }]
  }

  private _build_overlay(p: number): OverlayBox[] {
    const out: OverlayBox[] = []
    const doc = this._ctx.document()

    if (this._crop.split_count > 1) {
      for (let i = 0; i < doc.crop_rects.length; i++) {
        const box = doc.crop_rects[i]
        if (box) out.push({ kind: 'split', box, idx: i + 1 })
      }
      return out
    }

    // Global drawn window (pending crop) — outline on every page, clamped to it; overrides the
    // auto/committed display until Crop maps it in.
    const drawn = this._ctx.drawn()
    if (drawn) {
      const sz = this._ctx.page_dims(p)
      out.push({ kind: 'committed', box: {
        x0: Math.max(0, Math.min(drawn.x0, sz.width)),
        y0: Math.max(0, Math.min(drawn.y0, sz.height)),
        x1: Math.max(0, Math.min(drawn.x1, sz.width)),
        y1: Math.max(0, Math.min(drawn.y1, sz.height)),
      } })
      return out
    }

    const committed = doc.applied.get(p)
    if (committed) {
      for (const box of committed) out.push({ kind: 'committed', box })
      return out
    }

    const live = this.live_auto_crop_for(p)
    if (live) {
      out.push({ kind: 'auto', box: live })
      return out
    }

    return out
  }

  // Exposed (not just an internal helper): ExportService's _export_boxes_for_page needs the SAME
  // live-auto-crop resolution for the vector/raster export path.
  live_auto_crop_for(p: number): Box | null {
    const detected = this._ctx.detected(p)
    const union    = this._ctx.union()
    if (!detected || !union || !this._ctx.auto_active()
        || !(this._crop.anchor_left || this._crop.anchor_top)) return null
    const sz = this._ctx.page_dims(p)
    let rect = auto_crop_rect(detected, union, this._ctx.document().offsets,
      sz.width, sz.height, this._crop.anchor_left, this._crop.anchor_top)
    if (this._crop.keep_ratio) rect = keep_ratio_normalise(rect, this._crop.ratio, sz.width, sz.height)
    return rect
  }

  synth_snapshot(): ViewSnapshot {
    return {
      image: null, page_w: SYNTH_W, page_h: SYNTH_H, crop_origin: { x: 0, y: 0 },
      overlay: [], draw_rect: null, position: 1, total: 0,
      is_loading: false,
    }
  }
}
