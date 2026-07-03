# SmartCrop PDF Web — Architecture

Status: **implemented (beta), architecture under active correction**. The prior "approved,
pre-implementation" status line was stale — `src/` is a working ~4,200-line app, not a design
sketch, and this document is being brought back in line with the real code rather than the other
way around.

**Document split (2026-07-01):** behavior and mechanism used to be mixed in this one file. They
are now three documents, mirroring the desktop repo's CLAUDE.md/spec split:
- `docs/SmartCrop_PDF_Specification.md` — the canonical, platform-agnostic behavioral contract
  (§1–§22), copied verbatim from the desktop repo. Unchanged for the web.
- `docs/SmartCrop_PDF_Specification_Web.md` — web-specific behavioral supplement: every point
  where the browser platform forces a real deviation from that contract (§W2), plus browser-only
  behavior the desktop has no equivalent of at all (layout, shortcuts, file I/O — §W3–§W7).
- **This file** — mechanism only: module layout, PDF/imaging stack, worker model, state ownership,
  build/test/deploy. If a fact describes what the user experiences, it belongs in one of the two
  spec documents above, not here — file it there instead of restating it in this file.

**Implementation status at a glance** (kept current — update this table, not just prose, when
something changes):

| Area | Status |
|---|---|
| Core state/logic (`src/core/*.ts`) | Implemented, 1:1 with desktop `AppModel`/`DocumentState`/`History`/`Settings`/`DragState`/`BatchJob` (§5, §10). `model.ts` (1167 lines) has a 50-test suite (`tests/core/model.test.ts`) covering every public method — caught and fixed a real `delete_pages()` regression (page count never shrank) during authoring. Branch coverage is 70.91%, below the `vitest.config.ts` 90%-on-core gate in §19 — **gap open, not closed**. |
| PDF load/classify/render (`src/pdf/loader.ts`) | Implemented — one adapter class, runs on the **main thread**, not `render.worker.ts` (that file no longer exists — see §7a) |
| OpenCV.js scan processing (`src/pdf/imaging.ts`) | Implemented — also main thread, not `imaging.worker.ts` (deleted — see §7a). Detect/Auto-detect/Crop/B-W/Sharpen all verified working via headless-browser E2E. |
| PDF glyph shaping (CJK/Bengali/Devanagari/standard-14 fonts) | Implemented — `cMapUrl`/`standardFontDataUrl`/`useWorkerFetch` wired into `getDocument()`, resources served via `vite-plugin-static-copy`. Previously garbled without this. |
| Rotate | Implemented — rotates the actual raster (`rotate_bitmap_cw` in loader.ts) and the page-unit coordinate frame (`AppModel._page_dims`, §5a). Previously a state-only no-op: `document.rotation` was written but never read by the render path, so the button visibly did nothing. Fixed and E2E-verified. |
| Detection + B/W filter (real Sauvola) | Implemented (§9) — was `cv.adaptiveThreshold` approximation, now a faithful box-filter Sauvola port |
| Sharpen filter | Implemented, strength drives denoise + unsharp (§9) |
| Dewarp (docuwarp/ONNX mesh unwarp) | **Not implemented** — `apply_dewarp()` stub, real gap (§9) |
| DPI-scaled kernels, 2× supersample refinement | Not ported (minor fidelity residuals, §9) |
| Multi-file PDF documents | **Broken** — `PdfRendererAdapter._pdf` holds a single `PDFDocumentProxy`; loading multiple PDFs leaves only the last file's pages reachable via `get_source_image`. Not fixed this pass. |
| Mixed PDF + image documents | **Broken** — `get_source_image()` unconditionally assumes `this._pdf` is set for any page index; an image-only page in a mixed load throws. Not fixed this pass. |
| Export (PDF single file; JPG/PNG/TIFF → single `.zip`) | Implemented (§8.4, §13). TIFF via `workers/tiff.ts` (baseline RGB); image formats zipped in `export.worker.ts` via `fflate`. |
| Settings panel (spec §15: Appearance/Output/Behaviour/Scan) | Implemented (§2, `settings_view.ts`) |
| Help panel (spec §16: Contents card + sections) | Implemented (§2, `help_view.ts`) |
| Output Quality / Export as two cards (matches desktop `panels.py`, not the merged card an earlier draft shipped) | Implemented |
| `confirm_overwrite` setting | Stored, **not yet enforced** — no File System Access API overwrite-detection path exists yet (§13); the setting is inert pending that |
| Test suite (`tests/`) | `tests/core/` complete — `geometry`, `viewmodel`, `parsing`, `lru`, `enums`, `model` (122 tests total, all passing, `tsc`/`eslint` clean). All of `pdf/` and `ui/` still at 0% (need Playwright, not Vitest — global 80%-lines gate fails at 41% because of this). No Playwright e2e suite committed yet (ad hoc scripts verified prior fixes, not checked in). |

Where this document and the running code disagree, that is a bug in the document (or a
regression in the code) — file it as such, not as an acceptable drift.

## 1. Why TypeScript + Vanilla DOM, not a Python port

Desktop `core/` is PyMuPDF + OpenCV + scikit-image + docuwarp/ONNX. No Python→JS transpilation
produces maintainable code. The web port re-implements the same spec using web-native equivalents:

| Desktop | Web equivalent |
|---|---|
| PyMuPDF (`fitz`) — read + render | PDF.js (`pdfjs-dist`) |
| PyMuPDF — write output PDF | pdf-lib |
| PIL / NumPy ImageData | `ImageBitmap` / `ImageData` via Canvas API |
| OpenCV + scikit-image (Sauvola, components, sharpen) | OpenCV.js WASM, lazy-loaded in worker |
| docuwarp + ONNX Runtime | ONNX Runtime Web + model, lazy-loaded in worker |
| `root.after()` cooperative batch loop | Web Worker + `postMessage` per page |
| CustomTkinter + `tk.Canvas` | HTML/CSS + `<canvas>` (vanilla TS, zero framework runtime) |

The spec-defined state model, geometry, parsing, error taxonomy and batch protocol map 1:1 from
Python to TypeScript — those modules are re-implemented verbatim, not framework-wrapped.

**Technology decisions (locked):**
- Language: TypeScript (strict mode, zero `any`)
- UI: Vanilla TS + DOM APIs, no framework runtime
- Build: Vite 5
- Image processing: OpenCV.js WASM (lazy-loaded; full parity with desktop Sauvola pipeline)
- Dewarp: ONNX Runtime Web + docuwarp model (lazy-loaded; cached in IndexedDB after first load)
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

      constants.ts          All domain tunables — mirror of Python core/constants.py:
                              SRC_DPI=200, NORMAL_DPI=150, CACHE_WINDOW=16,
                              HANDLE_R=10, HANDLE_SLACK=6, CANVAS_MARGIN=40, MIN_RECT=5,
                              OFFSET_LIMIT=100, MODE_TEXT_MIN=8, DETECT_MAX_PX=1400,
                              BORDER_FRAC=0.02, MIN_COMP_FRAC=2.5e-4, FULL_PAGE_FRAC=0.97,
                              DESKEW_MAX_DEG=15, CLEAN_AMOUNT={1:0.6, 2:1.1, 3:1.6},
                              SYNTH_PAGES=24, SYNTH_W=595, SYNTH_H=842 (+ SYNTH_BG_COLOR etc. —
                              synthetic placeholder styling lives here, not ui/constants.ts,
                              because pdf/loader.ts cannot import ui/ — see §4 dependency graph),
                              DPI_PRESETS, EXPORT_FORMATS, IMAGE_LOAD_EXT,
                              FILTER_STRENGTH_MIN/MAX, UNDO_DEPTH_MIN/MAX, MAX_SPLIT,
                              CC_CONNECTIVITY, DETECT_THRESHOLD_BLOCK/C, BG_KERNEL_SIZE,
                              BW_THRESHOLD_C, BW_BLOCK_SIZE, SHARPEN_BILATERAL_D/SIGMA_COLOR/SPACE
                              (the last group are coarse adaptiveThreshold tuning values, not the
                              desktop's true Sauvola binarization — see §9 fidelity note)

      enums.ts              Mode (NORMAL|SCANNED), FilterMode (NONE|BW|SHARPEN),
                              PagesMode (ALL|ODD|EVEN|SELECT) — string-backed enums

      errors.ts             SmartCropError, NoDocumentError, EmptySelectionError,
                              InvalidSplitError, DeleteAllPagesError, DocumentLoadError,
                              ImagingError, MissingDependencyError — same taxonomy as Python

      geometry.ts           Box type, hit_handle(), auto_crop_rect(), drag_resize(),
                              drag_move(), union_box(), rotate_box_cw(), clamp_to_page(),
                              keep_ratio_normalise() — pure math, no I/O

      parsing.ts            resolve_pages(pattern, total, mode) → number[]
                              All/Odd/Even + pattern: ranges, slices (1:4, ::2, 10:), mixed

      lru.ts                LRUCache<K, V> — same eviction algorithm; stores ImageBitmap refs

      viewmodel.ts          output_page_count(), view_index_to_source(), source_to_view_range()
                              — committed-split pages expand to N views, same math as Python

      document_state.ts     Offsets (frozen), PageProcessIntent (frozen), DocumentState
                              (the 11 undoable fields + snapshot()), identical to Python

      settings.ts           Settings dataclass — compress_preset, output_colours, export_format,
                              output_folder, output_postfix, undo_depth, dewarp_supersample

      history.ts            History — bounded undo/redo of DocumentState snapshots, same interface

      drag.ts               AutoDrag | SplitDrag | DrawDrag | CropEditDrag — frozen tagged union

      batch.ts              BatchJob interface + BatchResult (Ok|Cancelled|Failed)
                              Web version: result() returns Promise<BatchResult>; progress via
                              onProgress(cb) callback instead of cooperative step()

      model.ts              AppModel — single facade, same public interface as Python.
                              Owns: document state, history, settings, drag, LRU caches.
                              All render/imaging calls go through pdf/ and workers/ via injected
                              async adapters (see §5).

    workers/                Web Workers — each a Vite `?worker` import, lazy-initialized.
                            **Only one worker remains: export.worker.ts.** `render.worker.ts` and
                            `imaging.worker.ts` were deleted this session after both proved
                            fundamentally incompatible with running inside a dedicated Worker —
                            see §7a for the full root-cause writeup and why pdf.js and OpenCV.js
                            now run on the main thread instead (in `pdf/loader.ts` and
                            `pdf/imaging.ts` respectively).

      export.worker.ts      pdf-lib assembly — receives cropped ImageBitmap[] per output page,
                              encodes to JPEG bytes (quality by compress preset), builds PDF.
                              Also handles JPG/PNG blob output per page.
                              Initialized on first export(). pdf-lib has zero `window`/`document`
                              references, so it's Worker-safe (unlike pdf.js/OpenCV.js — §7a).

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
                              - get_work_image(page_idx, intent, supersample, rotation) → source
                                image unchanged if intent has no dewarp/filter, else
                                `pdf/imaging.ts`'s `process_page_async()` (same thread, no RPC).
                              - render_output_image(src, box, page_w, page_h, target_dpi,
                                greyscale) → Promise<ImageBitmap> — the WYSIWYG function (§8.3),
                                used by both canvas preview and export. Crops to box (page-unit →
                                source-pixel via `src.width / page_w`), resamples to target_dpi
                                (null = original), optionally desaturates. Runs on the main thread
                                via OffscreenCanvas.
                              - detect_content_box(img, page_w, page_h, mode) →
                                `pdf/imaging.ts`'s `detect_content_async()` (same thread).
                              - export_pdf(pages) / export_images(pages, format) → export.worker,
                                lazy-initialised on first export (the one real Worker left).
                              - make_synth_page(idx, w, h) — synthetic placeholder (§14), drawn
                                directly with Canvas API, no worker involved.

      imaging.ts             OpenCV.js scan processing (detect / filter / dewarp stub), main
                              thread — see §7a for why. Exposes `detect_content_async()` and
                              `process_page_async()`, called directly by loader.ts (no postMessage).

    ui/                     Presentation layer. Imports @core/* and @pdf/*. core/ never imports ui/.
      constants.ts          UI-only tunables: PANEL_WIDTH=320, DETAIL_PANEL_WIDTH=380,
                              CANVAS_MARGIN=40 (same as core), STATUS_IDLE_MS=2400,
                              SCALE_THROTTLE_MS=80, FONT_SIZE_DEFAULT=15, THEMES,
                              canvas overlay drawing tunables (dash patterns, line widths,
                              split-badge scale, status-text offsets — see canvas_view.ts)

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
                              - paint(snapshot: ViewSnapshot) — draws page bitmap + overlay boxes +
                                status text on the page image (spec §6, §19)
                              - Pointer events (pointerdown/move/up) → page-unit coords →
                                model.begin_drag / update_drag / end_drag / cancel_drag
                              - Wheel → next/prev page (spec §5)
                              - Resize observer → recompute scale, repaint
                              - Esc + right-click → cancel_drag() (spec §9.3)

      overlay.ts            Progress overlay — a <div> centred over the canvas, shown only when
                              batch total > 1. Displays title, determinate bar, page counter, Cancel.
                              Driven by BatchJob.onProgress(). Hides on job completion.

      panels/
        pages_panel.ts      "Document & State" + "Pages to Process" cards.
                              Load Files button (File input, multi-select, PDF+images).
                              Mode badge (NORMAL/SCANNED). All/Odd/Even/Selected buttons.
                              Pattern field + Current follow-toggle.

        crop_panel.ts       "Split Each Page Into" + "Detect Text Borders" + "Advanced"
                              (collapsible offsets) + "Actions" cards.
                              Split 1/2/4 segmented; Same size toggle; Keep ratio + ratio field.
                              Auto-detect button; Anchor Left/Top toggles.
                              Advanced collapsed by default (▸/▾ toggle); L/T/R/B offset inputs.
                              Crop (full-width) + Rotate + Delete action buttons.

        scan_panel.ts       "Scan Processing" card — shown only in SCANNED mode.
                              Dewarp toggle; B/W / Sharpen buttons (mutually exclusive highlight);
                              Strength 1/2/3 buttons (always selectable).

        output_panel.ts     "Output Quality" + "Export" cards — two separate cards, matching the
                              desktop's actual `_build_compress`/`_build_export` split
                              (`ui/panels.py`, titled "Output Quality" there — the spec prose's
                              literal "Compress Document" title is stale relative to the app;
                              this doc follows the app, per project convention).
                              DPI preset dropdown; Output colours dropdown.
                              Export split button (main = current format; ▾ = PDF/JPG/PNG picker).

        nav_bar.ts          Pinned bottom bar: Undo / Redo / Reset (3 equal buttons);
                              page nav < [n] / total >.
                              Always visible, outside scroll, one instance only.

      detail_panel.ts       The THIRD column — slides in between left sidebar and canvas when
                              Settings or Help is active (§3.2). Width DETAIL_PANEL_WIDTH.
                              Renders either SettingsView or HelpView based on active state.
                              Dismissed by clicking Settings/Help button again, or Esc.

      settings_view.ts      Settings content rendered inside detail_panel:
                              Appearance (colour scheme, font size, zoom/UI scale);
                              Output (compress preset, default format, output folder, postfix);
                              Behaviour (confirm overwrite, remember folder, undo depth);
                              Scan (dewarp supersample).
                              Theme/font-size/zoom/confirm-overwrite/remember-folder go through
                              AppController's UIConfig setters (`set_theme`, `set_font_size`,
                              `zoom`, `set_confirm_overwrite`, `set_remember_folder` — §10);
                              compress preset, default format, output folder/postfix, undo depth
                              and dewarp supersample are domain `Settings` (§10) and go through
                              `AppModel` setters directly (`set_compress_preset`,
                              `set_output_folder`, `set_output_postfix`, `set_undo_depth`,
                              `set_dewarp_supersample`) — there is no single `apply_setting()`
                              dispatcher; each field has its own typed setter on the owner that
                              actually holds it (§5.2's `Settings`-vs-`UIConfig` split, unchanged
                              from desktop). The sidebar's Output Quality card and Settings'
                              "Compress to"/"Default format" write through the *same* AppModel
                              setters, so either control always reflects the other (spec §15).

      help_view.ts          Help content rendered inside detail_panel:
                              Heading + one-liner; Contents card (buttons scroll to sections);
                              Section blocks in spec §16 order.

      theme.ts              CSS custom property injection for dark/light/system themes.
                              Warm-gray chrome + blue accent — same palette as desktop (§19).

    main.ts                 Entry point: mounts AppController to #app, initialises synthetic doc.

  tests/
    core/                   Pure TS unit tests — Vitest, no DOM, workers mocked as interfaces
      geometry.test.ts
      parsing.test.ts
      history.test.ts
      model.test.ts         AppModel via mock RendererAdapter; no real PDF.js
      document_state.test.ts
      viewmodel.test.ts
      lru.test.ts

    ui/                     DOM wiring tests — Vitest + jsdom or real browser (Playwright Component)
      canvas_view.test.ts
      panels.test.ts
      detail_panel.test.ts

    e2e/                    Playwright — full Chromium, real PDFs from tests/fixtures/
      crop.spec.ts          Auto-detect, drag gestures, Apply, invariants §22.1–§22.5
      scan.spec.ts          Filter, dewarp, idempotency (§22.3)
      export.spec.ts        PDF/JPG/PNG output, WYSIWYG (§22.12), streaming (§22.21)
      history.spec.ts       Undo/Redo/Reset (§22.4), keep-ratio (§22.19)
      pages.spec.ts         Page selection, delete/reindex (§22.5), split views (§22.11)

    fixtures/               Small real PDFs + images used by tests (committed, < 1 MB each)
    architecture.test.ts    Import-graph guard: walk src/core/ TS files, fail if any import
                              contains 'window'|'document'|'Worker'|'pdfjs-dist'|'pdf-lib'
```

---

## 3. Three-column layout — DOM/CSS mechanism

Behavior (card order/content, detail-panel open/close semantics, status-text placement) is
specified in `docs/SmartCrop_PDF_Specification_Web.md` §W3 — this section is the CSS/DOM
implementation of that behavior only.

**Left sidebar** — fixed width `PANEL_WIDTH` (320px), `<div>` with `overflow-y: auto`. Pinned
bottom bar sits outside the scroll container as a sibling, not inside it.

**Detail panel** — a `<div>` between the sidebar and canvas. Collapsed state: `width: 0`. Open
state: `width: DETAIL_PANEL_WIDTH` (380px), transitioned via CSS `transition: width 180ms ease`.
Canvas column is `flex: 1` so it fills whatever space remains (clamped to a 400px minimum in CSS).
No modal, no overlay, no z-index stacking — the panel is a normal DOM sibling.

**Status text** — rendered inside `canvas_view.ts`'s `paint()` call directly onto the canvas
bitmap (same technique as desktop's `draw_status()`), not a separate DOM element. Mouse
coordinates update on `pointermove`; the page counter updates on navigation.

---

## 4. Dependency graph

```
          src/core/        (zero DOM / Worker API / pdf-lib / pdfjs-dist — enforced §7)
            constants  enums  errors  geometry  parsing  lru  viewmodel    pure leaves
                           ▲
            document_state  settings  history  drag  batch                 pure
                           ▲
                        AppModel ◄── public surface (same interface as Python AppModel)
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
rotate, matching desktop `model.py`'s `img.rotate(-ang, expand=True)` semantics).

---

## 5. AppModel — public interface (TypeScript)

One-to-one with the Python `AppModel`. Async only where the operation touches I/O or a worker.
Synchronous operations (navigation, offset edits, drag events, undo/redo) stay synchronous.

```ts
class AppModel {
  // document
  async load_files(files: File[]): Promise<void>     // raises DocumentLoadError
  async reset(): Promise<void>
  page_count(): number
  get has_document(): boolean

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
  //   keep_ratio, ratio, same_size, compress_preset, output_colours,
  //   export_format — all plain readonly properties

  // pages selection
  set_pages_mode(mode: PagesMode): void
  set_select_pattern(pattern: string): void
  set_current_follow(on: boolean): void
  resolve_pages(): number[]

  // crop / detect
  detect_content(): BatchJob              // raises EmptySelectionError; drives imaging.worker
  apply_crop(): void                      // raises InvalidSplitError / EmptySelectionError
  set_anchor(left: boolean | null, top: boolean | null): void
  set_offset(edge: 'L'|'T'|'R'|'B', value: number): void
  commit_offsets(): void
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
  set_output_colours(mode: string): void
  set_export_format(fmt: string): void
  set_undo_depth(depth: number): void
  set_output_folder(folder: string): void
  set_output_postfix(postfix: string): void
  set_dewarp_supersample(factor: number): void

  // export
  suggested_export_name(): [string, string]
  export(filename: string): BatchJob     // drives export.worker
}
```

### 5a. Rotation pipeline

`rotate_pages()` mutates three things per page: the `document.rotation` angle map (+90° mod
360), the committed/detected crop boxes (rotated 90° CW via `geometry.ts`'s `rotate_box_cw`,
using the page's **effective dims from before this step** — see below), and invalidates that
page's source/work/output raster caches so the next render re-derives them.

The effective page size the rest of `AppModel` reads (`view_snapshot().page_w/page_h`, detect/
crop/split/offset math) comes from the private `_page_dims(p)` helper, not the raw stored
`doc.page_sizes[p]`: it swaps width/height when the page's current rotation is 90° or 270°.
Every call site that used to read `doc.page_sizes[p]` directly now goes through `_page_dims(p)`
— mirrors desktop `model.py`'s `_page_dims()` exactly (same swap rule, same DPI-agnostic
page-unit space for the web version since it has no separate pixel/point distinction to fold in).

The actual pixel rotation happens in the adapter, not `core/` (which must stay DOM-free):
`pdf/loader.ts`'s `rotate_bitmap_cw()` draws the unrotated source raster onto a rotated,
dimension-swapped `OffscreenCanvas` via `ctx.translate()`/`ctx.rotate()`, equivalent to PIL's
`img.rotate(-ang, expand=True)` on the desktop. `AppModel._get_work()` passes the page's current
rotation angle into `get_source_image()`/`get_work_image()` on every (cache-missed) call.

**Bug this fixed (2026-07-01):** `document.rotation` was written by `rotate_pages()` but never
read anywhere in the render path — `_current_page_size()` always returned the raw, unswapped
`page_sizes[p]`, and the adapter never rotated pixels. Result: clicking Rotate silently did
nothing to the displayed page and export, while the (now-desynced) crop-box overlay coordinates
still rotated — producing a blank canvas with a floating, misaligned selection box. Confirmed via
headless-browser E2E (screenshot), root-caused against desktop `model.py:208-231,550-570` to
confirm the intended behavior, and fixed by adding `_page_dims()` + `rotate_bitmap_cw()`.

`ViewSnapshot` fields (identical to Python):
```ts
interface ViewSnapshot {
  image: ImageBitmap        // page raster or committed-crop output image
  page_w: number
  page_h: number
  overlay: readonly OverlayBox[]
  draw_rect: Box | null
  position: number          // 1-based output-page position
  total: number
  status: string            // drawn on page image (§3.3)
}
```

---

## 6. BatchJob — Promise-based cooperative model

Desktop: `step()` + `root.after()`. Web: Worker drives pages; main thread receives
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

Single-page jobs (`total === 1`) suppress the overlay — same as desktop.

---

## 7. Worker protocol and lazy-loading

**Only `export.worker.ts` remains a real Worker** (see §7a for why pdf.js and OpenCV.js don't
run in one). It's a Vite `?worker` import, instantiated once on first `export()` call and reused:

```ts
// export.worker.ts protocol (RpcWorker in loader.ts)
type WorkerMsg = { id: number; type: 'ok'; payload: unknown }
               | { id: number; type: 'error'; message: string }
```

Each request carries a monotonic `id`; responses are matched by id. Pending promises are stored
in a `Map<number, {resolve, reject}>`. This gives a clean async/await surface with no polling.
`ImageBitmap`s are transferred (not cloned) via `postMessage(msg, [bitmap, ...])`; the returned
PDF/JPEG bytes come back as a transferred `ArrayBuffer`.

### 7a. Why pdf.js and OpenCV.js run on the main thread, not in workers

Both libraries were originally each given a dedicated Worker (`render.worker.ts`,
`imaging.worker.ts`, both since deleted). Both hit hard, unfixable-in-a-Worker failures:

**pdf.js.** `pdfjs-dist`'s display API (`pdf.mjs`) references `window`/`document` unconditionally
in places it should guard — `PDFWorker._initialize()` reads `window.location.href` before it
even tries to spawn its own internal `pdf.worker.mjs`. Inside any Worker, `window` is undefined,
so that throws; pdf.js silently falls back to a same-thread "fake worker" path, which then calls
`importScripts()` — illegal inside an ES-module worker (`worker: {format: 'es'}` in
`vite.config.ts`) and throws a second, more confusing error. Fix: run `getDocument()`/
`page.render()` on the main thread (`pdf/loader.ts`). This is in fact pdf.js's own supported
architecture — it still spawns its own `pdf.worker.mjs` internally for the CPU-heavy parsing, so
the main thread isn't doing the expensive work, only the cheap canvas compositing.

**OpenCV.js (`@techstark/opencv-js`).** The package's own `.d.ts`
(`dist/src/types/opencv/_hacks.d.ts`) re-exports `onRuntimeInitialized` as a **named export** of
the package — which collides with the runtime property of the same name the Emscripten WASM
module expects the embedder to set. `import * as cv from '@techstark/opencv-js'; cv.
onRuntimeInitialized = fn` is therefore an illegal import-binding reassignment: esbuild rejects
it outright ("Cannot assign to import 'onRuntimeInitialized'; imports are immutable") when it
analyses the import strictly (confirmed via a Worker bundle and via `optimizeDeps.exclude`).
Where a looser bundling path let the assignment through silently instead of erroring (Vite's
dev-time main-thread pre-bundle), the write landed on the wrong object and the real Emscripten
runtime never saw the callback — `onRuntimeInitialized` never fired, so `cv.Mat` stayed
`undefined` forever and every OpenCV call threw `cv.Mat is not a constructor` (silently, as a
10-second timeout, not a thrown error — this looked like a hang, not a crash). Fix: go through
`(cvModule as unknown as { default: typeof cvModule }).default` — a plain mutable runtime
object, not an import binding — and mutate that instead (`pdf/imaging.ts`). Kept on the main
thread anyway rather than re-tried in a Worker, since a Worker-hosted bundle of this exact
package has its own separate esbuild strictness quirk (the build error above) that's simplest to
avoid by not re-bundling it for a Worker target at all.

Trade-off: detect/filter/dewarp now run on the UI thread instead of off it. Each call is one
bounded operation (spec §17 budgets ~150 ms/page), so this is a brief-UI-block UX regression, not
a correctness one — tracked as follow-up, not silently accepted as fine.

---

## 8. PDF reading and rendering

### 8.1 Classification (`pdf/loader.ts`, main thread — §7a)

Runs directly in `load_files()`, in the same `pdfjs.getDocument()` call that reads page sizes —
no RPC, no separate worker reply. Aggregates: any native page → `Mode.NORMAL`, else
`Mode.SCANNED`; image files always count as non-native.

```ts
// Mirrors spec §4 exactly (is_native_page() in loader.ts)
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
(export) — the WYSIWYG guarantee (spec §12.1, invariant §22.12) holds because both call sites go
through this one method on the one `PdfRendererAdapter` instance, not two implementations.

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
streamed back one at a time so memory stays flat (spec §12.5, §17).

---

## 9. Image processing (`pdf/imaging.ts`, main thread — §7a)

OpenCV.js WASM — loaded once, lazily, on first call (`ensure_cv()`). All operations are
`ImageBitmap` in → `ImageBitmap` out (stateless beyond the cv module itself and the lazy ONNX
session, both process-lifetime singletons — no longer worker-lifetime since there's no worker).

| Spec algorithm | OpenCV.js implementation | Status |
|---|---|---|
| Sauvola binarization | `sauvola_ink_mask()`: `cv.boxFilter` on the image and its square to get local mean/std, `T = mean·(1+k·(std/R−1))`, `ink = flat < T` | **Faithful port** of `core/imaging.py _sauvola_threshold` — real formula, not `cv.adaptiveThreshold` (see history note below) |
| Illumination flatten | `illumination_flatten()`: `cv.morphologyEx(MORPH_CLOSE)` + divide | Implemented, shared by detect and both filter modes (matches `imaging.py`) |
| `clean_document_bilevel` | `clean_document_bilevel()`: flatten → Sauvola → single-pass label-LUT despeckle | Implemented for both `detect_content()` (strength-2 params, downscaled) and the B/W filter (per-strength `k`/`min_area` from `BW_STRENGTH`) — same function backs both, as spec §8 requires |
| Connected-component despeckle | `cv.connectedComponentsWithStats` → per-label keep array → one `O(pixels)` LUT pass (not per-component `cv.compare`, which would be `O(components·pixels)` and miss the spec §17 "single-pass despeckle" performance target) | Implemented |
| `content_box()` | bounding rect of kept components, border-touching fallback | Implemented |
| Unsharp mask (Sharpen) | `cv.bilateralFilter` (strength-scaled `d`/`sigmaColor`/`sigmaSpace` from `SHARPEN_STRENGTH`) → `cv.GaussianBlur` (strength-scaled radius) → `cv.addWeighted` (`CLEAN_AMOUNT` gain) | Implemented, strength now drives denoise/blur radius **and** gain (matches `imaging.py sharpen_grayscale`/`_GRAY_STRENGTH` — the fix for the regression the desktop code comments describe: fixed-denoise Sharpen amplified noise at high strength) |
| DPI-scaled kernels | — | **Not ported.** `imaging.py`'s `_dpi_scale()` scales the Sauvola window / bg-kernel / min-area by source DPI (0.5×–4× clamp) so scans at different resolutions binarize comparably. The web always uses the base `SAUVOLA_WINDOW`/`BG_KERNEL_SIZE` regardless of DPI. Low-severity residual gap — SRC_DPI is fixed at 200 in the web (no variable-DPI source rasters), so this mainly affects the B/W filter's absolute kernel size relative to `imaging.py`'s 150 DPI reference, not correctness. |
| 2× supersample refinement | — | **Not ported.** `clean_document_bilevel` upscales 2× before thresholding then downsamples for a cleaner edge; the web version thresholds at native resolution. Cosmetic quality difference only. |
| Dewarp mesh | `ort.InferenceSession.run()` → mesh field → `cv.remap` | **Not implemented.** `apply_dewarp()` is a stub that returns the source unchanged. This is a real behavioral gap (the Dewarp & Deskew toggle is a no-op on the web today) — see "Dewarp: known gap" below, not a minor fidelity note. |
| Deskew angle | — | Spec §10.1 folds deskew into the single Dewarp & Deskew mesh-unwarp control ("there is no separate deskew step") — there is intentionally no standalone deskew function to port; it ships (or doesn't) together with dewarp. |

`detect_content()` downscales to `DETECT_MAX_PX` for speed (same as Python), then runs
`clean_document_bilevel` on the downscaled raster at the desktop's default strength-2 params —
this is what spec §8 means by "content_box over a real Sauvola filter (clean_document_bilevel)";
earlier revisions of this doc and of `imaging.worker.ts` used a direct `cv.adaptiveThreshold` call
for detection with no relationship to the B/W filter's algorithm at all, which was wrong on two
counts (not Sauvola, and not shared with the filter). Both are fixed.

**Dewarp: known gap, not a fidelity nuance.** Real dewarp requires the actual docuwarp ONNX model
weights, correct input/output tensor wiring (`Int64Session`'s int32→int64 cast, `bilinear_unwarping`
grid semantics — see `core/imaging.py unwarp_bgr`), and pixel-level validation against the desktop
output. That is a substantial, separate porting effort with real numerical-correctness risk if
rushed; it is intentionally out of scope for this pass rather than shipped as an unverified
approximation. `ensure_onnx()` already wires the session-loading/IndexedDB-cache plumbing so a
future pass only needs to implement `apply_dewarp()`'s body.

ONNX model cache (already wired, session unused until `apply_dewarp` is implemented):

ONNX model cache:
```ts
// On first run_dewarp: try IndexedDB, else fetch from CDN, store in IndexedDB
const modelBytes = await load_from_cache('docuwarp-model') ?? await fetch_and_cache(MODEL_URL)
const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['wasm'] })
```

---

## 10. State model (unchanged from desktop)

`DocumentState`, `History`, `Settings`, `DragState` map 1:1 from Python to TypeScript.

The defining rules are preserved:
- `DocumentState` holds exactly the 11 undoable fields; `snapshot()` deep-copies the
  per-page maps and shares the frozen scalars
- `Settings` fields are those consumed by domain commands; `UIConfig` (theme/font/scale)
  is owned by `AppController`, invisible to `core/`
- `History.push()` stores a pre-mutation snapshot; `undo()` pushes current to redo, returns
  the popped snapshot; `AppModel` clears LRU caches on state restore
- `AppModel` is the single state owner; `ui/` reads only frozen `ViewSnapshot` and plain
  property values

LRU cache holds `ImageBitmap` (source rasters) and processed `ImageBitmap` (work rasters),
bounded to `CACHE_WINDOW` pages each. Evicted entries are `ImageBitmap.close()`d (releases GPU
texture memory).

---

## 11. Error taxonomy (same as Python)

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

`core/` raises these; `AppController.dispatch()` / `dispatch_job()` catch them and show
a styled error notification (inline `<div class="error-toast">`, auto-dismisses after 5 s).

Worker errors: worker posts `{type:'error', message}` → caught in worker message handler →
converted to `ImagingError` → passed to `dispatch_job` as `Failed(error)`.

Unhandled promise rejections are caught by a global `window.addEventListener('unhandledrejection')`
handler — clears `_current_job`, hides overlay, repaints, surfaces error. Equivalent to
desktop's `report_callback_exception` recovery.

---

## 12. UI rendering loop

No framework = no virtual DOM. After every model mutation, `AppController.refresh_all()` is
called (same pattern as desktop `AppWindow.refresh_all()`):

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
unconditionally — same pattern as the desktop. No diffing, no reactive state. For a tool of this
complexity (< 20 interactive controls) this is simpler and faster than a framework.

Canvas paint (`canvas_view.paint(snap)`):
1. Draw `snap.image` (page bitmap) centred in canvas
2. Draw overlay boxes (dashed crop frames, handles, split badges)
3. Draw `draw_rect` (rubber-band) if active
4. Draw status text (coordinates + page counter) on the image at top-left with drop shadow
   (spec §3.3, §19)

Throttle: canvas paint is debounced at `SCALE_THROTTLE_MS` on resize. All other refreshes
are immediate (user action → synchronous model mutation → immediate repaint, < 1 ms for non-
imaging ops).

---

## 13. File I/O — implementation

Behavior specified in `docs/SmartCrop_PDF_Specification_Web.md` §W6. Implementation:

**Load:** `<input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff">` + drag-and-drop
on canvas/window. `File` objects passed directly to `loader.ts` (no temp files).

**Export:**
- Single-file formats (PDF): `URL.createObjectURL(blob)` → `<a download>` click → auto-revoke
- Image formats (JPG/PNG/TIFF): every page encoded in `export.worker.ts`, packed into one `.zip`
  with `fflate` (`zipSync`, pure JS ~10KB) → single `<base>.zip` download on all browsers. Entries
  `<base>_NNN.<ext>`. TIFF pages via `workers/tiff.ts`. No per-page loose downloads.
- Overwrite confirmation is **not implemented** (spec Web §W2 row 6) — no code path checks File
  System Access API for an existing file before writing.

---

## 14. Synthetic document

On first load (no file open), render a `SYNTH_PAGES`-page (24) placeholder document using
Canvas API directly (no PDF.js needed) — white pages with grey placeholder text/blocks matching
the desktop's synthetic doc. All controls stay fully usable (spec §1).

Implemented in `pdf/loader.ts` as a special `SyntheticDoc` path that generates
`ImageBitmap` pages on demand without a real file.

---

## 15. Performance targets

Targets specified in `docs/SmartCrop_PDF_Specification_Web.md` §W5. Implementation levers:
LRU `CACHE_WINDOW=16` pages bound resident GPU memory; export streams one page at a time;
`ImageBitmap.close()` is called on LRU eviction to release the GPU texture immediately.

---

## 16. Keyboard shortcuts

Behavior/mapping specified in `docs/SmartCrop_PDF_Specification_Web.md` §W4. Implemented as a
single `keydown` listener in `app.ts` dispatching to the matching `AppModel`/`AppController` call;
`Ctrl +/-/0` scale via CSS `font-size` on `:root` (rem-based layout scales with it).

---

## 17. Theme and typography — implementation

Palette semantics (what each color means, when it's used) specified in
`docs/SmartCrop_PDF_Specification_Web.md` §W3 and desktop spec §19. Implementation: CSS custom
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
number, 30% larger than base font. Status text: drawn on canvas with `ctx.shadowBlur` drop shadow.
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
| OpenCV.js WASM (imaging.worker) | ~8 MB (lazy; scanned mode only) |
| ONNX Runtime Web (lazy) | ~8 MB (lazy; dewarp only) |
| docuwarp model (lazy, IndexedDB) | ~10 MB (once per session, cached) |

Normal-mode users (the majority) download ~500 KB total.
Scanned-mode users load the 8MB OpenCV chunk once on first filter/detect press.
Dewarp adds another 18MB one-time download, cached indefinitely in IndexedDB.

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
- No function over 30 lines without a why-comment (same rule as desktop CLAUDE.md)
- No magic numbers — all tunables in `src/core/constants.ts` (domain) or `src/ui/constants.ts` (UI)

---

## 20. Spec invariants coverage (§22)

Gaps against these invariants are tracked in `docs/SmartCrop_PDF_Specification_Web.md` §W2, not
here. Every §22 invariant is exercised by at least one test:

| Invariant | Test file |
|---|---|
| §22.1 Auto-detect union crop | core/model.test.ts + e2e/crop.spec.ts |
| §22.2 Non-dragged edges pixel-stable | core/geometry.test.ts |
| §22.3 Filter/dewarp idempotent | e2e/scan.spec.ts |
| §22.4 Undo reverts; Reset reloads | e2e/history.spec.ts |
| §22.5 Rotate preserves crop; Delete reindexes | e2e/pages.spec.ts |
| §22.6 No implicit scan processing | e2e/scan.spec.ts |
| §22.7 Crop rectangles clamped to page | core/geometry.test.ts |
| §22.8 Batch overlay, cancel, no partial file | e2e/export.spec.ts |
| §22.9 Memory flat (LRU) | core/lru.test.ts |
| §22.10 Main-thread PDF.js — N/A (workers handle it safely) | architecture.test.ts |
| §22.11 Split nav as N output pages | e2e/crop.spec.ts |
| §22.12 WYSIWYG — same render_output_image path | e2e/export.spec.ts |
| §22.13 Drawing is local | e2e/crop.spec.ts |
| §22.14 Page always in window | ui/canvas_view.test.ts |
| §22.15 Crop never dropped | e2e/crop.spec.ts |
| §22.16 Re-detect refreshes committed crop | e2e/crop.spec.ts |
| §22.17 Multi-file combine order | core/model.test.ts |
| §22.18 Classification by vector data | core/model.test.ts |
| §22.19 Keep ratio all gestures | core/geometry.test.ts + e2e/crop.spec.ts |
| §22.20 Compress downsamples, never larger | e2e/export.spec.ts |
| §22.21 Export formats + streaming | e2e/export.spec.ts |
| §22.22 Greyscale via one render path | e2e/export.spec.ts |
| §22.23 Icon labels unchanged | ui/panels.test.ts |
| §22.24 Cancel drag — no commit, no snapshot | e2e/crop.spec.ts |

**§22.23 note:** the spec prose ("never concatenated into the label string") describes the
desktop's `image=` `CTkImage` pictogram convention (Settings/Help/Load/Save/Crop/Rotate — a
handful of "primary action" buttons per spec §19). The *actual* desktop code (`ui/panels.py`)
bakes a leading glyph character into the button string for most other controls — Undo/Redo/Reset,
Auto-detect, Crop/Rotate/Delete (`"✶  Auto-detect"`, `"↪  Redo"`, …) — and the real, code-level
invariant `test_app.py` checks is a **string-prefix** rule (glyph leads, e.g. `"↪ Redo"` not
`"Redo ↪"`), not "no glyph in the string at all." The web mirrors the actual code: buttons keep
plain glyph-prefixed label strings (`nav_bar.ts`, `crop_panel.ts`, …), and the ported
`panels.test.ts` should assert the same string-prefix rule, not a DOM-level icon/label split that
the desktop itself doesn't have.

---

## 21. What does NOT change

See `docs/SmartCrop_PDF_Specification_Web.md` §W7 for the full behavioral invariant list. All four
export formats (PDF/JPG/PNG/TIFF) are supported; the desktop's N-loose-files behavior for image
formats is replaced by a single `.zip` (§13), which is the web-correct equivalent.
