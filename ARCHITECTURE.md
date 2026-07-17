# SmartCrop PDF Web — Architecture

Status: **implemented (beta), architecture under active correction.**

**Document split:** behavior and mechanism are two documents.
- `docs/SmartCrop_PDF_Specification_Web.md` — behavioral contract.
- **This file** — mechanism only: module layout, PDF/imaging stack, worker model, state ownership,
  build/test/deploy. If a fact describes what the user experiences, it belongs in the spec document
  above, not here. `docs/smartcrop_web_function_map.md` is the third: the canonical per-file
  function/line-number reference — don't duplicate its tables here.

Where this document and the running code disagree rise an error and ask what to do. Never guess.

**Technology decisions (locked):**
- Language: TypeScript (strict mode, zero `any`)
- UI: Vanilla TS + DOM APIs, no framework runtime
- Build: Vite 5
- Image processing: OpenCV.js WASM (faithful box-filter Sauvola port — see §9)
- Dewarp: ONNX Runtime Web + docuwarp model  SIMD and Multi-threadin
- Tests: Vitest (unit) + Playwright (e2e)
- Deployment: GitHub Pages (static) + Cloudflare CDN
- TIFF export: supported via a hand-rolled baseline encoder (`src/workers/tiff.ts`, uncompressed
  8-bit RGB single strip). Image exports (JPG/PNG/TIFF) are packed into one `.zip` (`fflate`).

---

## 2. Target directory layout

```
C:/DOCS/Code/SmartCroPDF-Web/
  index.html                single HTML entry point
  vite.config.ts
  tsconfig.json             strict, paths aliased (@core, @pdf, @ui, @workers)
  package.json
  .eslintrc.ts              @typescript-eslint strict
  playwright.config.ts

  src/
    core/                   Framework-agnostic. Zero DOM, zero Worker API, zero pdf-lib, zero PDF.js.
                            Enforced by architecture test (§7). Pure TypeScript.

      constants.ts          All domain tunables:
                              SRC_DPI=150, NORMAL_DPI=150,
                              HANDLE_R=10, HANDLE_SLACK=6, CANVAS_MARGIN=0, MIN_RECT=5,
                              OFFSET_LIMIT=100, MODE_TEXT_MIN=8, DETECT_MAX_PX=1400,
                              BORDER_FRAC=0.02, MIN_COMP_FRAC=2.5e-4, FULL_PAGE_FRAC=0.97,
                              DESKEW_MAX_DEG=15, CLEAN_AMOUNT={1:0.6, 2:1.1, 3:1.6},
                              SYNTH_PAGES=1, SYNTH_W=595, SYNTH_H=842 (+ SYNTH_BG_COLOR etc. —
                              synthetic placeholder styling lives here, not ui/constants.ts,
                              because pdf/loader.ts cannot import ui/ — see §4 dependency graph),
                              DPI_PRESETS, EXPORT_FORMATS, IMAGE_LOAD_EXT,
                              PAPER_SIZES (A2-A6), CUSTOM_DPI_PRESET, DEFAULT_CUSTOM_DPI,
                              CUSTOM_DPI_MIN/MAX, CUSTOM_PAPER_PRESET, DEFAULT_CUSTOM_PAPER_IN,
                              CUSTOM_PAPER_MIN/MAX (paper-based export sizing, spec-web §10.4),
                              FILTER_STRENGTH_MIN/MAX, UNDO_DEPTH_MIN/MAX, MAX_SPLIT,
                              CC_CONNECTIVITY, SAUVOLA_R, SAUVOLA_WINDOW, BG_KERNEL_SIZE,
                              BG_DOWNSCALE, BW_STRENGTH (k + min-despeckle-area per level 1-3),
                              SHARPEN_STRENGTH (bilateral d/sigmaColor/sigmaSpace + unsharp blur
                              sigma per level), SAUVOLA_DPI_REFERENCE/SCALE_MIN/MAX — real
                              box-filter Sauvola parameters (§9), not adaptiveThreshold tuning

      enums.ts              Mode (NORMAL|SCANNED), FilterMode (NONE|BW|SHARPEN),
                              PagesMode (ALL|ODD|EVEN|SELECT) — string-backed enums

      errors.ts             SmartCropError, NoDocumentError, EmptySelectionError,
                              InvalidSplitError, DeleteAllPagesError, DocumentLoadError,
                              ImagingError, MissingDependencyError

      geometry.ts           Box type, HandleId; hit_handle(), point_in_box(), clamp_box_shift(),
                              clamp_box_drag(), apply_handle_drag(), auto_crop_rect(),
                              offsets_from_rect(), detection_union(), union_box(),
                              keep_ratio_normalise(), keep_ratio_anchored() (ratio-preserving at
                              the page wall for every anchor case, spec-web §6.7), rotate_box_cw(),
                              rotate_box_ccw() (its algebraic inverse), to_native_frame()
                              (current display frame → source's native rotation=0 frame, used by
                              vector export, spec-web §10.3), edge_deltas() / apply_edge_deltas() /
                              clamp_edge_deltas() (same-size RESIZE propagation, gated to exclude
                              `move`, spec-web §6.6), split_rects_grid(), reindex_map(),
                              box_width()/box_height()/box_area() — pure math, no I/O.

      parsing.ts            resolve_pages(pattern, total, mode) → number[]
                              All/Odd/Even + pattern: ranges, slices (1:4, ::2, 10:), mixed

      lru.ts                LRUCache<K, V> — same eviction algorithm; stores ImageBitmap refs in scanned
                            mode and metadata of processing in normal mode.

      viewmodel.ts          output_page_count(), view_index_to_source(), source_to_view_range()
                              — committed-split pages expand to N views

      document_state.ts     Offsets (frozen), PageProcessIntent (frozen), DocumentState
                              (8 undoable fields: applied, crop_rects, rotation, processed,
                              offsets, dewarp_on, filter_mode, filter_strength + snapshot()).
                              detect_cache/union/auto_active/drawn are non-undoable AppModel
                              fields, not DocumentState fields (spec-web §12).

      settings.ts           Settings dataclass — compress_preset, custom_dpi, paper_size,
                              custom_paper_in, output_colours, export_format,
                              output_postfix, undo_depth, dewarp_supersample

      history.ts            History — bounded undo/redo of DocumentState snapshots, same interface

      drag.ts               AutoDrag | SplitDrag | DrawDrag | DrawnDrag — frozen tagged union

      batch.ts              BatchJob interface + BatchResult (Ok|Cancelled|Failed)
                              Web version: result() returns Promise<BatchResult>; progress via
                              onProgress(cb) callback instead of cooperative step()

      model.ts              AppModel — single facade,
                              Owns: document state, history, settings, drag, LRU caches.
                              All render/imaging calls go through pdf/ and workers/ via injected
                              async adapters (see §5).

    workers/                Web Workers — each a Vite `?worker` import, lazy-initialized.
                            Only one worker: export.worker.ts. pdf.js and OpenCV.js run on the
                            main thread instead (in `pdf/loader.ts` and `pdf/imaging.ts`
                            respectively) — see §7a for why.

      export.worker.ts      Raster export assembly — receives cropped ImageBitmap[] per output
                              page. PDF: encodes each to JPEG, builds a PDF via pdf-lib. JPG/PNG/
                              TIFF: encodes each page (TIFF via `workers/tiff.ts`'s hand-rolled
                              encoder) and packs all pages into one `.zip` (`fflate`). Used for
                              SCANNED-mode export (any format) and NORMAL-mode JPG/PNG/TIFF export.
                              NOT used for NORMAL-mode PDF export — see `loader.ts::export_pdf_vector`
                              below, which runs on the main thread instead (spec-web §10.3).
                              pdf-lib has zero `window`/`document` references, so it's Worker-safe
                              (unlike pdf.js/OpenCV.js — §7a).

    pdf/                    PDF.js + OpenCV.js adapters, running on the MAIN thread (§7a). May use
                            DOM (File, ArrayBuffer, Blob, URL, OffscreenCanvas) and import workers/.

      loader.ts             PdfRendererAdapter — the concrete `RendererAdapter` (§4/§5) injected
                              into AppModel — plus a generic `RpcWorker` id-correlated postMessage
                              helper used only for export.worker.ts now.
                              - load_files(files) → DocInfo: PDFs parsed directly via
                                `pdfjs.getDocument()` on this thread (with `cMapUrl`/
                                `standardFontDataUrl`/`useWorkerFetch` for correct glyph shaping
                                on complex/CID-keyed scripts — see §8.1a); images →
                                createImageBitmap directly, never native (§4). Aggregates to
                                NORMAL if any page native.
                              - get_source_image(page_idx, dpi, rotation) → `page.render()` onto
                                an OffscreenCanvas, then `rotate_bitmap_cw()` bakes the page's
                                current rotation angle into the pixels (§5a) before returning.
                              - get_work_image(source: ImageBitmap, intent, supersample) → source
                                bitmap unchanged if intent has no dewarp/filter, else
                                `pdf/imaging.ts`'s `process_page_async()` (same thread, no RPC).
                                Takes the already-rendered SOURCE bitmap, not a page index — each
                                page is rasterized once, by get_source_image, never twice.
                              - render_output_image(src, box, page_w, page_h, target_dpi,
                                greyscale) → Promise<ImageBitmap> — the WYSIWYG function (§8.3),
                                used by both canvas preview and export whenever export rasterizes
                                (SCANNED any format; NORMAL JPG/PNG/TIFF). Crops to box (page-unit →
                                source-pixel via `src.width / page_w`), resamples to target_dpi
                                (null = original), optionally desaturates. Runs on the main thread
                                via OffscreenCanvas.
                              - detect_content_box(img, page_w, page_h, mode) →
                                `pdf/imaging.ts`'s `detect_content_async()` (same thread). SCANNED
                                only — see detect_text_box below for NORMAL.
                              - detect_text_box(page_idx) → Box | null — NORMAL-mode fast path:
                                unions text-run bounding boxes straight from
                                `page.getTextContent()`, no rasterization, no OpenCV. Returns null
                                for a page with no usable text (image page, or a degenerate box);
                                AppModel records no detected box for that page rather than
                                rasterizing (spec-web §5).
                              - export_pdf(pages) / export_images(pages, format) → export.worker,
                                lazy-initialised on first export (the one real Worker left).
                              - export_pdf_vector(pages) → Promise<Uint8Array> — NORMAL-mode PDF
                                export (spec-web §10.3), main thread, no worker, no rasterization.
                                Unsplit pages (one crop window): `copyPages`+`setCropBox`+
                                `setRotation`, batched into ONE `copyPages()` call per source
                                document (not one per page) via `_copy_unsplit_pdf_pages`. Split
                                pages / image-sourced pages: `embedPage`/`embedPng`/`embedJpg`,
                                each source page embedded ONCE (not once per split box) and drawn N
                                times at a per-box offset. Both batching fixes address bug #7 (an
                                un-batched `copyPages`/`embedPage` call per page/box doesn't dedupe
                                a resource shared across them — measured ~19.5×/~3.6× bloat). One
                                pdf-lib parse per unique source PDF (`PDFDocumentProxy.getData()` →
                                `PDFDocument.load()`), cached across all of that file's exported
                                pages/boxes in one export call.
                              - make_synth_page(idx, w, h) — synthetic placeholder (§14), drawn
                                directly with Canvas API, no worker involved.

      imaging.ts             OpenCV.js scan processing (detect / filter), main thread.
                             Exposes `detect_content_async()` and `process_page_async()`,
                              called directly by loader.ts (no postMessage).
      cv.ts                  OpenCV.js runtime access point (`cv`, `Mat` type, `ensure_cv()`) —
                              shared by imaging.ts and dewarp.ts.
      dewarp.ts              docuwarp/UVDoc ONNX mesh dewarp: model loading + fp16 tensor
                              plumbing + the two-stage inference pipeline. Called from
                              imaging.ts's process_page_async()/process_page().
      idb.ts                 Generic IndexedDB open/request/transaction-wait helpers, used by
                              dewarp.ts's ONNX-model-weight cache (the only disk-cached asset —
                              per-page rasters are RAM-only, see §7).

    ui/                     Presentation layer. Imports @core/* and @pdf/*. core/ never imports ui/.
      constants.ts          UI-only tunables: SCALE_THROTTLE_MS=80, FONT_SIZE_DEFAULT=15, THEMES,
                              canvas overlay drawing tunables (dash patterns, line widths,
                              split-badge scale, status-text offsets — see canvas_view.ts). Sidebar
                              and detail-panel width are pure CSS (app.css `--sidebar-w`; the detail
                              panel matches it directly, no separate variable) — nothing in TS reads
                              them. CANVAS_MARGIN lives in core/constants.ts only, imported directly
                              by canvas_view.ts — not redefined here.

      dom.ts                 requireEl<E>(root, selector) — throws instead of a silent null;
                              replaces `querySelector(...)!` non-null assertions across every
                              panel (ESLint forbids `!`, ARCHITECTURE/CLAUDE.md forbid silent
                              failure). The one shared DOM lookup helper — do not reinvent it
                              per-file.

      app.ts                AppController — owns one AppModel, one RendererAdapter.
                              dispatch(cmd) and dispatch_job(make_job) — the only error-catch sites.
                              refresh_all() — reads model, re-renders canvas, updates all panels.
                              Manages three-column layout state (§3).

      canvas_view.ts        <canvas> element management:
                              - paint(snapshot: ViewSnapshot) — draws page bitmap + overlay boxes;
                                the only text is the bottom-right cursor DOM overlay — no status
                                element, nothing painted on the raster (spec-web §3, inv 32)
                              - Pointer events (pointerdown/move/up) → page-unit coords →
                                model.begin_drag / update_drag / end_drag / cancel_drag
                              - Wheel → next/prev page (spec-web §2)
                              - Resize observer → recompute scale, repaint
                              - Esc + right-click → cancel_drag() (spec-web §6.3)

      overlay.ts            Progress overlay — a <div> centred over the canvas, shown only when
                              batch total > 1. Displays title, determinate bar, page counter, Cancel.
                              Driven by BatchJob.onProgress(). Hides on job completion.

      panels/
        pages_panel.ts      "Document & State" + "Pages to Process" cards.
                              Load Files button (File input, multi-select, PDF+images).
                              Mode badge (NORMAL/SCANNED). All/Odd/Even/Selected buttons.
                              Pattern field + Current follow-toggle.

        crop_panel.ts       "Split Each Page Into" + "Detect Text Borders" + "Actions" cards.
                              Split 1/2/4 segmented; Same size toggle; Keep ratio + ratio field.
                              Auto-detect button; Anchor Left/Top toggles; Set offsets manual switch
                              (spec-web §4.6) + its L/T/R/B fields, all in the Detect Text Borders
                              card — replaces the old collapsible "Advanced" section.
                              Crop (full-width) + Rotate + Delete action buttons.

        scan_panel.ts       "Scan Processing" card — shown only in SCANNED mode.
                              Dewarp toggle; B/W / Sharpen buttons (mutually exclusive highlight);
                              Strength 1/2/3 buttons (always selectable).

        output_panel.ts     "Output Quality" + "Export" cards split
                              (`ui/panels.py`, titled "Output Quality" there).
                              DPI preset dropdown (+ Custom… numeric field) and Output colours
                              dropdown, hidden/disabled for a NORMAL document exporting to PDF
                              (spec-web §3, §10.3). Export button + adjacent format
                              `<select>` (PDF/JPG/PNG/TIFF), always visible.

        nav_bar.ts          Pinned bottom bar, three rows: Settings/Help buttons; Undo/Redo/Reset
                              (3 equal buttons); page nav < [n] / total >.
                              Always visible, outside scroll, one instance only.

      detail_panel.ts       A normal flex sibling between the sidebar and canvas, collapsed to
                              width:0 and grown to the sidebar's own width when Settings or Help is
                              active (§3.2) — reflows the canvas column, does not overlay it.
                              Renders either SettingsView or HelpView based on active state.
                              Dismissed by clicking Settings/Help button again, or Esc.

      settings_view.ts      Settings content rendered inside detail_panel:
                              Appearance (colour scheme, font size, zoom/UI scale);
                              Output (postfix, Custom DPI, paper size + Custom paper height);
                              Behaviour (remember last folder, undo/redo depth);
                              Scan (dewarp supersample).
                              Theme/font-size/zoom go through AppController's UIConfig setters
                              (`set_theme`, `set_font_size`, `zoom`/`set_ui_scale`,
                              `set_remember_folder` — §10); postfix, Custom DPI, paper size,
                              undo depth and dewarp supersample are domain `Settings` (§10) and go
                              through `AppModel` setters directly (`set_output_postfix`,
                              `set_custom_dpi`, `set_paper_size`, `set_custom_paper_in`,
                              `set_undo_depth`, `set_dewarp_supersample`) — there is no single
                              `apply_setting()` dispatcher; each field has its own typed setter on
                              the owner that actually holds it (§5.2's `Settings`-vs-`UIConfig`
                              split). The sidebar's Output Quality card and
                              Settings' Custom DPI write through the *same* AppModel setter
                              (`set_custom_dpi`), so either control always reflects the other.

      help_view.ts          Help content rendered inside detail_panel:
                              Heading + one-liner; Contents card (buttons scroll to sections);
                              Section blocks in spec-web §14 order.

      theme.ts              CSS custom property injection for dark/light/system themes.
                              Warm-gray chrome + blue accent(§19).

    main.ts                 Entry point: mounts AppController to #app, initialises synthetic doc.

  tests/
    core/                   Pure TS unit tests — Vitest, no DOM, workers mocked as interfaces.
                              One file per core/ module, plus *_edges.test.ts / *_more.test.ts /
                              *_gestures.test.ts siblings for branch coverage past the happy path.
    ui/                     DOM wiring tests — Vitest + jsdom, one file per ui/ component/panel.
    pdf/                    loader.ts/imaging.ts adapter tests (mocked PDF.js/OpenCV.js surfaces).
    e2e/                    Playwright, real Chromium + Firefox, real PDFs from tests/assets/ —
                              smoke, crop/split, committed-window, scan/SIMD flows.
    perf/                   Standalone perf suite (npm run test:perf), not part of `vitest run`.
    assets/                 Real PDFs + images used by tests (committed, small).
    architecture.test.ts    Import-graph guard: walk src/core/ TS files, fail if any import
                              contains 'window'|'document'|'Worker'|'pdfjs-dist'|'pdf-lib'
```

The exact file list above rots on every test addition — `ls tests/core tests/ui tests/e2e` for the
current, authoritative set rather than trusting an enumeration here.

---

## 3. Three-column layout — DOM/CSS mechanism

Behavior (card order/content, detail-panel open/close semantics, status-text placement) is
specified in `docs/SmartCrop_PDF_Specification_Web.md` spec-web §3 — this section is the CSS/DOM
implementation of that behavior only.

**Left sidebar** — fixed width `--sidebar-w` (app.css, 288px), `<div>` with `overflow-y: auto`.
Pinned bottom bar sits outside the scroll container as a sibling, not inside it.

**Detail panel** — a `<div>` between the sidebar and canvas. Collapsed state: `width: 0`. Open
state: `width: var(--sidebar-w)` for Settings — same width as the sidebar, no separate variable —
or `calc(var(--sidebar-w) * 1.5)` for Help (`.detail-panel.open.help-active`, toggled by
`DetailPanel.show()`), transitioned via CSS `transition: width 180ms ease`. Canvas column is
`flex: 1` so it fills whatever space remains (clamped to a 400px minimum in CSS) and reflows when
the panel's width changes. No modal, no overlay, no z-index stacking — the panel is a normal DOM
sibling.

**Status text** — one DOM overlay owned by `canvas_view.ts`, appended next to the canvas:
`_coords_el` (`.canvas-coords`, bottom-right cursor read-out), updated on `pointermove`. There is
no page/size status element. Nothing is painted onto the canvas bitmap.

---

## 4. Dependency graph

```
          src/core/        (zero DOM / Worker API / pdf-lib / pdfjs-dist — enforced §7)
            constants  enums  errors  geometry  parsing  lru  viewmodel    pure leaves
                           ▲
            document_state  settings  history  drag  batch                 pure
                           ▲
                        AppModel ◄── public surface
          ─────────────────────────────────────────────────── one direction only
          src/pdf/         (PDF.js + pdf-lib adapters; may use DOM + workers)
          src/workers/     (OpenCV.js, ONNX, pdf-lib — heavy, lazy-loaded, no core import)
          src/ui/          (DOM, canvas, panels; imports @core/* and @pdf/*)
                           │
                        main.ts
```

**Injected adapters pattern:** `AppModel` constructor receives a `RendererAdapter` interface
(defined in `core/model.ts`). `pdf/loader.ts`'s `PdfRendererAdapter` implements it. This keeps
`core/` free of PDF.js while `AppModel` can call "render this page" without knowing the
mechanism — and unit tests inject a mock that returns synthetic `ImageBitmap`s without a browser
(**no such mock exists yet** — `model.ts` is currently untested, see status table).

Actual interface (`core/model.ts`, kept current — this is the real signature list, not a sketch):

```ts
interface RendererAdapter {
  load_files(files: File[]): Promise<DocInfo>
  get_source_image(page_idx: number, dpi: number, rotation: number): Promise<ImageBitmap>
  get_work_image(page_idx: number, intent: PageProcessIntent, supersample: number,
                 rotation: number): Promise<ImageBitmap>
  render_output_image(src: ImageBitmap, box: Box, page_w: number, page_h: number,
                      target_dpi: number | null, greyscale: boolean): Promise<ImageBitmap>
  detect_content_box(img: ImageBitmap, page_w: number, page_h: number, mode: Mode): Promise<Box>
  export_pdf(pages: OutputPage[]): Promise<Uint8Array>
  export_images(pages: OutputPage[], format: 'JPG' | 'PNG' | 'TIFF', base: string): Promise<Uint8Array>  // single .zip
  make_synth_page(idx: number, w: number, h: number): Promise<ImageBitmap>
  close(): void
}
```

The `rotation` parameter on `get_source_image`/`get_work_image` is the page's current absolute
rotation angle (`document.rotation.get(p) ?? 0`, 0/90/180/270) — the adapter bakes it into the
returned raster (§5a). It is NOT incremental; each call passes the full current angle and the
adapter re-derives the raster from the unrotated source each time (caches are invalidated on
rotate)

---

## 5. AppModel — public interface (TypeScript)

Async only where the operation touches I/O or a worker.
Synchronous operations (navigation, offset edits, drag events, undo/redo) stay synchronous.

```ts
class AppModel {
  // document
  async load_files(files: File[]): Promise<void>     // raises DocumentLoadError
  async reset(): Promise<void>
  page_count(): number
  get has_document(): boolean
  get document_name(): string         // sidebar doc-name card, spec-web §3

  // navigation
  next_page(): void
  prev_page(): void
  jump_to_output_page(n: number): void
  get view_total(): number
  get view_position(): number

  // queries
  view_snapshot(): ViewSnapshot         // side-effect-free; returns frozen bundle
  get can_detect(): boolean
  get can_apply(): boolean
  get can_undo(): boolean
  get can_redo(): boolean
  get auto_active(): boolean
  get offsets(): Offsets
  get dewarp_on(): boolean
  get filter_mode(): FilterMode
  get filter_strength(): number
  // + split_count, mode, pages_mode, select_pattern, current_follow,
  //   keep_ratio, ratio, same_size, compress_preset, paper_size, custom_dpi, custom_paper_in,
  //   output_colours, export_format — all plain readonly properties

  // pages selection
  set_pages_mode(mode: PagesMode): void
  set_select_pattern(pattern: string): void
  set_current_follow(on: boolean): void
  resolve_pages(): number[]

  // crop / detect
  detect_content(): BatchJob              // raises EmptySelectionError; drives imaging.ts on the
                                           // main thread, not a worker (§7a)
  apply_crop(): void                      // raises InvalidSplitError / EmptySelectionError
  set_anchor(left: boolean | null, top: boolean | null): void
  set_offset(edge: 'L'|'T'|'R'|'B', value: number): void   // auto-crop offset (union-relative) —
  commit_offsets(): void                                   // UI trigger removed (spec-web §4.6 is
                                                             // now manual-offsets mode below); kept
                                                             // as a domain method, flagged to the
                                                             // user as a candidate for full removal
  set_manual_offsets_on(on: boolean): void   // spec-web §4.6 — page-relative, replaces "Advanced"
  set_manual_offset(edge: 'L'|'T'|'R'|'B', value: number): void
  set_keep_ratio(on: boolean, ratio?: number): void
  set_split(n: number): void
  set_same_size(on: boolean): void

  // gestures (page-unit coordinates)
  begin_drag(px: number, py: number, tol: number): void
  update_drag(px: number, py: number): void
  end_drag(): void
  cancel_drag(): void

  // scan processing
  run_dewarp(): BatchJob
  set_filter_mode(mode: FilterMode): BatchJob
  set_filter_strength(n: number): BatchJob

  // rotate / delete (§5a, §13)
  rotate_pages(): void                    // raises NoDocumentError / EmptySelectionError
  delete_pages(): void                    // raises DeleteAllPagesError

  // history
  undo(): void
  redo(): void

  // output settings (outside History — survive Undo)
  set_compress_preset(name: string): void
  set_paper_size(name: string): void  // PAPER_SIZES key or CUSTOM_PAPER_PRESET, spec-web §10.4
  set_custom_paper_in(height_in: number): void  // paper height (in) when paper_size === 'Custom'
  set_custom_dpi(dpi: number): void   // shared by sidebar Output Quality card + Settings → Output
  set_output_colours(mode: string): void
  set_export_format(fmt: string): void
  set_undo_depth(depth: number): void
  set_output_postfix(postfix: string): void
  set_dewarp_supersample(factor: number): void

  // export
  suggested_export_name(): string
  export(filename: string): BatchJob     // drives export.worker (raster path) or
                                          // loader.ts::export_pdf_vector (NORMAL+PDF, spec-web §10.3)
}
```

### 5a. Rotation pipeline

`rotate_pages()` mutates three things per page: the `document.rotation` angle map (+90° mod
360), the committed crop boxes (`document.applied`) and cached detected box (`AppModel._detect_cache`
— non-undoable, spec-web §12), both rotated 90° CW via `geometry.ts`'s `rotate_box_cw` using the
page's **effective dims from before this step** — see below), and invalidates that
page's source/work/output raster caches so the next render re-derives them.

The effective page size the rest of `AppModel` reads (`view_snapshot().page_w/page_h`, detect/
crop/split/offset math) comes from the private `_page_dims(p)` helper, not the raw stored
`doc.page_sizes[p]`: it swaps width/height when the page's current rotation is 90° or 270°.
Every call site that used to read `doc.page_sizes[p]` directly now goes through `_page_dims(p)`.

The actual pixel rotation happens in the adapter, not `core/` (which must stay DOM-free):
`pdf/loader.ts`'s `rotate_bitmap_cw()` draws the unrotated source raster onto a rotated,
dimension-swapped `OffscreenCanvas` via `ctx.translate()`/`ctx.rotate()`.
`AppModel._get_source()` passes the page's current
rotation angle into `get_source_image()` on every (cache-missed) call; `get_work_image()` takes the
already-rotated source bitmap, not a separate rotation parameter.

`ViewSnapshot` fields:
```ts
interface ViewSnapshot {
  image: ImageBitmap | null // page raster or committed-crop output image; null = loading
  page_w: number
  page_h: number
  overlay: readonly OverlayBox[]
  draw_rect: Box | null
  position: number          // 1-based output-page position
  total: number
  status: string            // page/size string; model-level only, not displayed (spec-web §3)
  crop_origin: {x: number, y: number}  // full-page-unit origin of shown image (spec-web §6.8)
  is_loading: boolean       // image=null + loading indicator
}
```

---

## 6. BatchJob — Promise-based cooperative model

Worker drives pages; main thread receives
`postMessage` progress events.

```ts
type BatchResult = Ok | Cancelled | Failed

interface BatchJob {
  readonly title: string
  readonly total: number
  readonly done: number       // updated by onProgress callbacks
  cancel(): void
  onProgress(cb: (done: number, total: number) => void): void
  result(): Promise<BatchResult>     // resolves when finished or cancelled
}
```

`AppController.dispatch_job(make_job: () => BatchJob)`:
```ts
async dispatch_job(make_job: () => BatchJob): Promise<void> {
  let job: BatchJob
  try { job = make_job() }         // pre-flight (EmptySelectionError etc.) — sync
  catch (e) { this.show_error(e); this.refresh_all(); return }

  this._current_job = job
  if (job.total > 1) this.overlay.show(job.title)
  this.refresh_all()                // busy = true → controls disable

  job.onProgress((done, total) => {
    this.overlay.update(done, total)
  })

  const result = await job.result()
  this.overlay.hide()
  this._current_job = null          // busy = false
  if (result instanceof Failed) this.show_error(result.error)
  this.refresh_all()
}
```

Single-page jobs (`total === 1`) suppress the overlay.

---

## 7. Worker protocol 

**Only `export.worker.ts` remains a real Worker** (see §7a for why pdf.js and OpenCV.js don't
run in one). It's a Vite `?worker` import, instantiated once on first `export()` call and reused:

```ts
// export.worker.ts protocol (RpcWorker in loader.ts)
type WorkerMsg = { id: number; type: 'ok'; payload: unknown }
               | { id: number; type: 'error'; message: string }
```

// Revise. Should be mo lazy workers. 
Each request carries a monotonic `id`; responses are matched by id. Pending promises are stored
in a `Map<number, {resolve, reject}>`. This gives a clean async/await surface with no polling.
`ImageBitmap`s are transferred (not cloned) via `postMessage(msg, [bitmap, ...])`; the returned
PDF/JPEG bytes come back as a transferred `ArrayBuffer`.

### 7. OpenCV.js build variant — SIMD, single-thread (?)


---

## 8. PDF reading and rendering

### 8.1 Classification (`pdf/loader.ts`, main thread — §7a)

Runs directly in `load_files()`, in the same `pdfjs.getDocument()` call that reads page sizes —
no RPC, no separate worker reply. Aggregates: any native page → `Mode.NORMAL`, else
`Mode.SCANNED`; image files always count as non-native.

```ts
// Mirrors spec-web §1 exactly (is_native_page() in loader.ts)
async function is_native_page(page: pdfjs.PDFPageProxy): Promise<boolean> {
  const text = await page.getTextContent()
  const char_count = text.items.reduce((n, it) => n + ('str' in it ? it.str.length : 0), 0)
  if (char_count >= MODE_TEXT_MIN) return true
  const ops = await page.getOperatorList()
  return ops.fnArray.some(fn => VECTOR_OPS.has(fn))
}
mode = page_is_native.some(Boolean) ? Mode.NORMAL : Mode.SCANNED
```

### 8.1a Glyph shaping (cMaps + standard fonts)

`pdfjs.getDocument()` needs `cMapUrl`/`cMapPacked`/`standardFontDataUrl` to correctly shape
CID-keyed/complex scripts (CJK, Bengali, Devanagari, …) and non-embedded standard-14 fonts —
without them, affected glyphs render garbled/tofu. `vite-plugin-static-copy` serves
`node_modules/pdfjs-dist/{cmaps,standard_fonts}/*` at `/cmaps/`/`/standard_fonts/` (works in both
dev server and production build, unlike a build-only static copy). `useWorkerFetch: true` is
also required: without it, pdf.js's cMap-fetch auto-detection references `document.baseURI`
unconditionally, which is undefined-safe on the main thread but was a landmine while this ran in
a Worker — kept even after the main-thread move since it also avoids a redundant main-thread
fetch (pdf.js's own internal `pdf.worker.mjs` fetches the resources instead).

### 8.2 Page rendering (`pdf/loader.ts`'s `get_source_image()`, main thread)

```ts
const viewport = page.getViewport({ scale: dpi / 72 })
const canvas = new OffscreenCanvas(Math.round(viewport.width), Math.round(viewport.height))
const ctx = canvas.getContext('2d')!
await page.render({ canvasContext: ctx, viewport }).promise
const bitmap = canvas.transferToImageBitmap()
return rotate_bitmap_cw(bitmap, rotation)   // bakes current rotation angle in — §5a
```

For image files: `const bitmap = await createImageBitmap(file)` — directly transferable.

### 8.3 Output rendering (`PdfRendererAdapter.render_output_image`, in pdf/loader.ts — the ONE
image path)

Actual signature (`pdf/loader.ts`) — takes an already-decoded `src` bitmap plus the *source* DPI
implied by `page_w`/document mode (not a free `page_dpi` global as an earlier draft of this doc
assumed); crop coordinates are page-unit and converted to source-pixel via `src.width / page_w`:

```ts
render_output_image(
  src: ImageBitmap, box: Box, page_w: number, page_h: number,
  target_dpi: number | null, greyscale: boolean,
): Promise<ImageBitmap> {
  const src_dpi = /* SRC_DPI for scanned docs, NORMAL_DPI for normal docs */
  const scale   = src.width / page_w                       // px per page-unit
  const crop_w  = box.x1 - box.x0, crop_h = box.y1 - box.y0
  const out_w   = target_dpi ? Math.round(crop_w * target_dpi / src_dpi) : Math.round(crop_w * scale)
  const out_h   = target_dpi ? Math.round(crop_h * target_dpi / src_dpi) : Math.round(crop_h * scale)
  // draw box.x0*scale..box.x1*scale of src into an out_w x out_h OffscreenCanvas, then
  // desaturate via getImageData luma weights if greyscale
}
```

Called identically by `canvas_view.ts` (preview) and `AppModel.export()`'s per-page loop
(export) — the WYSIWYG guarantee (spec-web §10.1) holds because both call sites go through this one
method on the one `PdfRendererAdapter` instance, not two implementations.

### 8.4 Export (export.worker.ts)

```ts
// PDF export — pdf-lib
const doc = await PDFDocument.create()
for (const { bitmap, quality } of pages) {
  const jpegBytes = bitmap_to_jpeg(bitmap, quality)  // OffscreenCanvas + toBlob
  const img = await doc.embedJpg(jpegBytes)
  const page = doc.addPage([img.width, img.height])
  page.drawImage(img, { x:0, y:0, width:img.width, height:img.height })
}
const pdfBytes = await doc.save({ useObjectStreams: true })
postMessage({ type: 'ok', bytes: pdfBytes }, [pdfBytes.buffer])
```

For JPG/PNG: individual `OffscreenCanvas.convertToBlob({type, quality})` per page,
streamed back one at a time so memory stays flat (spec-web §10.5, §16).

---

## 9. Image processing (`pdf/imaging.ts`, main thread — §7a)

OpenCV.js WASM — loaded once, lazily, on first call (`ensure_cv()`). All operations are
`ImageBitmap` in → `ImageBitmap` out (stateless beyond the cv module itself and the lazy ONNX
session, both process-lifetime singletons — no longer worker-lifetime since there's no worker).

| Spec algorithm | OpenCV.js implementation | Status |
|---|---|---|
| Sauvola binarization | `sauvola_ink_mask()`: `cv.boxFilter` on the image and its square to get local mean/std, `T = mean·(1+k·(std/R−1))`, `ink = flat < T` | **Faithful port** of `core/imaging.py _sauvola_threshold` — real formula, not `cv.adaptiveThreshold` (see history note below) |
| Illumination flatten | `illumination_flatten()`: `cv.morphologyEx(MORPH_CLOSE)` **on a 1/`BG_DOWNSCALE` copy, upscaled** (`morph_close_background`) + divide | Implemented, shared by detect and both filter modes. The large-kernel close is estimated on a downscale then upscaled (spec-web §16): opencv.js's single-thread morphology is O(pixels·kernel²) with no large-kernel optimization and, full-res, dominated everything (0.6–9 s/page). ~36× faster,
| `clean_document_bilevel` | `clean_document_bilevel()`: flatten → Sauvola → single-pass label-LUT despeckle | Implemented for both `detect_content()` (strength-2 params, downscaled) and the B/W filter (per-strength `k`/`min_area` from `BW_STRENGTH`) — same function backs both, as spec-web §5 requires |
| Connected-component despeckle | `cv.connectedComponentsWithStats` → per-label keep array → one `O(pixels)` LUT pass (not per-component `cv.compare`, which would be `O(components·pixels)` and miss the spec-web §16 "single-pass despeckle" performance target) | Implemented |
| `content_box()` | bounding rect of kept components, border-touching fallback | Implemented |
| Unsharp mask (Sharpen) | `cv.bilateralFilter` (strength-scaled `d`/`sigmaColor`/`sigmaSpace` from `SHARPEN_STRENGTH`) → `cv.GaussianBlur` (strength-scaled radius) → `cv.addWeighted` (`CLEAN_AMOUNT` gain) | Implemented, strength now drives denoise/blur radius **and** gain|
| DPI-scaled kernels | — | **Not ported.** `imaging.py`'s `_dpi_scale()` scales the Sauvola window / bg-kernel / min-area by source DPI (0.5×–4× clamp) so scans at different resolutions binarize comparably. The web always uses the base `SAUVOLA_WINDOW`/`BG_KERNEL_SIZE` regardless of DPI. Low-severity residual gap — SRC_DPI is fixed at 200 in the web (no variable-DPI source rasters), so this mainly affects the B/W filter's absolute kernel size relative to `imaging.py`'s 150 DPI reference, not correctness. |
| 2× supersample refinement | — | **Not ported.** `clean_document_bilevel` upscales 2× before thresholding then downsamples for a cleaner edge; the web version thresholds at native resolution. Cosmetic quality difference only. |
| Dewarp mesh | `ensure_onnx()` + `apply_dewarp()`: UVDoc warp-field model → bilinear resample | Implemented — two-stage ONNX pipeline, EPs `['webgpu','wasm']` gated on `navigator.gpu`, `numThreads=1` |
| Deskew angle | — | Spec §10.1 folds deskew into the single Dewarp & Deskew mesh-unwarp control ("there is no separate deskew step") — there is intentionally no standalone deskew function to port; it ships (or doesn't) together with dewarp. |

`detect_content()` downscales to `DETECT_MAX_PX` for speed used a direct `cv.adaptiveThreshold` call
for detection with no relationship to the B/W filter's algorithm at all, which was wrong on two
counts (not Sauvola, and not shared with the filter). Both are fixed.

### 9a. Scan pipeline dataflow and the three-tier work cache

The scan pipeline was ~10–20× too slow; profiling (not the SIMD width — see §7b) found four causes,
all fixed. The model (`core/model.ts`) rasterizes each page **exactly once** through `_get_source(p)`
(cached in the RAM source LRU); every consumer — NORMAL view, SCANNED work pipeline, Auto-detect —
goes through it.

- **Single-raster work pipeline.** `RendererAdapter.get_work_image` now takes the **already-rendered
  source bitmap** (`get_work_image(source, intent, supersample)`), not a page index. Previously the
  model rendered the page for `get_source_image`, then `get_work_image` re-rendered the same PDF page
  a *second* time internally (double rasterization). `process_page_async` applies dewarp then filter,
  staying in `cv.Mat` across stages (one ImageBitmap→Mat in, one Mat→ImageBitmap out).
- **Detect on the raw source.** `_detect_each_page` runs `detect_content_box` on `_get_source(p)`, the
  **raw** raster — never the processed work image. Detection was running the full dewarp+filter
  pipeline per page and then discarding most of it by downscaling to `DETECT_MAX_PX`.
- **RAM-only, per-page, content-addressed processed-raster cache.** Each page owns its OWN small
  version-history LRU in `_work_versions`/`_source_versions` (`Map<page, LRUCache<key, bitmap>>`),
  not one cache shared across all pages — a shared capacity would evict OTHER pages' bitmaps just
  from paging through a long document, so walking through N pages would cost more than walking
  through 1. Each page's own LRU is capacity `settings.undo_depth + 1` (the current combination
  plus as many prior ones as Undo can still reach) — there is no separate cache-size constant to
  keep in sync with the Undo/redo-depth setting. Keyed by rotation (source) / full intent (dewarp,
  filter mode/strength) + rotation + supersample (work), not bare page number: a settings or
  rotation change simply resolves to a different key within that page's own history (never a stale
  raster), and Undo/Redo — which do not touch these caches at all (see History below) — re-hit an
  already-computed entry when it is still within reach instead of recomputing. An earlier design
  used one shared, disk-backed (IndexedDB, `pdf/work_store.ts`) cache; both the sharing and the disk
  tier were removed as unnecessary complexity — a bitmap persisted to disk buys nothing for a
  RAM-bounded, in-session cache, and a shared capacity actively worked against "walking N pages
  costs the same as 1." Net effect: each page is processed **at most once per distinct
  combination**; revisiting a combination past its own page's history is one clean recompute, never
  a disk read. Regression-guarded by `tests/core/work_cache.test.ts` and
  `tests/core/scan_orchestration_speed.test.ts`.
- **Dewarped intermediate, cached separately from the filtered result.** Dewarp&Deskew (ONNX,
  §7.1) costs orders of magnitude more than a filter pass (multi-second CPU inference vs. the
  filter's own ~200ms OpenCV pass, §16) — re-running it every time the filter changes while dewarp
  stays on made filter switching as slow as dewarp itself. `PageRasterPipeline._get_work` now
  resolves dewarp and filter as two separate steps when both are requested: a dewarp-only call
  (`get_work_image(source, {dewarp:true,filter:null}, supersample)`) cached in its own per-page LRU
  (`_dewarped_versions`, keyed by rotation+supersample only, no filter component), then a
  filter-only call (`get_work_image(dewarped, {dewarp:false,filter}, supersample)`) on that cached
  bitmap, cached in `_work_versions` under the *full* intent key as before — so the addressable
  cache entry still reflects true state, only the compute path is split. A dewarp-only intent (no
  filter) returns the dewarped bitmap directly rather than duplicating it into `_work_versions`
  (same double-close hazard as the NORMAL-mode source/work aliasing above). No separate
  invalidation logic: like `_work_versions`, a state change (rotation, supersample, or Undo/Redo
  landing on a different `dewarp_on`) simply resolves to a different key, never a stale entry.
  Regression-guarded by `tests/core/page_raster_pipeline.test.ts` (exact dewarp-call-count
  guarantee, mocked adapter) and `tests/e2e/scan_dewarp_cache.spec.ts` (real ONNX/OpenCV, doesn't
  hang, renders correctly — real wall-clock timing is too noisy under parallel workers for a tight
  or ratio budget there, see that file's header).

Measured budgets (met): B/W filter < 500 ms/page, Auto-detect < 100 ms/page (spec-web §16).
Regression-guarded by `tests/perf/scan_speed.test.ts` (`npm run test:perf`) and, end-to-end in a real
browser, `tests/e2e/scan_simd.spec.ts`.

**Dewarp** — `apply_dewarp()` runs the two-stage UVDoc pipeline (warp-field inference → bilinear
resample), wired button→AppModel→`ensure_onnx`→`apply_dewarp`. Execution providers `['webgpu','wasm']`
gated on `navigator.gpu` (spec-web §7.1).

ONNX model cache:
```ts
// On first run_dewarp: try IndexedDB, else fetch from CDN, store in IndexedDB
const modelBytes = await load_from_cache('docuwarp-model') ?? await fetch_and_cache(MODEL_URL)
const eps = ('gpu' in navigator) ? ['webgpu', 'wasm'] : ['wasm']   // imaging.ts, not hardcoded
const session = await ort.InferenceSession.create(modelBytes, { executionProviders: eps })
```

---

## 10. State model 

`DocumentState`, `History`, `Settings`, `DragState`.

The defining rules are preserved:
- `DocumentState` holds exactly the 8 undoable fields (`applied`, `crop_rects`, `rotation`,
  `processed`, `offsets`, `dewarp_on`, `filter_mode`, `filter_strength`); `snapshot()` deep-copies
  the per-page maps and shares the frozen scalars. `detect_cache`/`union`/`auto_active`/`drawn`
  are non-undoable `AppModel` fields, 
- `Settings` fields are those consumed by domain commands; `UIConfig` (theme/font/scale)
  is owned by `AppController`, invisible to `core/`
- `History.push()` stores a pre-mutation snapshot; `undo()` pushes current to redo, returns
  the popped snapshot; `AppModel` drops only the (cheap, unbounded) output-preview cache on state
  restore — the source/work raster caches are content-addressed per page and deliberately untouched
- `AppModel` is the single state owner; `ui/` reads only frozen `ViewSnapshot` and plain
  property values

Each page owns its own small LRU of `ImageBitmap` (source rasters) and processed `ImageBitmap`
(work rasters), bounded to `undo_depth + 1` entries — not one cache shared across all pages (§9a).
Evicted entries are `ImageBitmap.close()`d (releases GPU texture memory).

---

## 11. Error taxonomy

```ts
class SmartCropError extends Error {}
class NoDocumentError extends SmartCropError {}
class EmptySelectionError extends SmartCropError {}
class InvalidSplitError extends SmartCropError {}
class DeleteAllPagesError extends SmartCropError {}
class DocumentLoadError extends SmartCropError { constructor(msg: string, cause?: Error) }
class ImagingError extends SmartCropError {}
class MissingDependencyError extends SmartCropError {}
```

`core/` raises these; `AppController.dispatch()` / `dispatch_job()` catch them and show a themed
modal (`AppController.alert()` → `ui/confirm.ts::alert_dialog`, the same `.overlay`/`.overlay__card`
shell as the yes/no confirm dialog, single OK button) — dismissed by the user, never auto-timed-out.

Worker errors: worker posts `{type:'error', message}` → caught in worker message handler →
converted to `ImagingError` → passed to `dispatch_job` as `Failed(error)`.

Unhandled promise rejections are caught by a global `window.addEventListener('unhandledrejection')`
handler — clears `_current_job`, hides overlay, repaints, surfaces error. 

---

## 12. UI rendering loop

No framework = no virtual DOM. After every model mutation, `AppController.refresh_all()` is
called:

```ts
refresh_all(): void {
  const snap = this.model.view_snapshot()
  const busy = this._current_job !== null
  this.canvas_view.paint(snap)
  this.pages_panel.refresh(this.model, busy)
  this.crop_panel.refresh(this.model, busy)
  this.scan_panel.refresh(this.model, busy)
  this.output_panel.refresh(this.model, busy)
  this.nav_bar.refresh(this.model, busy)
}
```

Each panel's `refresh()` reads raw model properties and sets widget states (enabled/visible/value)
unconditionally.For a tool of this
complexity (< 20 interactive controls) this is simpler and faster than a framework.

Canvas paint (`canvas_view.paint(snap)`):
1. Draw `snap.image` (page bitmap) centred in canvas
2. Draw overlay boxes (dashed crop frames, handles, split badges)
3. Draw `draw_rect` (rubber-band) if active
4. Update the bottom-right cursor DOM overlay — no status element, and nothing is painted onto
   the page raster

Throttle: canvas paint is debounced at `SCALE_THROTTLE_MS` on resize. All other refreshes
are immediate (user action → synchronous model mutation → immediate repaint, < 1 ms for non-
imaging ops).

---

## 13. File I/O — implementation

Behavior specified in `docs/SmartCrop_PDF_Specification_Web.md` §15. Implementation:

**Load:** `<input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff">` + drag-and-drop
on canvas/window. `File` objects passed directly to `loader.ts` (no temp files).

**Export:**
- Single-file formats (PDF): `URL.createObjectURL(blob)` → `<a download>` click → auto-revoke
- Image formats (JPG/PNG/TIFF): every page encoded in `export.worker.ts`, packed into one `.zip`
  with `fflate` (`zipSync`, pure JS ~10KB) → single `<base>.zip` download on all browsers. Entries
  `<base>_NNN.<ext>`. TIFF pages via `workers/tiff.ts`. No per-page loose downloads.
- Overwrite confirmation has no web code path (browser download cannot detect an overwrite); the
  inert Settings checkbox was removed (spec-web §15).

---

## 14. Synthetic document

On first load (no file open), render a `SYNTH_PAGES`-page (1) placeholder document using
Canvas API directly (no PDF.js needed) — white pages with grey placeholder text/blocks.
 All controls stay fully usable (spec-web §1).

Implemented in `pdf/loader.ts` as a special `SyntheticDoc` path that generates
`ImageBitmap` pages on demand without a real file.

---

## 15. Performance targets

Targets specified in `docs/SmartCrop_PDF_Specification_Web.md` §16. Implementation levers:
each page's own `undo_depth + 1`-entry LRU (§9a) bounds resident GPU memory per page; export
streams one page at a time; `ImageBitmap.close()` is called on LRU eviction to release the GPU
texture immediately.

---

## 16. Keyboard shortcuts

Behavior/mapping specified in `docs/SmartCrop_PDF_Specification_Web.md` §20. Implemented as a
single `keydown` listener in `app.ts` dispatching to the matching `AppModel`/`AppController` call;
`Ctrl +/-/0` scale via CSS `font-size` on `:root` (rem-based layout scales with it).

---

## 17. Theme and typography — implementation

Palette semantics (what each color means, when it's used) specified in
`docs/SmartCrop_PDF_Specification_Web.md` spec-web §3. Implementation: CSS custom
properties for the two-theme palette (dark/light/system via `prefers-color-scheme`):

```css
:root[data-theme="dark"] {
  --bg-chrome: #1e1e1e;     --bg-card: #2a2a2a;    --bg-input: #333;
  --text-primary: #e8e8e8;  --text-dim: #888;
  --accent: #3a8ef5;        --crop-blue: #4a9eff;  --split-blue: #2a7edb;
  --border: #3a3a3a;        --handle-fill: #fff;
}
```

All sizes in `rem`; root `font-size` = `FONT_SIZE_DEFAULT` (15px) scaled by the zoom setting.
Crop frame: dashed border + diamond handles at corners + midpoints. Split badges: circle with
number, 30% larger than base font. Cursor coords: DOM overlay, not canvas-drawn (spec-web §3).
Icons: SVG inline, colour via `currentColor` (follows button active/inactive state; no independent
colour channel).

---

## 18. Deployment

```
GitHub repository → push to main → GitHub Actions:
  npm ci
  tsc --noEmit
  vitest run --coverage
  playwright test
  vite build → dist/

dist/ → GitHub Pages (source: Actions artifact)
Cloudflare CDN: proxy GitHub Pages origin; edge cache for JS chunks + PDF.js worker
```

**Asset sizing (gzip):**
| Asset | Size |
|---|---|
| Main bundle (core + ui + pdf/) | ~120 KB |
| PDF.js chunk (pdfjs-dist) | ~280 KB |
| pdf-lib chunk | ~100 KB |
| OpenCV.js WASM (`pdf/imaging.ts`, main thread — §7a) | ~8 MB (lazy; scanned mode only) |
| ONNX Runtime Web (lazy) | ~8 MB (lazy; dewarp only) |
| docuwarp model (lazy, IndexedDB) | ~10 MB (once per session, cached) |

Normal-mode users (the majority) download ~500 KB total.
Scanned-mode users load the 8MB OpenCV chunk once on first filter/detect press.
Dewarp adds another 18MB one-time download, cached indefinitely in IndexedDB.

**Icons + offline (`public/sw.js`, `public/site.webmanifest`, `src/ui/sw_register.ts`):** a
hand-rolled service worker, not `vite-plugin-pwa`/workbox — the JS/CSS bundle's filenames are
content-hashed per build, so there's no static precache manifest to generate without adding a
plugin dependency; instead the SW caches same-origin GET responses opportunistically (cache-first,
populate-on-miss) as the running app requests them. `sw_register.ts` registers it only when
`import.meta.env.PROD` (never under `vite dev` — a dev-mode SW would intercept fetches and serve
stale cached responses instead of Vite's HMR updates; stopping the `npm run dev` process itself is
unrelated to offline capability either way — it just kills the local server the dev browser talks
to). The manifest's icon `src` values are relative, not root-absolute (`public/` files are copied
verbatim by Vite, unlike `index.html`'s `%BASE_URL%`-templated links — a root-absolute manifest
icon path 404s under a GitHub Pages project-page subpath). Playwright e2e runs against `vite dev`
(playwright.config.ts), where the SW deliberately never registers, so there is no automated
offline-after-online-load e2e check yet — verify that manually against a production build
(`vite build && vite preview`) before relying on the offline behavior at deploy time.

`sw_register.ts::warm_offline_cache()` (spec-web §15) — Settings → "Enable offline mode" (off by
default). The SW's opportunistic caching above only ever covers what a session actually used, so a
user who never exercised SCANNED-mode processing online would find dewarp/filters failing offline
despite the SW being registered and otherwise working. Turning the switch on calls `ensure_cv()`
(`pdf/cv.ts`) and `ensure_onnx()` (`pdf/dewarp.ts`) directly — the same real init paths SCANNED
mode already uses — so their same-origin fetches populate the SW's cache as a side effect, with no
separate hardcoded asset-URL list to keep in sync.

---

## 19. Quality gates (run before every commit)

```bash
tsc --noEmit && eslint src && vitest run --coverage --reporter=verbose && playwright test
```

- TypeScript strict, zero `any`, zero `@ts-ignore`
- ESLint `@typescript-eslint/recommended-type-checked`
- Vitest coverage ≥ 90% on `src/core/`; ≥ 80% overall
- All Playwright e2e green on Chromium + Firefox
- Architecture test: no `core/` file may import `window`, `document`, `Worker`,
  `pdfjs-dist`, `pdf-lib`, or `@pdf/*` or `@ui/*`
- No function over 30 lines without a why-comment
- No magic numbers — all tunables in `src/core/constants.ts` (domain) or `src/ui/constants.ts` (UI)

---

## 20. Spec invariants coverage

`docs/SmartCrop_PDF_Specification_Web.md` §21 lists the current acceptance invariants. A per-
invariant → test-file mapping belongs here once it's been verified against the real suite — the
previous version of this table cited `e2e/crop.spec.ts`, `scan.spec.ts`, `export.spec.ts`,
`history.spec.ts`, `pages.spec.ts`, `ui/canvas_view.test.ts` and `ui/panels.test.ts`, none of which
exist in the current `tests/` tree (the real e2e suite is `tests/e2e/{smoke,crop_split,
committed_window,scan_simd}.spec.ts`, and per-panel coverage lives in `tests/ui/*.test.ts` named
after the panel, not a single `panels.test.ts`) — it was fabricated or badly stale and has been
removed rather than left misleading. Rebuild this table against the actual suite instead of
reconstructing it from memory.

