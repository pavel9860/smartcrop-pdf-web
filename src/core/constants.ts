// Domain constants — single source of truth (spec-web §17).
// UI-only tunables live in ui/constants.ts.

// DPI / raster
export const SRC_DPI    = 150.0   // scanned-mode source render DPI — fixed, never display-scaled
                                   // (the scan pipeline's perf budgets are tuned against it, §16)
export const NORMAL_DPI = 150.0   // normal-mode baseline/minimum render DPI
// Normal-mode preview re-renders sharper than NORMAL_DPI when the canvas' actual display size
// needs it (spec-web §2) — never below NORMAL_DPI, never above this cap (bounds memory/CPU on an
// extreme window size or devicePixelRatio).
export const NORMAL_DISPLAY_DPI_MAX = 450.0
// Raster cache capacity is NOT a separate constant: each page's own source/work version history
// is bounded by (Undo/redo-depth setting + 1) — the current combination plus as many prior ones as
// Undo can still reach (spec-web §7, §12) — so it never needs to be kept in sync with a second,
// duplicate "how much history" number.

// Batch-loop paint yield (model.ts detect/warm/export loops): yield to the event loop only if
// this much wall time has elapsed since the last yield from the same loop, not once per item
// unconditionally — a run of many fast items no longer pays the ~4ms setTimeout-clamp floor once
// per item, while a run of slow items (each already over this) still yields every item.
export const PAINT_YIELD_INTERVAL_MS = 100

// Crop geometry (canvas-unit / page-unit tunables)
export const HANDLE_R     = 10    // handle hit-radius px
export const HANDLE_SLACK = 6     // extra tolerance around handle
export const CANVAS_MARGIN = 0    // page fills the canvas height edge-to-edge (bug 9, desktop parity)
export const OFFSET_LIMIT  = 100.0 // max ±% for any single edge offset
export const MANUAL_OFFSET_DEFAULT = 10.0 // manual-offsets mode's predefined margin, % per edge

// Classification / detection thresholds (spec §4, §8)
export const MODE_TEXT_MIN  = 8       // chars below this = image-only page
export const DETECT_MAX_PX  = 1400   // downscale long edge to this before detect
export const BORDER_FRAC    = 0.02   // outer margin excluded from component keep
export const MIN_COMP_FRAC  = 2.5e-4 // component area fraction threshold
export const FULL_PAGE_FRAC = 0.97   // box >= this fraction of page → fallback, excluded from aggregate

// Pre-labeling merge (spec §8): individual glyphs rarely touch their neighbours at DETECT_MAX_PX
// resolution, so without this every letter is its own connected component and none clears
// MIN_COMP_FRAC on its own — real body text was being discarded entirely, leaving only incidental
// large components (a rule line, an image) to define the content box. A horizontal-biased
// morphological close bridges inter-letter/inter-word gaps so a text LINE becomes one component,
// without merging separate lines into one paragraph-sized blob. Width in scaled-canvas px.
export const DETECT_CLOSE_W = 9
export const DETECT_CLOSE_H = 3

// Auto-detect outlier tolerance (spec-web §5): detection_union's W/H use the (N+1)-th largest
// per-page dimension instead of always the max, so N oversized pages don't inflate every crop.
// N=0 = unchanged (max). Settings dropdown preset list.
export const DETECT_OUTLIER_OPTIONS: readonly number[] = [0, 1, 2, 5, 10]
export const DEFAULT_DETECT_OUTLIER = 2

// Deskew
export const DESKEW_MAX_DEG = 15.0

// Filter strengths (spec §10.2) — Sharpen unsharp amount per level
export const CLEAN_AMOUNT: Record<1 | 2 | 3, number> = { 1: 0.6, 2: 1.1, 3: 1.6 }
export const FILTER_STRENGTH_MIN = 1
export const FILTER_STRENGTH_MAX = 3

// OpenCV.js tuning (pdf/imaging.ts). Mirrors desktop core/imaging.py's real Sauvola
// pipeline (_sauvola_threshold via box-filtered local mean/stddev, DPI-scaled kernels) —
// ported faithfully via cv.boxFilter, not approximated by cv.adaptiveThreshold.
export const CC_CONNECTIVITY = 8   // connectedComponentsWithStats connectivity

// Sauvola threshold: T = mean * (1 + k * (std/SAUVOLA_R - 1)); ink = flat < T (imaging.py:20-35)
export const SAUVOLA_R = 127.5
export const SAUVOLA_WINDOW = 51        // base window size @ 150 DPI reference, scaled by DPI (odd)
export const BG_KERNEL_SIZE = 51        // illumination-flatten morphology kernel, same DPI scaling
// The illumination background is low-frequency, so its 51×51 morphological close is computed on a
// 1/BG_DOWNSCALE copy then upscaled (spec-web §W2 row 12). opencv.js's single-thread WASM morphology
// is O(pixels × kernel_area) with no large-kernel optimization — full-res it costs 0.6–9 s/page and
// dominates both the B/W filter and Auto-detect; the downscale makes it ~36× cheaper for ≈0 change in
// the final bilevel. 4 was measured to add no extra bilevel error vs the full-res result.
export const BG_DOWNSCALE = 4

// B/W (bilevel) filter strength -> (sauvola k, min despeckle area at DPI=150). imaging.py:40-44.
export const BW_STRENGTH: Record<1 | 2 | 3, { k: number; minArea: number }> = {
  1: { k: 0.060, minArea: 20 },   // cautious — keep faint strokes, light despeckle
  2: { k: 0.110, minArea: 40 },   // normal
  3: { k: 0.180, minArea: 90 },   // aggressive — kill speckle, risk thinning
}

// Sharpen strength -> bilateral denoise + unsharp blur radius. Strength drives denoise
// AND the unsharp radius, not just CLEAN_AMOUNT's gain — matches imaging.py:50-54
// (regression fix: a fixed-denoise Sharpen amplified scan noise at high strength).
export const SHARPEN_STRENGTH: Record<1 | 2 | 3, {
  d: number; sigmaColor: number; sigmaSpace: number; blurSigma: number
}> = {
  1: { d: 5, sigmaColor: 25, sigmaSpace: 25, blurSigma: 1.2 },   // cautious
  2: { d: 5, sigmaColor: 40, sigmaSpace: 40, blurSigma: 2.0 },   // normal
  3: { d: 7, sigmaColor: 60, sigmaSpace: 60, blurSigma: 2.8 },   // aggressive
}

// DPI scale for pixel-defined kernels, clamped (imaging.py:81-86 _dpi_scale). Reference DPI
// for detect_content is NORMAL_DPI-independent (detect always downscales to DETECT_MAX_PX
// first, so DPI scale there is 1.0); the B/W filter runs at SRC_DPI and scales from 150.
export const SAUVOLA_DPI_REFERENCE = 150.0
export const SAUVOLA_DPI_SCALE_MIN = 0.5
export const SAUVOLA_DPI_SCALE_MAX = 4.0

// Split count ceiling (set_split accepts 1 | 2 | 4)
export const MAX_SPLIT = 4

// Synthetic document
export const SYNTH_PAGES = 1     // single blank placeholder page before any file is loaded (bug 4)
export const SYNTH_W = 595   // A4 @ 72dpi points
export const SYNTH_H = 842

// Synthetic placeholder page styling — not a UI concern (pdf/ cannot import ui/constants.ts;
// dependency graph is one-directional, see ARCHITECTURE §4), so it lives here next to SYNTH_*.
export const SYNTH_BG_COLOR     = '#f8f8f8'
export const SYNTH_BORDER_COLOR = '#cccccc'
export const SYNTH_TEXT_COLOR   = '#aaaaaa'
export const SYNTH_FONT         = '24px sans-serif'
export const SYNTH_PADDING      = 10

// Compress presets: name → output DPI (null = original resolution)
export const DPI_PRESETS: Record<string, number | null> = {
  'Original resolution': null,
  'High — 300 dpi':    300,
  'Medium — 150 dpi':  150,
  'Low — 75 dpi':       75,
}

// Custom output resolution (task 15): a 'Custom' compress preset resolved against settings.custom_dpi
// instead of DPI_PRESETS. Export-only, like every other output-quality setting (spec-web §W2 row 8).
export const CUSTOM_DPI_PRESET = 'Custom'
export const DEFAULT_CUSTOM_DPI = 300
export const CUSTOM_DPI_MIN = 50
export const CUSTOM_DPI_MAX = 1200

// Output paper sizes (spec-web §W2 row 8): the export raster's long side = dpi × height_in —
// each output page's long side is assumed to be the paper height. Settings → Output option.
export const PAPER_SIZES = {
  A2: { width_in: 16.54, height_in: 23.39 },
  A3: { width_in: 11.69, height_in: 16.54 },
  A4: { width_in: 8.27, height_in: 11.69 },
  A5: { width_in: 5.83, height_in: 8.27 },
  A6: { width_in: 4.13, height_in: 5.83 },
} as const
export const DEFAULT_PAPER = 'A4'

// Custom paper height (task #6): a 'Custom' paper_size resolved against settings.custom_paper_in
// (inches) instead of PAPER_SIZES — same reveal/resolve pattern as CUSTOM_DPI_PRESET above.
export const CUSTOM_PAPER_PRESET = 'Custom'
export const DEFAULT_CUSTOM_PAPER_IN = PAPER_SIZES.A4.height_in
export const CUSTOM_PAPER_MIN = 1
export const CUSTOM_PAPER_MAX = 60

// Export format names. Image formats (JPG/PNG/TIFF) deliver a single zip archive; TIFF is
// hand-encoded (baseline RGB) since canvas has no native TIFF path.
export const EXPORT_FORMATS = ['PDF', 'JPG', 'PNG', 'TIFF'] as const
export type ExportFormat = typeof EXPORT_FORMATS[number]

// Accepted input extensions for the file picker
export const IMAGE_LOAD_EXT = ['.pdf', '.jpg', '.jpeg', '.png', '.tif', '.tiff'] as const

// JPEG quality for embedding in PDF output (0–1)
export const JPEG_QUALITY = 0.92

// Default settings
export const DEFAULT_COMPRESS_PRESET  = 'Original resolution'
export const DEFAULT_OUTPUT_COLOURS   = 'Original colors'
export const DEFAULT_EXPORT_FORMAT: ExportFormat = 'PDF'
export const DEFAULT_OUTPUT_POSTFIX   = '_cropped'
export const DEFAULT_UNDO_DEPTH       = 2
export const UNDO_DEPTH_OPTIONS: readonly number[] = [1, 2, 4, 8]
export const UNDO_DEPTH_MIN = 1
export const UNDO_DEPTH_MAX = 50
export const DEFAULT_DEWARP_SUPERSAMPLE = 2.0
export const DEWARP_SUPERSAMPLE_MIN = 1.0
export const DEWARP_SUPERSAMPLE_MAX = 4.0

// Dewarp model (pdf/imaging.ts) — pstwh/docuwarp, a two-stage ONNX pipeline: uvdoc.onnx (a CNN
// predicting a coarse warp-field grid) + bilinear_unwarping.onnx (GridSample-based resampler).
// DEWARP_MODEL_W/H are the CNN's FIXED input size baked into the trained weights (docuwarp
// Unwarp.image_size = (488, 712), PIL (width, height) order) — not tunable, not a style choice.
export const DEWARP_MODEL_W = 488
export const DEWARP_MODEL_H = 712
// Relative to the deployment base (import.meta.env.BASE_URL, prepended in pdf/imaging.ts) so the
// models resolve under a GitHub Pages project-page subpath, not the domain root. No leading slash.
export const DEWARP_UVDOC_URL          = 'models/uvdoc.onnx'
export const DEWARP_BILINEAR_URL       = 'models/bilinear_unwarping.onnx'
export const DEWARP_UVDOC_CACHE_KEY    = 'docuwarp-uvdoc-v1'
export const DEWARP_BILINEAR_CACHE_KEY = 'docuwarp-bilinear-v1'
