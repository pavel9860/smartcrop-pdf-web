// Public contract types for AppModel/RendererAdapter (ARCHITECTURE §5, §5a) — split out of
// model.ts (which re-exports all of these) purely to keep that file under the project's line
// limit; no behavior here, type declarations only.

import type { Box } from './geometry'
import type { PageProcessIntent } from './document_state'
import type { Mode } from './enums'

// ---------------------------------------------------------------------------
// Injected async adapter (keeps core/ DOM-free, fully unit-testable with mocks)
// ---------------------------------------------------------------------------

export interface PageSize { width: number; height: number }

export interface DocInfo {
  page_count: number
  page_sizes: PageSize[]
  file_names: string[]   // for window title / suggested export name
  mode: Mode
  // True only for the no-file-open placeholder document (spec-web §1). Pages of a
  // synthetic doc have no PageSource; they must render via make_synth_page, not
  // get_source_image. Omitted (falsy) for every real load.
  synthetic?: boolean
}

export interface OutputPage {
  bitmap: ImageBitmap
  width:  number
  height: number
}

// One source page's vector-export instructions (spec-web §W9.3). `boxes` is normally length 1;
// a split page (crop_rects committed as N boxes) becomes N output pages from the SAME source.
// page_w/page_h/rotation are the page's CURRENT (already rotation-adjusted) values, i.e. exactly
// what _page_dims/document.rotation already carry — the adapter converts back to the source's
// native frame itself (geometry.ts::to_native_frame), core/ does not need to know that frame exists.
export interface VectorExportPage {
  readonly orig_page: number
  readonly boxes:     readonly Box[]
  readonly page_w:    number
  readonly page_h:    number
  readonly rotation:  number
}

export interface RendererAdapter {
  load_files(files: File[]): Promise<DocInfo>
  get_source_image(page_idx: number, dpi: number, rotation: number): Promise<ImageBitmap>
  // Scan processing (dewarp/filter) applied to an ALREADY-rendered source bitmap. Taking the
  // source (not a page index) means the model renders each page exactly once and hands that raster
  // straight to processing — no second internal rasterization (spec-web §W2 row 5). With a no-op
  // intent (no dewarp, no filter) this returns `source` itself, not a fresh bitmap — deliberate,
  // to avoid a pointless copy on the common case — so a caller must never close the result while
  // still holding `source` for its own use (same aliasing contract as `rotate_bitmap` below).
  get_work_image(source: ImageBitmap, intent: PageProcessIntent,
                 supersample: number): Promise<ImageBitmap>
  // Re-orients an already-processed bitmap (e.g. a cached Dewarp&Deskew result) without
  // re-deriving it — used so rotate never re-runs dewarp's ONNX pass (spec-web §7). Unlike the
  // source-render path baking rotation into a fresh, single-use render, `bitmap` here may be a
  // cached, reused resource, so this must never close/consume it.
  rotate_bitmap(bitmap: ImageBitmap, degrees: number): Promise<ImageBitmap>
  // target_long_px: export sizing — the crop's long side scales to this many pixels
  // (= dpi × paper height, spec-web §W2 row 8); null = keep source resolution (and preview).
  render_output_image(src: ImageBitmap, box: Box, page_w: number, page_h: number,
                      target_long_px: number | null, greyscale: boolean): Promise<ImageBitmap>
  // `region`, if given (split 2/4 per-region detect, spec §5a), scopes detection to that
  // page-unit sub-rectangle instead of the whole page; the returned box is still in page (not
  // region-local) coordinates.
  detect_content_box(img: ImageBitmap, page_w: number, page_h: number, mode: Mode, region?: Box): Promise<Box>
  // Fast NORMAL-mode detection from the PDF text layer (desktop detect.py normal_page_box) — no
  // image processing. Optional: absent/returns null → caller falls back to detect_content_box.
  detect_text_box?(page_idx: number, region?: Box): Promise<Box | null>
  export_pdf(pages: OutputPage[]): Promise<Uint8Array>
  // Lossless vector PDF export for NORMAL-mode documents (spec-web §W9.3): crops/rotates/splits
  // via the ORIGINAL PDF page content (pdf-lib embedPage), never rasterizes. Optional — an adapter
  // without it (test mocks) simply means AppModel falls back to the raster export path.
  export_pdf_vector?(pages: readonly VectorExportPage[]): Promise<Uint8Array>
  export_images(
    pages: OutputPage[], format: 'JPG' | 'PNG' | 'TIFF', base: string,
    on_progress?: (done: number, total: number) => void,
  ): Promise<Uint8Array>
  make_synth_page(idx: number, w: number, h: number): Promise<ImageBitmap>
  close(): void
}

// ---------------------------------------------------------------------------
// ViewSnapshot — what canvas_view reads (frozen bundle)
// ---------------------------------------------------------------------------

export type OverlayKind = 'auto' | 'split' | 'committed'

export interface OverlayBox {
  readonly kind:  OverlayKind
  readonly box:   Box
  readonly idx?:  number   // 1-based split index (split mode)
}

export interface ViewSnapshot {
  readonly image:      ImageBitmap | null   // null = loading
  readonly page_w:     number
  readonly page_h:     number
  // Top-left of the coordinate space page_w/page_h/overlay/draw_rect live in, in full-page units.
  // {0,0} for a full page; the committed box's origin on a committed (cropped) page so canvas_view
  // can map pointer input and paint overlays into the zoomed cropped view (spec-web §W8).
  readonly crop_origin: { readonly x: number; readonly y: number }
  readonly overlay:    readonly OverlayBox[]
  readonly draw_rect:  Box | null
  readonly position:   number               // 1-based output-page
  readonly total:      number
  readonly is_loading: boolean
}
