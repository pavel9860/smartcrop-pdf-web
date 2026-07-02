# SmartCrop PDF — Build Specification

A desktop utility to combine, crop, straighten, clean and compress PDFs, scanned documents and
images for reading on e-readers, phones and tablets. It loads one or many files (PDFs and/or
images) into a single working document, crops/filters/compresses them, and exports as PDF or a
chosen image format. This document is the complete contract: an implementer can build the
app from it alone. It defines architecture, UI, algorithms, state and acceptance invariants —
logic and layout only, no source code.

**Reading guide.** Each fact has one home section; later sections cross-reference it (e.g. "(§9)")
rather than restating it. The two sections most worth getting exactly right — because mistakes
there cause real bugs — are **§9 Crop windows \& drag** and **§10 Scan processing**; both are
written as explicit state models.

## Contents

1. [Purpose \& scope](#1-purpose--scope)
2. [Stack \& dependencies](#2-stack--dependencies)
3. [Architecture \& modules](#3-architecture--modules)
4. [Modes \& classification](#4-modes--classification)
5. [Coordinate system \& page view](#5-coordinate-system--page-view)
6. [Window layout](#6-window-layout)
7. [Control reference](#7-control-reference)
8. [Auto-detect algorithm](#8-auto-detect-algorithm)
9. [Crop windows \& drag](#9-crop-windows--drag)
10. [Scan processing pipeline](#10-scan-processing-pipeline)
11. [Pages selection](#11-pages-selection)
12. [Apply \& export](#12-apply--export)
13. [History, reset, rotate, delete](#13-history-reset-rotate-delete)
14. [Progress overlay \& batch model](#14-progress-overlay--batch-model)
15. [Settings](#15-settings)
16. [Help](#16-help)
17. [Performance \& memory](#17-performance--memory)
18. [Constants](#18-constants)
19. [Typography \& theme](#19-typography--theme)
20. [Error handling \& edge cases](#20-error-handling--edge-cases)
21. [Shortcuts](#21-shortcuts)
22. [Acceptance invariants](#22-acceptance-invariants)

\---

## 1\. Purpose \& scope

Load one or several files at once — any mix of PDFs and images (`.jpg/.jpeg/.png/.tif/.tiff`) —
**combined into one working document in selection order** (§7.1). Crop pages (an auto-detected
content box, a hand-drawn rectangle, or a 2/4-up split), optionally dewarp/deskew/filter scanned
pages, **compress** every page to a target DPI, optionally **remove colours**, and export — as PDF
or as JPG / PNG / TIFF (§12). Two workflows share one window; the scanned workflow adds a
raster-processing stage. With no file open, a synthetic placeholder document is shown so every
control is usable immediately.

**Out of scope:** OCR / searchable text, a thumbnail page picker, and N×M auto-grid split.

\---

## 2\. Stack \& dependencies

Python 3.10+. **GUI:** CustomTkinter (Fluent / Windows-11-style themed widgets — rounded cards,
segmented buttons, switches, built-in UI scaling and Light/Dark/System appearance) over a
`tk.Canvas` for the page view. **PDF:** PyMuPDF (`pymupdf`, imported as `fitz`). **Imaging:**
OpenCV (`opencv-python`), NumPy, scikit-image, Pillow. **Dewarp/deskew:** `docuwarp` +
`onnxruntime`.

Packaging note: the real PDF dependency is **`pymupdf`**. An unrelated PyPI package named `fitz`
also exists and must never be installed — it shadows PyMuPDF.

\---

## 3\. Architecture \& modules

Pure, Tk-free logic is separated from UI for testability. **Everything runs on the main thread;**
long jobs are processed one page per Tk tick (§14) as cooperative batch jobs, so the UI stays
responsive without the complexity — or all-pages-resident memory cost — of a worker pool.

The app is **two layers with one direction of dependency**. A **Tk-free domain layer** (`core/`)
owns all state and logic behind a single facade, **`AppModel`**; a **UI layer** (`ui/`) builds the
CustomTkinter widgets and the page canvas, calls only `AppModel`'s public methods, and reads only
the frozen value objects they return. `ui/` imports `core.*`; **`core/` never imports `ui`,
`tkinter` or `customtkinter`** — a violation is a build failure. The deeper design (state
ownership, the `AppModel` interface, the batch/threading model, the error taxonomy) lives in
`ARCHITECTURE.md`; this section is the module map and the rules that bind it.

```
main.py             the ONLY entry point  (python main.py -> ui.app\_window.main)
core/               Tk-free domain layer — no tkinter / customtkinter / ui import, ever
  model.py          AppModel: the single facade — owns state, exposes commands + queries
  document\_state.py DocumentState (the undoable state) + Offsets + PageProcessIntent; snapshot()
  settings.py       Settings — live output/behaviour values a domain command reads (outside history)
  history.py        History — bounded undo/redo of DocumentState snapshots
  drag.py           DragState tagged union (Auto/Split/Draw/CropEdit) — transient gesture state
  batch.py          BatchJob protocol + BatchResult (Ok/Cancelled/Failed) + Detect/Scan/Export jobs
  errors.py         SmartCropError taxonomy — raised in core, caught only in ui
  geometry.py       Box, crop-rect math, drag/resize/move, union\_box, auto\_crop\_rect   (pure leaf)
  render.py         crop / compress (DPI) / remove-colours — the ONE image path (preview+export)
  detect.py         per-page content-box detection helpers (§8) — pure, stateless
  export.py         export job builders + per-page encoders (§12.5–§12.7) — stream one page/tick
  synthetic.py      the placeholder demo document (§1) — page sizes, text boxes, rasters
  viewmodel.py      output-page navigation math (committed splits expand to N views)
  imaging.py        cv2/numpy primitives (Sauvola filter, deskew, content\_box, dewarp, Sharpen)
  parsing.py        page-selection parsing (all/odd/even/ranges/slices)
  enums.py          Mode / FilterMode / PagesMode (str-backed Enums)
  lru.py            LRUCache — page-keyed raster cache bound (flat memory)
  constants.py      domain tunables + DPI compression presets + export formats (§18)
ui/                 presentation layer — imports core.*; core never imports ui
  app\_window.py     AppWindow: root window, owns one AppModel, dispatch()/dispatch\_job() (the only
                    error catch sites), drives BatchJobs via root.after, scaling, shortcuts, main()
  canvas\_view.py    page canvas: paints from AppModel.view\_snapshot(); translates mouse events to
                    page-unit coords -> model.begin\_drag/update\_drag/end\_drag/cancel\_drag
  overlay.py        progress overlay driven by a BatchJob handle
  panels/           crop / pages / output control cards
  settings\_window.py help\_window.py widgets.py theme.py help\_content.py   (Settings/Help, ToolTip/Spin, palette)
  config.py         UIConfig — presentation-only state (theme / font / scale / dialog toggles)
  constants.py      UI tunables (handle sizes, window/panel geometry, throttles)
tests/              core/ unit tests (no Tk) + ui/ wiring tests + test\_architecture.py import guard
docs/               this specification + goals + test spec
```

**Dependency rule.** One direction only: `ui/` → `core/` → pure leaves; **no upward imports**.
`core/` is mechanically forbidden from importing `tkinter`, `customtkinter` or `ui` (asserted by
`tests/test_architecture.py`), which is what makes the whole domain layer unit-testable headless.
Tunables live in `constants.py` (§18), split into a domain set in `core/` and a presentation set
in `ui/`; a few fixed canvas / dialog point sizes are still inline.

**State, threading, errors.** `AppModel` is the single state owner. `DocumentState` holds exactly
the **undoable** fields, snapshot-copied into `History` (§13); live output/behaviour `Settings`
(compress DPI, colours, format, folder, postfix, undo depth, dewarp supersample) and presentation
`UIConfig` sit **outside** history, so they survive Undo (§22). All PyMuPDF and Tk work is on the
main thread; a long operation is a `BatchJob` the window steps one page per `after` tick (§14).
`core/` raises typed `SmartCropError`s for every expected failure (§20) and never opens a dialog —
`ui/`'s `dispatch()` is the one place they are caught and shown. Unhandled Tk-callback exceptions
go to a global handler that restores a usable state and surfaces a dialog (§20).

\---

## 4\. Modes \& classification

On load every page of the combined document (§7.1) is classified, and the document mode follows
from whether **any** page carries vector data:

```
page\_is\_native = len(text(page).strip()) >= MODE\_TEXT\_MIN  OR  page has any vector drawing path
document\_mode  = NORMAL if any page\_is\_native else SCANNED      # SCANNED only when \*everything\* is images
```

**A PDF is Normal (native) if it contains any vector data** — real text or vector drawings on at
least one page. It is **Scanned only when every page is an image** with no vector content (a pure
photographed/scanned book, or a document built from loaded image files, §7.1). Incidental text
below `MODE\_TEXT\_MIN` characters and pages with no drawing paths do not count as vector data, so a
scan carrying a stray invisible-OCR fragment or a thin scan-edge line still classifies Scanned.

|Mode|Page unit|Stage chain|
|-|-|-|
|**Normal**|PDF points|detect/draw → adjust → crop → compress → export|
|**Scanned**|raster px @ SRC\_DPI|dewarp? → filter? → detect/draw → adjust → crop → compress → export|

Both modes ultimately **export raster** (§12): the crop is rendered to pixels and embedded as an
image. Normal pages render at `NORMAL\_DPI`, scanned pages at `SRC\_DPI`; **Compress** (§7.6, §12.6)
then resamples each embedded image to the chosen output DPI.

The mode is shown as a **non-interactive badge** on the Document card title line (`NORMAL` /
`SCANNED`); it is set by classification on load and is not user-toggled. The Scan-Processing card
(§7.2) is shown only in scanned mode.

**State is enum-typed, not stringly-typed.** `Mode` (`NORMAL`/`SCANNED`), `filterMode`
(`NONE`/`BW`/`SHARPEN`) and `PagesMode` (`ALL`/`ODD`/`EVEN`/`SELECT`) are `str`-backed `Enum`s in
`core/enums.py`: named members prevent typos while `str` backing keeps the pure parsers free of
boundary conversion.

### 4.1 The two pipelines

**Normal pipeline** (born-digital). No raster pre-processing and the Scan-Processing card is hidden:

```
load → classify NORMAL → set the crop (Auto-detect text box, a hand-drawn rectangle, or a 2/4
       split) → adjust (anchors / offsets / drag) → Apply → compress → export
```

The page is rendered to pixels only at export, at `NORMAL\_DPI` (§12.1). Everything else — crop
windows (§9), pages selection (§11), split (§7.3), compress (§7.6), history/rotate/delete (§13) — is
identical to scanned mode.

**Scanned pipeline** (page images). The same chain with a raster stage in front:

```
load → classify SCANNED → \[Dewarp \& Deskew?] → \[Filter B/W or Sharpen?] → set the crop →
       adjust → Apply → compress → export
```

The raster stage (source/work rasters, dewarp, filter) is detailed in §10; export is at `SRC\_DPI`.

\---

## 5\. Coordinate system \& page view

All geometry is in **page units**: PDF points (Normal) or raster pixels at `SRC\_DPI` (Scanned).
Canvas mapping:

```
canvas\_x = page\_x · scale + img\_x          page\_x = (canvas\_x − img\_x) / scale
scale    = min((cw − CANVAS\_MARGIN)/page\_w, (ch − CANVAS\_MARGIN)/page\_h)   # fit, aspect kept
img\_x, img\_y = centre the fitted bitmap in the canvas
```

Offsets (§9) are **percent of the current page dimension**, so they are resolution-independent. One
geometry/render code path serves both modes.

**The page view is always fit-to-window.** `scale` is recomputed on every render and on canvas
resize, so the whole page (or the whole committed crop) is always fully inside the canvas in both
axes — it is never magnified out of view. **There is no page zoom.** The **mouse wheel over the
canvas turns pages** (up = previous, down = next). (`Ctrl +/-` scales the whole UI, §15 — that
resizes widgets, not the fitted page.)

\---

## 6\. Window layout

Two panes split by a draggable sash. **Left** = a scrollable control stack, plus a
Settings/Help + history + page-nav card **pinned to the bottom of the panel, outside the scroll
area** (packed `side="bottom"`): always visible, never a floating duplicate under Export, never
needing a scroll to reach. The panel keeps a fixed width (`pack\_propagate(False)`). **Right** = the
page canvas with a centred inline progress overlay (§14). **No text is drawn on the page image
itself** — the output-page position lives in the pinned nav bar (§7.8) only. While the pointer is
over the page, its **coordinates** (`x nn.n%  y nn.n%`, percent of the page) show in a small
read-out label **at the bottom-right corner of the right pane** (white text, the shared status
font, §19); it empties when the pointer leaves the page. **Hover nav arrows**: while the pointer
is over the canvas, a `◀` / `▶` button pair appears at the vertical middle of the canvas's left
and right edges (same styling as the bottom nav buttons, §7.8) and turns one output page per
click; both hide when the pointer leaves the canvas, and each disables at its end of the document
exactly like the bottom nav buttons (§7.8).
Scanned-only sections pack/unpack with no residual gap.

Card order, top → bottom: **Document \& State**, **Pages to Process** (the page-scope selector),
**Scan Processing** (scanned only), **Split Each Page Into**, **Detect Text Borders**, **Advanced**
(collapsible, holds the offsets), **Actions** (Crop / Rotate / Delete), **Compress Document**,
**Export**. **The page scope is declared once near the top** so every operation that reads it — Scan
Processing, Auto-detect, Split-apply and the Actions — sits below it and never needs a scroll back
up to change the page set; the Actions card sits **after** the crop setup (Split/Detect/Advanced) so
Crop follows its configuration. The pinned bottom card holds **Settings/Help**, then **Undo / Redo /
Reset**, then the page nav.

```
+SmartCrtopPDF  Name of the opened file-+----------------------------------------------+
| \[ Document \& State --\[ NORMAL ]|                                              |  badge on the title line
|  \[ (\*)Load PDF/Image Files   ] |              page bitmap                     |  (PDFs and/or images)
| ]------------------------------|   crop frame: corners resize, borders move,   |
| \[ Pages to Process ------------|           dashed = kept area                 |  scope for everything
|  \[All]\[Odd]\[Even]\[Selected]    |                                              |   below (§7.5)
|  Pattern \[ 1,3,5-9 ] \[Current] |   row appears only under Selected            |
| ]------------------------------|                                              |
| \[ Scan Processing -------------|        +--------------------------+          |  (scanned mode
|  \[  (\*) Dewarp \& Deskew      ] |        |  Cleaning pages...       |          |   only)
|  \[ Filter ------------------- ]|        |  ####### . . . 124 / 312 |          |  overlay shows
|  | \[   B/W   ] \[ Sharpen   ] ||        |          \[ Cancel ]      |          |  only while busy
|  | Strength                    ||        +--------------------------+          |  (§14)
|  | \[ 1 ] \[ 2 ] \[ 3 ]        ||   3 button same width for whole tab         |
|  ]--------------------------- ]|                                              |
| ]------------------------------|                                              |
| \[ Split Each Page Into --------|                                              |
|  \[ 1 ] \[ 2 ] \[ 4 ]             |   segmented; per-option tooltip              |
|  ( ) Same size                 |   switch, shown only for 2 / 4               |
|  ( ) Keep ratio       \[ 1.500 ]|   ratio field is editable                    |
| ]------------------------------|                                              |
| \[ Detect Text Borders ---------|                                              |
|  \[   (\*) Auto-detect        ]  |                                              |
|  ( ) Anchor Left ( ) Anchor Top|   both anchors on one line (§7.4)            |
| ]------------------------------|                                              |
| \[ ▸ Advanced ------------------|   collapsed by default; arrow toggles it     |
|  | Set offsets    ↳            ||   (expanded ▾ shows the offsets, §7.4a)    |
|  | L\[0.0] T\[0.0] R\[0.0] B\[0.0] ||   one offset per edge (§9), one line,       |
| ]------------------------------|   all four always visible (§7.4a)           |
| \[ Actions ---------------------|                                              |
|  \[     (\*)    Crop           ] |   one full-width action button (§7.7)        |
|  \[ (\*)Rotate   ]\[ (\*)Delete  ] |   two on the line below Crop                 |
| ]------------------------------|                                              |
| \[ Compress Document -----------|                                              |
|  \[ Original resolution      v] |   DPI menu (Original/High/Medium/Low, §7.6)  |
|        [ Original colors                            v]    |   colour menu (Original/Grayscale, §7.6)               |
| ]------------------------------|                                                |
| \[   (\*) Export PDF         |▾] |   split button; ▾ picks PDF/JPG/PNG/TIFF     |
| ..............(scroll).........|                                              |
| \[ pinned, outside the scroll --|                                              |
| \[ (\*) Settings ] \[ (\*)Help   ] |                                              |
| \[ ↩ Undo ]\[ ↪ Redo ]\[ ⟲ Reset]|                                             |  3 equal buttons (§7.8)
| \[ < ]  \[ 3 ] / 312  \[ > ]     |                x 34.2%  y 12.7% ← pane corner |
+ -------------------------------+----------------------------------------------+
|                                 | (cursor read-out, bottom-right of the pane)    |
```



* corresponding Icons
The drawing above is **Scanned** mode. **Normal** mode is identical minus the Scan-Processing card
(hidden, §7.2). The **Advanced** card is collapsed by default in both modes; the offsets appear only
when its arrow is expanded (§7.4a).

\---

## 7\. Control reference

Every control carries a hover tooltip. The subsections below are grouped **by function**; the
authoritative top→bottom card order is the layout in §6 (so e.g. Pages to Process, §7.5, is
positioned near the top even though its subsection number falls later). The Settings/Help + history

* nav card is pinned at the bottom (§6).

### 7.1 Document \& State

|Control|Action|
|-|-|
|**Mode badge** (title line)|Non-interactive `NORMAL`/`SCANNED` marker; set by classification on load (§4).|
|**Load Files** (full width)|Open **one or many** files at once (Ctrl+O) — any mix of PDFs and images (`.jpg/.jpeg/.png/.tif/.tiff`). The selected files are **combined into one working document in selection order** (§7.1a) → **reset all per-document state** (crops, rotation, detection, processing, history — the same clearing as Reset, §13) → classify → set mode.|

**Undo / Redo / Reset** live in the pinned bottom card (§7.8), not in this card.

#### 7.1a Multi-file load \& combine order

Load Files opens a multi-select dialog filtered to PDFs and the supported image types. The chosen
inputs are concatenated into **one** working document, each contributing its pages in order:

* **PDFs** contribute all their pages, in document order.
* **Images** each become **one page** sized to the image (one image = one page).

The **order of the combined document is the order the dialog returns the selection**:

* Picked **one-by-one** (individual Ctrl-clicks) → the files keep the **order they were clicked**.
* Selected as a **contiguous range** (Shift-click) or **Select-All** (Ctrl+A) → the files follow
**directory order** (the dialog's listing order, i.e. by name).

A document built entirely from images (no vector data) classifies **Scanned** (§4); a mix that
includes any native PDF page classifies **Normal**. After load, the window title and page count
reflect the combined document.

### 7.2 Scan Processing *(scanned mode only)*

|Control|Action|
|-|-|
|**Dewarp \& Deskew** (toggle, highlights when on)|Set the dewarp intent over the Pages selection; always recomputed from the immutable source, so it is idempotent (§10).|
|**Filter** block (bordered; section-styled title)|Groups the filter controls.|
|**B/W** / **Sharpen** (mutually exclusive, highlight the active one)|Set the filter mode over the Pages selection; pressing the active one turns it off.|
|**Strength 1 / 2 / 3**|Three levels; always selectable, whether or not a filter mode is currently active. The chosen strength applies when a filter mode is turned on.|

Nothing here runs automatically — only on a button press.

### 7.3 Split Each Page Into

`1 / 2 / 4` → **1, 2 or 4 output pages per source page** (split is part of the crop: on export the
output page count is *source pages × N*, §12). Selecting N > 1 disables Detect, anchors and offsets
(manual split is the crop source) and shows the **Same size** toggle. It **auto-creates the N split
windows** as an even grid (§9.6), in reading order; a numbered badge 1..4 is drawn inside each, and
each can be **moved** (drag inside) or **resized** (drag a handle). **Apply is enabled only when
exactly N rectangles exist.** Changing the split count
**clears any committed crop from the previous mode** (those crops belonged to a different layout),
so the new split always governs the output.

**Same size** (toggle, shown only for 2/4): when ON, every split window is kept the same size —
dragging one resizes all of them to match on release, each anchored at its own corner.
**Keep ratio** (§7.4) also applies: a dragged split rectangle is snapped to the ratio on
release.

### 7.4 Detect Text Borders *(split = 1)*

|Control|Action|
|-|-|
|**Auto-detect**|Run detection over the Pages selection (§8). It is an **action, not a toggle**: never highlighted, always re-pressable. Disabled only when Split > 1, both anchors are OFF, or a batch is running.|
|**Anchor Left / Anchor Top** (toggles, **on one line**)|Left/top edge from *this page's* detected content (ON) or the union edge (OFF). At least one anchor must be ON for a crop to exist.|
|**Keep ratio** (toggle) + ratio field|When ON, the crop height is locked to `width / ratio` for **every** crop source — live auto crop, handle drag/move, offset edits, a hand-drawn window and split rectangles, in both modes (§9.7). The ratio field is editable and **pre-populates with the current page's width / height** before detect runs (§7.1a); editing it updates the ratio for all following crops. The row's label and switch are compact (`ROW_LABEL_W`, `SWITCH_W`) so the field itself gets `RATIO_FIELD_W` — wide enough to show four significant digits without clipping.|

Re-running **Auto-detect refreshes** the committed crop on the pages it re-detects to the fresh auto
crop — detection takes visible effect after a crop **without dropping it** (the page stays cropped,
only its box updates; undoable). Pages **outside** the current selection keep their crops, so you
can crop one page-set with one pattern and another set with another (§9, §12).

**A new box always starts clean (inv 35).** Detect and draw both route through the same
set-active-box semantics: the press/release **drops whatever live window was active** — Auto-detect
immediately replaces a drawn window (never waiting for a manual Esc, §9.4) — and **resets the four
offsets to 0** before the new box appears, so no stale offset warps a fresh detection or drawing.

### 7.4a Advanced — offsets *(collapsible; split = 1)*

The per-edge offsets live in their own **Advanced** card, **separate from Detect Text Borders** and
**collapsed by default**. A header arrow toggles it (`▸ Advanced` collapsed / `▾ Advanced`
expanded). Expanded, it shows a **"Set offsets ↳"** label above the four fields, laid out **on one
line** (`L T R B`), each field compact enough (`OFFSET_FIELD_W`) that **all four are fully visible
inside the fixed-width panel** — never clipped or pushed off the row:

|Control|Action|
|-|-|
|**L  T  R  B** offsets (±`OFFSET\_LIMIT`, step 0.1)|Per-edge percent offsets; each moves exactly one edge (§9). On commit (Return / focus-out) each value is **snapped to the largest the page allows** — an out-of-range entry (e.g. 100000) is reduced to the value that lands the edge on the page border, never kept verbatim.|

The arrow state is purely cosmetic (it hides/shows the fields); the offsets keep their values and
keep driving the live crop whether the card is open or closed.

### 7.5 Pages to Process

See §11. Buttons `All · Odd · Even · Selected`; **Selected** reveals the Pattern field and the
Current follow-toggle. This card is **placed near the top of the stack** (right under Document \&
State, §6) because the selection it defines is the scope every operation below reads — Scan
Processing, Auto-detect, Split-apply and the Crop / Rotate / Delete Actions (§7.7). Declaring the
scope once up top means changing the page set never requires scrolling back up. It is a
**selector only** — the action buttons live in the Actions card (§7.7).

### 7.6 Compress Document

### 7.6 Compress Document

A DPI menu: `Original resolution`, `High — 300 dpi`, `Medium — 150 dpi`, `Low — 75 dpi`. **Compress
resamples every embedded page image to the chosen DPI and writes a leaner file**, applied **last**,
after crop (§12.6). `Original resolution` keeps the native crop pixels (no downsample). Lower DPI =
smaller output. Below it, an **Output colours** menu: `Original colors`, `Grayscale` — Grayscale
desaturates every output page (tonal range preserved, no thresholding), applied **after** Compress,
via the one render path (§12.1); `Original colors` leaves each page's existing colour state
untouched. The export also **fixes wasteful encoding** (re-encode, deflate, garbage-collect), so the
result is never larger than a naïve re-save (§12.6).

### 7.7 Actions

A dedicated card placed **after Advanced, before Compress** (§6), so the actions follow their crop
setup (Split/Detect/Advanced). **Crop** is a single full-width button (commits and shows the crop).
**Crop is enabled only when a crop source exists** — at split = 1 that means an active detection
(Auto-detect has run and ≥ 1 anchor is ON) **or a drawn crop window on a selected page**; at
split 2/4, exactly N rectangles (§7.3). With no source, Crop **does nothing**: it never commits
full-page boxes and never takes a history snapshot (detect or draw first — one of them is the
prerequisite for Crop; the drawn window is the per-page one,
§9.4 — Crop commits it).
Directly below it, **one row of two**: **Rotate** (90° CW, preserves filtering and the crop) and
**Delete** (removes the Pages selection). All three act on the **Pages to Process** selection (§7.5).
The full-width **Export** split button (§7.7a) sits in its own row below the Compress card.

### 7.7a Export (split button)

**Export** is a **split button**: the main face exports in the current format (default **PDF**); its
**▾ dropdown** chooses the format — \*\*PDF · JPG · PNG · TIFF \*\* (§12.7). The main face label
tracks the chosen format (`Export PDF`, `Export JPG`, …). Ctrl+S triggers the main face.

### 7.8 Settings / Help, history \& nav

The pinned bottom card holds three rows: **Settings** + **Help**; then **Undo / Redo / Reset** (3
equal buttons — Undo/redo cover dewarp, filter, crop, rotate at the Undo/redo-depth setting, **default
4**; **Reset re-opens the whole document**, §13; each label leads with its glyph, `↪ Redo` not
`Redo ↪`); then page nav `< \[ n ] / total >` — arrows hug the edges, the page box takes the middle
so current/total stay visible up to four digits. `total` is the **output**-page count (committed
splits expand to N each, §12), so navigation walks every split in order and the page count always
matches what nav shows. **Prev disables on the first output page, Next on the last (both on a
one-page document), and the states refresh on every navigation path** — buttons, hover arrows,
wheel, keyboard, and the jump box (inv 37). Pinned at the bottom of the panel, outside the scroll
area (one instance only).

\---

## 8\. Auto-detect algorithm

Detection yields a **per-page content box** `B\_p = (x0,y0,x1,y1)`; anchors and offsets (§9) turn it
into the crop rectangle. Per page over the Pages selection:

* **Normal:** the union of text blocks (`get\_text("blocks")`, text type only):
`x0 = min bx0 ... y1 = max by3`. A page with no text → the full page rect.
* **Scanned:** `content\_box` over a real **Sauvola** filter (`clean\_document\_bilevel`) of the page,
downscaled to `DETECT\_MAX\_PX` for speed. Sauvola flattens a photographed page's tinted background
so the ink mask is the text, not the whole sheet (a global Otsu would mark tinted paper as ink and
return a page-border box). No ink → the full page rect.

Then aggregate across the selection to fix **one constant crop size** for the whole document:

```
gL = min(x0)            gT = min(y0)                # top-/left-most corner (anchor-OFF base)
W  = max(x1 − x0)       H  = max(y1 − y0)           # LARGEST content width / height across pages
union = (gL, gT, gL+W, gT+H)
```

`W,H` is the *largest* content box found, **not** the bounding span of all edges (which would
over-crop). So every page crops to the same `W×H`. **Full-page fallback boxes are excluded from the
aggregate** (any page whose detected box is >= `FULL\_PAGE\_FRAC` of the sheet in both axes), otherwise
one failed page would blow `W,H` up to the sheet size. Per-page boxes and the union are cached.

`content\_box(bilevel)` (robust to scan artifacts):

```
ink        = bilevel < 128
components = connected\_components(ink, 8-connectivity)
keep       = components with area >= MIN\_COMP\_FRAC · page\_area
                 AND not touching the outer BORDER\_FRAC margin   # drop scan-edge lines, shadow, holes
if keep is empty:  keep = components with area >= MIN\_COMP\_FRAC · page\_area   # fallback
box        = bounding rectangle of the kept pixels
```

Detection is non-destructive and deterministic; it is always safe to re-run.

**Rotation-aware mapping.** Detection always returns boxes **in the rotated page's coordinate
space**: the scanned path reads the already-rotated work raster; the native path reads the
document's text blocks (unrotated) and rotates the resulting box by the page's current rotation
before caching it. Detecting after a rotation therefore equals rotating after a detection (inv 29).

\---

## 9\. Crop windows \& drag

This is the core interaction model. Read it as a small state machine — getting it wrong is the main
source of bugs.

### 9.1 The three crop sources

At any moment a page's crop comes from exactly one of:

1. **Live auto crop** — computed on the fly by the geometry in §9.2 from the cached `union` frame +
anchors + offsets. Exists only when **split = 1**, auto-detect is active, and >= 1 anchor is ON.
Drawn on the page as a dashed frame with **corner handles** (resize) and **border handles** (move
one edge). Dragging inside the rectangle (away from handles) moves the whole box.
It is **global**: the four offsets are shared, so editing it changes the live crop on every page.
2. **Drawn crop window** — `drawn`, the **one** rectangle you **rubber-band by mouse** at
split = 1 (§9.4). It behaves **exactly like the Auto-detect frame — the only difference is that
its position and size come from the mouse**: it is global (shown on **every** uncommitted page,
clamped to each page's extent), a **live window, not a commit** — the same dashed frame with
handles, movable/resizable — and while it exists it **overrides the live auto crop everywhere**.
`Esc` / right-click (outside a drag) **drops it** (§9.4); **Crop commits it over the Pages
selection**. It rotates with the pages.
3. **Committed crop** — `applied\[page]`, a per-page list of one box (single) or N boxes (split).
Set by **Apply/Crop**, or **refreshed by re-detect** (§7.4). It is the **saved state**, covered by
Undo. A committed page is shown **exactly as it will be saved** (§12.1) — a single crop as the
cropped, resized image; a 2/4 split as its N output pages (§12.3). It **stays shown cropped while
you edit it**; only **Undo** or **Reset** returns the page to its full extent. The crop is never
dropped (§9.5).
4. **Split rectangles** — `crop\_rects`, the up-to-N rectangles you adjust by mouse when split =
2/4 (§7.3, §9.6). Directly draggable/resizable; each becomes an output page on Apply.

### 9.2 Live auto-crop geometry (per page)

`w,h` = page size; offsets are percent of the page dimension:

```
left\_base = AnchorLeft ? B\_p.x0 : gL          # ON: this page's content left;  OFF: union-min left
top\_base  = AnchorTop  ? B\_p.y0 : gT          # ON: this page's content top;   OFF: union-min top
left   = left\_base − L%·w                       right  = left\_base + W + R%·w
top    = top\_base  − T%·h                       bottom = top\_base + H + B%·h
fit \[left, top, right, bottom] onto the page — if it overhangs, SHIFT inward (the opposite
#                                                edge extends) to keep the constant W×H; shrink a
#                                                side to the page (>= MIN\_RECT) ONLY if W/H > page
```

**Each offset moves exactly one edge.** Right/bottom are anchored to `left\_base+W` / `top\_base+H`
(the constant size), **not** to the moved left/top — so dragging one edge never drags its opposite.
Anchors affect only left/top. Width and height stay the constant `W,H`, so the box is the **same
size on every page**; R/B enlarge it uniformly. **If an anchored box would fall off a page edge it
is shifted inward — its opposite edge extends to take up the slack — never shrunk** (the constant
`W×H` is preserved on every page); a side is reduced only when `W`/`H` itself exceeds the sheet.
**Keep ratio** locks height to `width/ratio` (anchored at the top) on every render.

### 9.3 Mouse gestures (single crop, split = 1)

A single-crop page is set by **mouse** **or** by Auto-detect (§8) — both available. The canvas always
shows the page **at its current crop**: a page with **no committed crop** is shown **full** (so you can
place the crop — the rectangle + handles are drawn on it); a **committed** page is shown **cropped**
(its saved look, §12.1) and **stays cropped while you edit it** — it never flips back to the full page
on its own. **Undo** or **Reset** is the only way back to the full extent. The gestures on an
**uncommitted** page (the rectangle being the drawn window if one exists, else the live auto crop):

|Press / drag|Result|
|-|-|
|a **border** line|move just that edge|
|a **corner**|resize (moves the two edges meeting at that corner)|
|**inside** the rectangle (away from handles)|move the whole rectangle|
|**empty area**|rubber-band a **new drawn window** (§9.4 — replaces the current window and overrides the auto frame; **the view scale never changes**: the page stays full-size until Crop commits)|
|**Esc** / **right-click** during a drag|**cancel** — discard the in-progress drag, commit nothing, take no history snapshot; the crop is left exactly as before the drag|
|**Esc** / **right-click**, no drag in progress|**drop the current live window**: the drawn window if one exists, **else deactivate the Auto-detect frame** (detection results stay cached; pressing Auto-detect re-activates them). With neither, nothing changes|

On a **committed** page (split = 1) the one gesture is drawing, and it works the same way: the
rubber-band (in the shown output's coordinates, mapped back to page coordinates) becomes the
**global drawn window** — shown over the cropped view with no zoom change — and **Crop**
re-commits the selection through it (§9.4, §12.2). Everything else does nothing (§9.5).

**Keep ratio** (§7.4), when on, holds `width/ratio` through any of these. Editing the **auto** crop
writes offsets; editing the **drawn window** writes the window itself:

```
L = (left\_base − new.left)/w·100        R = (new.right  − (left\_base + W))/w·100
T = (top\_base  − new.top )/h·100        B = (new.bottom − (top\_base  + H))/h·100
```

### 9.4 Drawing creates the live crop window — not a commit

A rubber-banded rectangle becomes `drawn` — **the** live, adjustable crop window, the mouse-placed
equivalent of the Auto-detect frame. It shows with the standard dashed frame + handles on **every
uncommitted page** (clamped to each page's extent), and while it exists it takes precedence over
the auto frame — on screen, at Crop, and at export (§12.4). Nothing is committed and the view is
**never magnified**: every page keeps its scale until **Crop** commits the window over the Pages
selection (then §12.1 shows the saved look). A new draw **replaces** the window; a draw smaller
than `2·MIN\_RECT` is discarded; `Esc` / right-click outside a drag **drops** it. While Keep ratio
is OFF, releasing a draw **updates the ratio field to the drawn box's width / height** (§7.4), so
turning the lock on afterwards keeps exactly the window you drew. The window deliberately does
**not** touch the global `union`/offsets — Auto-detect's cached result survives and shows again
when the window is dropped.

### 9.5 A crop is never dropped except by Undo or a valid replacement

This is an invariant, on screen **and** in the file:

* On a committed page (shown cropped) a gesture that commits nothing valid — a stray click with no
drag, or a draw smaller than `2·MIN\_RECT` — leaves the committed crop **unchanged**.
* Editing a committed crop (a new draw, or a border/corner drag) **re-commits** the tightened box and
the page stays in its saved (cropped) look; it never silently reverts to uncommitted. **Undo/Reset**
is the only way back to the full page.
* Re-detect **refreshes** committed pages instead of clearing them (§7.4).
* Export writes every page through its committed box, else its drawn window, else its live auto
crop, else the whole page (§12) — so a crop visible on screen is always saved.

Commits (Crop, a tightening draw on a committed page) snapshot history; live-window edits (draw,
move, resize, drop) do not — they are setup, like dragging a split rectangle. The grab targets are
the 4 **corners** (resize), the 4 **borders** (move an edge), and the rectangle interior away from
handles (move the whole rectangle); hit radius `HANDLE\_R + HANDLE\_SLACK`; cursors map to the
action.

### 9.6 Mouse gestures (split = 2 / 4)

Split 2/4 **auto-creates the N windows** as an even grid (§7.3); you adjust them with the **same
gesture model as a single crop** (§9.3). Each window has draggable **borders** and **corners** that
resize; dragging inside the rectangle (away from handles) moves the whole window. On **press**:

|Press / drag|Result|
|-|-|
|a window's interior (away from edges/corners)|move that whole window|
|a window's **border** line|move just that edge|
|a window's **corner**|resize that window|
|**Esc** / **right-click** during a drag|cancel the drag (windows left unchanged)|

**Same size** (§7.3) and **Keep ratio** (§7.4) are enforced on release: dragging one
window updates the rest to match. The numbered badges 1..4 (top-left of each window) mark output
order. These gestures act **before Apply, on the full page**. Apply commits the N windows to
`applied\[page]` (one output page each, §12.3) and is enabled only when exactly N exist; a committed
split then shows its **N cropped output pages** (§12.3) and **Undo/Reset** rebuilds it.

**A committed split page accepts no window gestures.** Once Applied, a press or drag on the page
does **nothing** to the split windows — the page never flips back to the full-page view, no window
moves or resizes, and the mouse coordinates stay in the shown output page's own units. The one
gesture that still works is the same as on any committed page (§9.3): **drawing a new rectangle**
inside the shown output page re-commits **that window only**, tightened to the drawn box (the other
N−1 windows and every other page are untouched; undoable). To rearrange the windows themselves,
**Undo** (or Reset) back to the uncommitted layout, adjust, and Apply again.

### 9.7 Keep ratio holds in every case

**Keep ratio** (§7.4) locks `height = width / ratio` and must hold **for every way a crop can be
produced**, not just the live auto crop — this is the fix for the bug where the lock worked in some
gestures but not others:

|Crop source|How the ratio is enforced|
|-|-|
|**Live auto crop** (§9.2)|the rectangle is normalised to the ratio on every render.|
|**Handle drag / edge / move** (§9.3)|the dragged rectangle is snapped to the ratio (anchored at its top-left) on release.|
|**Offset edits** (§7.4a)|committing an offset re-normalises the rectangle to the ratio; the Bottom offset is derived (inert) while the lock is on.|
|**Drawn crop window** (§9.4)|the rubber-banded box is snapped to the ratio when the draw is released; window drags re-snap on release.|
|**Split rectangles** (§9.6)|each dragged/resized window is snapped to the **Keep-ratio field** value on release (with Same size).|

Enforcement happens as the **final normalisation step of the one shared crop-construction path**, so
no gesture, mode (Normal/Scanned) or split count can bypass it. When the lock is on, a
ratio-constrained edge that would leave the page is clamped to the page and the opposite dimension
follows, never inverting the box.

\---

## 10\. Scan processing pipeline

Scanned mode only. Two cached rasters per page:

* **`source\[i]`** — rendered once at `SRC\_DPI`, **pre-process and immutable** (the basis for
idempotency and Reset).
* **`work\[i]`** — the current processed raster, shown on the canvas and cropped/exported.

`work` is always rederived **from `source`** through the current intent, so repeated presses equal
one press and re-filtering starts from the un-filtered image.

```
                       source\[i]   (immutable, @ SRC\_DPI)
                           |
              Dewarp \& Deskew ON ? ----------- no ----------+
                           | yes                            |
              docuwarp mesh unwarp (deskew included, 10.1)  |
                           |                                |
                           +---------------+----------------+
                                           v
                                         base
                                           |
            +------------------------------+------------------------------+
        Filter = B/W                   FIlter = Sharpen                Filter = None
   Sauvola bilevel (1/2/3)       flatten + denoise + unsharp (1/2/3)        |
            +------------------------------+------------------------------+
                                           v
                                        work\[i]  -->  detect / crop / compress / export
```

### 10.1 Dewarp \& Deskew

A single control. It is the learned **docuwarp / ONNX mesh unwarp**, which removes page curl/fold
and the incidental skew in one pass (there is no separate deskew step). The ONNX session is cached
process-wide (§17). The **Dewarp-supersample** setting (§15, default **1.0** = off) renders the
page larger before the mesh remap and downsamples after, trading time for less resampling blur.
If docuwarp is missing **or its inference fails for any reason**, the page falls back to plain
auto-deskew — the batch never dies on a dewarp failure and never commits a half-processed
selection (§14) — and, because a silent fallback looks like a dead button, the window **shows one
warning dialog after the batch** naming the reason (`AppModel.take_dewarp_notice()`, §20).

### 10.2 Filter modes (each 3 strengths)

* **B/W (bilevel):** illumination-flatten (divide by a morphological-close background) → Sauvola
threshold → connected-component despeckle. Strength selects `(sauvola\_k, min\_area)`.
* **Sharpen:** illumination-flatten → bilateral denoise → unsharp mask; keeps
continuous tone so photos survive. Strength selects the unsharp amount (`CLEAN\_AMOUNT`).

Binarization kernel sizes scale with the embedded DPI so scans at different resolutions binarize
comparably. The bilevel tunables live in `imaging.py`; the Sharpen amounts are `CLEAN\_AMOUNT`
(§18).

Processing is committed only on a button press, over the Pages selection, via the batch runner
(§14). Detect and crop read `work`.

\---

## 11\. Pages selection

Four buttons, always visible: `All · Odd · Even · Selected` (1-indexed; Odd = 1,3,5 → indices
0,2,4; Even = 2,4,6 → 1,3,5). The resolved index set drives detect, dewarp, filter, apply, rotate and
delete.

**Selected** reveals an inline **Pattern** field and a **Current** button:

* **Pattern** accepts a 1-indexed list, inclusive `a-b` ranges, and **Python-style colon slices**
`start:stop\[:step]` (1-indexed inclusive; optional ends/step — `1:4`==`1-4`, `1:100:5`==1,6,...,96,
`::2`==every odd page, `10:`==page 10 to the end), mixed freely: `1:4, 10:30, 35, 37`.
Out-of-range values are ignored.
* **Current** is a push-button styled like the Selected segment (blue when active, no checkbox
glyph). It is a **follow toggle**: pressing it switches the four-way control to Selected (the
segment updates even when set programmatically), fills Pattern with the current page, highlights,
and keeps Pattern synced to the page as you navigate. Pressing it again — or editing Pattern by
hand, or choosing All/Odd/Even — turns follow off and unhighlights, leaving the pattern as-is.
This makes the "edit a page → navigate → it crops only the page you're on" loop effortless.

\---

## 12\. Apply \& export

### 12.1 One image path (WYSIWYG)

Preview and export build each output page through the **same** function
`render.output\_image(work, box, page\_w, page\_h, target, remove\_colours)` — crop to `box`, resize to
`target. The on-screen
preview of a committed page therefore matches the exported page pixel-for-pixel, including the
compression downsample and the colour removal. **Both modes export raster:** the crop is rendered to
pixels (Normal at `NORMAL\_DPI`, Scanned from `work` at `SRC\_DPI`) and embedded as an image page.

`target` is derived from the **Compress Document** DPI (§7.6, §12.6): `Original resolution` keeps the
native crop resolution (`target = None`); `High/Medium/Low` resample the crop to `dpi/72 · crop-size-in-points` pixels. Compression is applied **last** (after crop), then colour removal.

### 12.2 Apply Crop

Stores the crop box(es) per page in the `applied` map (§9.1) over the Pages selection; other pages
are untouched. This is the persisted crop state and is covered by Undo. **Apply requires a crop
source** (§7.7); with none it is a **no-op** — nothing is committed and no snapshot is taken.
Per selected page the committed box is: the **drawn window** (§9.4, clamped to the page) if one
exists, else the page's **live auto crop** (§9.2) if active, else the page is **skipped** (never a
silent full-page box). Committing consumes the drawn window (pages then show their saved look,
§12.1). After Apply the page is shown
**exactly as it will be saved** — a single crop as the cropped, resized image; a 2/4 split as its N
output pages (§12.3) — with handles hidden. It **stays cropped while you edit** (§9.3); only **Undo**
or **Reset** returns it to the full page. A stray click never drops the crop (§9.5). Dewarp, filter and
rotate repaint immediately.

### 12.3 Split multiplies pages

A committed split **turns each source page into its 2 or 4 windows**, so the whole document holds
**2× or 4× as many pages — in the page navigation too**. A committed page exposes one output page per
committed box; the viewer steps through every split in reading order (page *p* window 1, 2, ... then
page *p+1*), and the nav counter and `< >` count these **output** pages (a 24-page document split ×2
reads `/ 48`), with the entry box jumping by output index. Uncommitted pages count as one view. This
mirrors the export exactly (what you page through is what is saved).

### 12.4 A visible crop is never dropped from the file

On export each page's box is: the committed box if the page is committed, **else the drawn window
(§9.4), else its live auto crop** when one is active (§9.1), and only the whole page when there is
genuinely no crop. So a page that shows a crop window on screen is exported cropped **even if it
was never Applied**. Export first commits the drawn/live crop of any uncommitted selected page
(pages with no source stay uncommitted and export whole), and when Split is active it (re)commits
the selection's N rectangles regardless of earlier single-crop state (so "normal crop → switch to
Split 2/4 → export" still yields N pages per source page).

### 12.5 Export (Ctrl+S)

Pre-fills `<original-name><output-postfix>.<ext>` in the **output folder** (both from Settings, §15;
defaults: postfix `\_cropped`, folder = the source file's folder; `<ext>` from the chosen export
format, §12.7). Iterates **every** page — committed pages export cropped (split → N), the rest whole
— **streaming one page at a time** under the progress overlay (§14): each page's crop(s) are encoded
and released before the next, so the working set never scales with page count. Cancel discards the
in-progress output with no partial file.

### 12.6 Compress Document

The **Compress Document** DPI (§7.6) sets the resolution every output image is resampled to before it
is written (the `target` of §12.1). Beyond the per-page downsample, export **fixes wasteful encoding**
so the file is as small as the content allows:

* **Downsample** each embedded image to the chosen DPI (`Original resolution` skips this).
* **Encode each page for its content**: a **B/W-filtered page embeds PNG** (lossless — JPEG rings
on bilevel text), every other page embeds **JPEG at `JPEG\_QUALITY`** (§18) — far faster to encode
and smaller than PNG for continuous-tone scans; PDF output then writes
`save(garbage=4, deflate=True)` to garbage-collect unreferenced objects and deduplicate streams.
* The result is **never larger** than a plain re-save of the same crop at the same DPI.

`Original resolution` still benefits from the encoding/garbage-collection filter-up; only the
downsample is skipped.

### 12.7 Export formats

The Export split button (§7.7a) writes one of:

|Format|Ext|Output|
|-|-|-|
|**PDF** (default)|`.pdf`|one PDF; each output page an embedded, compressed image page.|
|**JPG**|`.jpg`|**one file per output page** (`<name>\_001.jpg`, `\_002`, …); lossy, smallest.|
|**PNG**|`.png`|**one file per output page** (`<name>\_001.png`, …); lossless.|
|**TIFF**|`.tif`|a **one file per output page** (deflate-compressed).|

For the per-page formats (JPG/PNG/TIFF) the dialog asks for a base name/folder and the index suffix is
appended; for single-file formats (PDF) it asks for the file name. Every format honours the
Compress DPI (§12.6), and streams page-by-page under the overlay (§14).

\---

## 13\. History, reset, rotate, delete

* **History** — a doc-state stack, depth from the Undo/redo-depth setting (**default 4**). A
snapshot is taken before every mutating op — crop (the `applied` map), draw, rotate,
**dewarp/filter, and Auto-detect** — so Undo reverts all of them. The snapshot captures `applied`,
split rects, `rotation`, processed flags, detection/union, offsets and the filter/dewarp intent
(not the rasters); the snapshot also captures the per-page **drawn windows** (§9.4); restore clears
the raster caches so they re-render. Detection (`detect_cache`),
the union frame and `auto_active` are **undoable** state, and **Auto-detect pushes exactly one
snapshot per press** — including the first press — so every detect is one clean Undo/Redo step:
Undo reverts the live auto-crop frame *and* any committed crops that press refreshed, together
(ARCHITECTURE.md §5.1). The Auto-detect button itself stays stateless (an action, §7.4): each
press recomputes from the current work rasters; only its *result* lives in the undoable state.
* **Reset** — resets the **whole document** to its just-opened state: **re-loads the same input
files** and re-combines them (§7.1a) — or reloads the synthetic demo — clearing all crops,
rotations, detection, processing and history. It
returns Split to 1 (re-syncing the segment and the rectangles) and drops the active-highlight on
the scan buttons (B/W, Sharpen, Dewarp).
* **Rotate** — a per-page rotation-angle map (`rotation\[i]` in 0/90/180/270° CW), applied in
`source`/page-size. Rotate adds 90° and drops only the page's *rasters* (they re-render at the new
angle); the **committed crop, the drawn window (§9.4) and the detected box are carried through** by
rotating their coordinates 90° CW, so cropping is not undone. Live offsets reset to 0 (they map to
rotated edges) and the union is rebuilt. **With split 2/4 active, the split windows are re-laid out
automatically** to the rotated page (the even grid of §9.6) — they never linger at the old
orientation or overhang the turned page. Fully undoable; identical in both modes.
* **Delete** — removes the Pages selection (`doc.delete\_pages`), rebuilds page sizes, then
**reindexes** every per-page map (caches, detection, processed flags, committed crops, rotation):
deleted pages drop out and surviving keys shift down, so **adjustments on kept pages are
preserved**. Refuses to delete every page; confirms first.

\---

## 14\. Progress overlay \& batch model

Long operations (auto-detect on scans, dewrap, filter, export) show a **centred card on the canvas**
— message, determinate bar, page counter, Cancel — not a separate window.

**Batch runner (`\_run\_batch`):** process the page list **one page per Tk `after` tick on the main
thread** — render its source, do the per-page imaging, hand the result to a consumer, drop it before
the next. This keeps PyMuPDF/Tk strictly main-thread and the raster caches LRU-bounded (\~ one page
resident at a time, §17). The UI stays responsive because Tk processes events between ticks. A
**single-page** job skips the overlay and runs synchronously.

* **Smooth, not fragmental:** the overlay is force-painted when first shown — `update\_idletasks()`
after it is placed, **escalating to a full `update()`** so it is **fully drawn, never partially**,
before the first page's heavy work — and the bar/counter redraw is flushed after every page before
the next page's heavy work, so progress advances steadily instead of in starved jumps.
* **Cancel** sets a flag checked before each page and stops promptly, with no partial file.
* **While busy, controls are disabled and further clicks are ignored** (commands are not queued — the
simplest race-free model for a single-user desktop tool).
* A per-page exception surfaces as an error dialog and ends the batch cleanly.
* **After a batch that succeeded over a selection not containing the current page, the view jumps
to the selection's first page** (detect, dewarp, filter, Crop) — the user always lands on a page
that shows the result.

\---

## 15\. Settings

The Settings window sizes itself to its content in **both** axes (and sets that as its `minsize`), so
a larger font or high OS-DPI grows the window instead of clipping rows. It opens **over the left
panel, aligned to the main window's top-left corner** (same alignment as Help, §16).

```
+ Settings -------------------------------------+
| Appearance                                    |
|   Colour scheme    \[ Light | Dark | System ]  |  segmented, applied live
|   Font size        \[ 15            v ]        |  rebuilds the shared CTkFonts live
|   Zoom (UI scale)  \[ 100%          v ]        |  = Ctrl +/- ; 100% = system size
| Output                                        |
|   Compress to        \[ Original resolution v] |  DPI preset used by Compress (§7.6)
|   Default format     \[ PDF                 v] |  initial Export split-button format (§12.7)
|   Output folder    \[ same as source   ]\[...]  |  where exports are written
|   Output postfix   \[ \_cropped         ]       |  appended to the name before the extension
| Behaviour                                     |
|   Confirm before overwrite          \[ on  ]   |
|   Remember last folder              \[ on  ]   |
|   Undo / redo depth   \[ 4        ]            |  bounds the history stack (default 4)
| Scan                                          |
|   Dewarp supersample  \[ 1.0      ]            |  quality lever for dewarp (10.1); 1.0 = off
+-----------------------------------------------+
```

**Compress to** is the DPI preset the Compress Document control (§7.6) uses, and the menu there and
this one are the same setting. **Default format** is the format the Export split button starts on
(§12.7). **Output folder** is where Export writes (a "…" button picks a folder; default = the source file's
folder, honoured together with *Remember last folder*). **Output postfix** is appended to the source
name before the extension (default `\_cropped`), so the suggested file name is
`<name><postfix>.<ext>` (§12.5).

Fonts use the **native system UI font** so text matches the OS; all sizes derive from one base and
are reconfigured live by the Font-size menu. Zoom is a multiplier on top of CustomTkinter's automatic
system-DPI scaling, so 100 % already renders at the system size. There is **no Source-DPI setting**
(the internal render DPI is fixed; the user-facing DPI lever is **Compress to**, §7.6).

\---

## 16\. Help

A help window, opened **over the left panel — aligned to the main window's top-left corner, its
bottom edge flush with the main window's bottom** (height = the main window's interior height
minus the title-bar offset, so it never hangs below; its width stays its own): a heading and a
one-line description ("Crop, straighten, and clean PDFs and scans for e-readers."), then a scrollable body
whose first item is a **Contents** card — a **single-column list of buttons**, one per section.
The last section is **About** (app name, version, one-line purpose) — it must always be present
(inv 36). The window's height is computed **after forcing pending layout on the main window**
(`update_idletasks` before any `winfo_*` read), so it never uses a stale pre-layout size (inv 31). Clicking a button scrolls the body to that section
(`yview\_moveto`) in the same window; the section blocks follow the card, in the same order. Help text
renders one point larger than the rest of the UI.

```
+ Help \& Quick-Start ------------------------------+
| Crop, straighten, and filter PDFs and scans for   |
| e-readers.                                        |
| + Contents -----------------------------------+  |
| | >  Document mode                            |  |  one full-width button
| | >  Loading \& combining files                |  |  per section; clicking
| | >  Pages to process                         |  |  scrolls the body to it
| | >  Detect text borders \& offsets            |  |
| | >  Adjusting the crop                       |  |
| | >  Scan processing                          |  |
| | >  Splitting pages                          |  |
| | >  Compressing output                       |  |
| | >  Export \& formats                         |  |
| | >  Keyboard shortcuts                       |  |
| | >  About                                    |  |
| +---------------------------------------------+  |
| Document mode                                    |
|   When you open files, SmartCrop inspects ...    |  (section blocks follow,
| Loading \& combining files                         |   same order, scrolling)
|   Use Load Files (Ctrl+O) ...                     |
| ...                                              |
+--------------------------------------------------+
```

\---

## 17\. Performance \& memory

Target <= \~150 ms/page for filter/dewarp at `SRC\_DPI` on a laptop; batches run sequentially
page-by-page (§14).

|Lever|Action|
|-|-|
|Binarize|integral-image Sauvola (O(N)); single-pass despeckle; binarize at native DPI|
|Dewarp|ONNX session cached process-wide; optional supersample only by the setting (§10.1)|
|Batch|one page per tick → consume → drop, so memory stays flat|
|Apply|reuse cached `work`; encode once; no re-filter|
|Detection|cache the per-page content box; re-press is free|
|Preview|committed-page output images are LRU-cached in the model (`CACHE\_WINDOW` entries) and the canvas caches the fitted page bitmap per (raster, size) (`PHOTO\_CACHE` entries), so page navigation and drag repaints come from cache — the full-page resample runs once per page/size, not on every redraw|

**Memory bound (implemented):** the `source` and `work` raster caches are **`LRUCache`s bounded to
`CACHE\_WINDOW` pages each** (`core/lru.py`); least-recently-used pages are evicted, so resident RAM
stays flat regardless of document size. Export streams (§12.5). The committed
`applied`/`rotation`/`detect` maps are tiny per-page state and are kept in full.

\---

## 18\. Constants

`core/constants.py` is the single source of truth for these (mirror it exactly; do not duplicate
values into logic). `MIN\_RECT` lives in `geometry.py`; the bilevel kernel sizes live in `imaging.py`.

```
# DPI / caches
SRC\_DPI        = 200.0      NORMAL\_DPI    = 150.0     CACHE\_WINDOW = 16
# crop geometry
HANDLE\_R       = 10         HANDLE\_SLACK  = 6         CANVAS\_MARGIN = 40
MIN\_RECT       = 5.0  (geometry.py)                   OFFSET\_LIMIT  = 100.0
# classification / detection
MODE\_TEXT\_MIN  = 8          DETECT\_MAX\_PX  = 1400     # text < this AND no vector path ⇒ page is image-only
BORDER\_FRAC    = 0.02       MIN\_COMP\_FRAC  = 2.5e-4   FULL\_PAGE\_FRAC = 0.97
DESKEW\_MAX\_DEG = 15.0       
# filter
CLEAN\_AMOUNT   = {1: 0.6, 2: 1.1, 3: 1.6}            # Sharpen unsharp amount per strength
# UI behaviour / geometry
SYNTH\_PAGES    = 24         SCALE\_THROTTLE\_MS = 80
UI\_SCALE\_MIN   = 0.7        UI\_SCALE\_MAX   = 2.0
FONT\_SIZE\_MIN  = 10         FONT\_SIZE\_MAX  = 24       DEFAULT\_FONT\_SIZE = 15
WINDOW\_SIZE    = "1560x1000"  WINDOW\_MIN   = (1040, 700)
PANEL\_WIDTH    = 320        SETTINGS\_MIN\_W = 520
PHOTO\_CACHE    = 6          STATUS\_PAD     = 8          # canvas paint (§17, §19)
OFFSET\_FIELD\_W = 48         RATIO\_FIELD\_W  = 110        # §7.4a / §7.4 field widths
ROW\_LABEL\_W    = 90         SWITCH\_W       = 44         # compact switch rows (§7.4)
JPEG\_QUALITY   = 88   (core)                             # JPG export + PDF page embed (§12.6)
# data
DPI\_PRESETS    = {"Original resolution": None, "High — 300 dpi": 300,
                  "Medium — 150 dpi": 150, "Low — 75 dpi": 75}   # Compress Document (§7.6)
EXPORT\_FORMATS = \["PDF", "JPG", "PNG", "TIFF"]            # Export split button (§12.7)
IMAGE\_LOAD\_EXT = \[".pdf", ".jpg", ".jpeg", ".png", ".tif", ".tiff"]   # Load Files filter (§7.1)
THEMES         = { dark: {...}, light: {...} }
```

The Undo/redo depth and the Dewarp-supersample factor are **runtime settings** (default 4 and 1.0),
not constants. Theme/typography maps also live here.

\---

## 19\. Typography \& theme

Fonts use the **native system UI font** (`TkDefaultFont` family); all sizes derive from one base and
are reconfigured live by the Font-size menu (§15). No UI element uses a smaller font than the base. A
few fixed point sizes (the split badge / mark drawn on the canvas, the dialog titles, the tooltip)
are set directly.

**Palette: warm-gray chrome + a clear blue accent** (`core/theme.py`, with dark/light token maps).
Cards and chrome are warm off-white / warm charcoal. **Buttons are neutral at rest** and highlight
(blue `ACCENT`) only when they represent an active state — the toggles (Dewarp, B/W, Sharpen) while
on, and **Current** while following. **Auto-detect never highlights** (it is an action, not a
toggle). Switch-on, segmented-selected, the crop frame (`CROP\_BLUE`) and split rectangles
(`SPLIT\_BLUE`, thick lines + large numbers) all use blue. Nothing is drawn over the page image;
the pointer read-out is a white label in the shared status font at the right pane's bottom-right
corner (§6). The mode badge is a non-interactive marker. Disabled controls dim.
Every label stays legible in both modes. The window title shows the open file name.
**Pictograms.** Settings, Help, Load, Save/Export, Crop, Rotate, Delete, Undo/Redo/Reset (and the
other primary actions, §7) **lead their label with a small glyph inside the label string** —
`↩  Undo`, `✂  Crop`, `💾  Export PDF`, `✦  Auto-detect`, `↻  Rotate`, `🗑  Delete`, `⚙  Settings`
— glyph first, two spaces, then the control's name (§7.8's "label leads with its glyph"). The
label therefore always **ends with the control's exact name**; tests key off that suffix, never
the glyph. Glyphs render in the button's current text colour (neutral at rest, ACCENT text when
active) and scale with the label font; the canvas marks (split badge), dialog titles and tooltip
keep their fixed point sizes (§15).
---

## 20\. Error handling \& edge cases

* No document loaded → actions are no-ops; nav shows `/ 0`.
* Empty Pages selection → warn, do nothing.
* Auto-detect with no text/ink anywhere → warn; leave prior state.
* A drag collapsing a rectangle → clamp to `MIN\_RECT`; never invert.
* Crop rectangle is always clamped to the page; degenerate clips are skipped.
* Re-fetch a `Page` object after any document mutation (insert/rotate invalidate handles).
* Custom resolution non-positive/unparseable → error dialog, abort.
* **Expected** errors (malformed PDF, bad custom resolution, a per-page imaging failure in a batch)
are caught **specifically** at their call site → error dialog, the operation aborts, the document
is untouched.
* **Unexpected** Tk-callback exceptions go to `handle\_callback\_error` (set as
`report\_callback\_exception`): it does not silently continue — it clears the transient flags a
half-finished op may leave stuck (`\_busy`, `\_suspend`, the overlay, disabled controls), repaints a
consistent view, and surfaces the error. The user lands on a usable state and can Undo.
* Mode switch leaves no empty gap at the panel top; the control column scrolls as one.

\---

## 21\. Shortcuts

`Ctrl+O` Load · `Ctrl+Enter` Apply Crop · `Ctrl+S` Export · `Ctrl+Z` Undo · `Ctrl+Y` Redo ·
`Left`/`Right` and `PgUp`/`PgDn` (or the **mouse wheel over the canvas**) previous/next page ·
`Ctrl +/-` scale the UI (`Ctrl 0` resets) · `Enter` in the page box jumps to it · `Esc` or
**right-click** cancels an in-progress crop drag.

\---

## 22\. Acceptance invariants

Each is verified by the test suite; the prose home is in parentheses.

1. After Auto-detect with all offsets 0, each page's crop is the constant `W×H` union size across the
selection, starting at its anchored top-left — **shifted inward where it would overhang the page,
never shrunk** (§8, §9.2).
2. Dragging any handle leaves every non-dragged edge pixel-stable across the whole drag (§9.2).
3. Repeated Dewarp/filter presses produce the same `work` as one press (idempotent from source, §10).
4. Undo reverts dewarp, filter, crop and rotate; **Reset re-opens the whole document** (§13).
5. Rotate preserves filtering **and** the committed/detected crop (boxes rotate with the page); Delete
preserves kept pages' adjustments (reindex, no wipe) (§13).
6. Nothing in scan processing runs without an explicit button press (§7.2, §10).
7. Crop rectangles never extend outside the page (§9.2).
8. Batches run one page per tick; the overlay (not a window) reports progress for detect, dewarp,
filter and export and paints smoothly; Cancel stops before the next page with no partial file (§14).
9. Resident raster memory stays flat regardless of page count (LRU `CACHE\_WINDOW`; export streams)
(§17).
10. All PyMuPDF/Tk access is on the main thread (§3, §14).
11. A committed 2/4-split page is navigable as **N output pages per source page** in reading order;
the page counter shows the output total (source × N) and matches the export (§12.3).
12. **WYSIWYG:** preview and export produce identical pixels via the one `render.output\_image`; the
Compress DPI setting are reflected in the preview, `Original resolution`
keeps native resolution (§12.1).
13. **The drawn window is the mouse twin of Auto-detect:** drawing creates one global live window
shown on every uncommitted page; it never touches the cached detection (dropping it restores the
auto frame); Crop commits it over the Pages selection, leaving out-of-selection pages unchanged.
**Auto-detect symmetrically replaces a drawn window on the spot** — its result renders
immediately, never blocked behind a manual drop (§7.4, §9.4).
14. **The page is always inside the window:** the fitted page/crop never overflows the canvas; the
wheel turns pages and never magnifies (§5).
15. **A crop is never dropped except by Undo or a valid replacement** — on screen and in the file
(§9.5, §12.4).
16. **Auto-detect works after a crop:** re-detect refreshes the committed crop on detected pages
(keeps it, updated); pages outside the selection keep theirs (§7.4).
17. **Multi-file combine:** loading several files builds one document; PDFs contribute their pages
and each image becomes one page, in selection order — one-by-one picks keep click order, a
range / Select-All keeps directory order (§7.1a).
18. **Classification by vector data:** the document is Normal if any page carries text or a vector
drawing path, and Scanned only when every page is image-only (§4).
19. **Keep ratio holds in every case:** the `height = width/ratio` lock is enforced for the live
auto crop, handle drag/move, offset edits, the drawn crop window and split rectangles, in both
modes — no gesture bypasses it (§9.7).
20. **Compress downsamples and shrinks:** a High/Medium/Low DPI resamples every output image to that
DPI and the file is never larger than a plain re-save at that DPI; `Original resolution` keeps
native crop pixels but still garbage-collects/deflates (§12.6).
21. **Export formats:** PDF write a single file; JPG/PNG/TIFF write one file per output page
with an index suffix; every format honors the Compress DPI and streams
page-by-page (§12.7).

22. Output colours: when 'Grayscale' is selected, every output page is desaturated (tonal range preserved, no thresholding) regardless of per-page filter history, via the one render path, in both preview and export; 'Original colors' leaves each page's existing colour state untouched (§7.6, §12.1, §15).

23\. Pictograms: every glyph-led button label **ends with the control's exact name** (tests key off the suffix, never the glyph); the split badge / dialog title / tooltip point sizes stay fixed and do not scale with the Font-size menu (§19).

24\. Cancel a drag: pressing `Esc` or right-clicking during an in-progress crop/split drag discards it — nothing is committed and no history snapshot is taken — leaving the crop exactly as it was before the drag began. Outside a drag, `Esc` / right-click **drops the drawn window** if one exists, **else deactivates the Auto-detect frame** (cached results kept; a re-press re-activates), and with neither changes nothing at all (§9.3, §9.4, §9.6).

25\. Crop with no source is a no-op: at split = 1 with no active detection **and no drawn window on any selected page**, Apply/Crop commits nothing and takes no snapshot — full-page boxes are never committed; selected pages without any source are skipped, never full-page-committed (§7.7, §12.2).

26\. A committed split page ignores window gestures: no press/drag flips it to the full page or moves a split window; only a drawn rectangle re-commits the shown output window (tightened), leaving the other windows and pages untouched (§9.6).

27\. Auto-detect is one undoable step: every press — including the first — pushes exactly one history snapshot, and Undo after it restores both the detection state and any crops the press refreshed (§13).

28\. Drawing never magnifies: rubber-banding at split = 1 — on an uncommitted **or** committed page — creates/replaces the **global live drawn window**; nothing is committed, the fitted view scale is unchanged during and after the draw, the window shows with handles on every uncommitted page, and while the lock is off the ratio field follows the drawn box; only Crop commits it (over the Pages selection) and switches pages to their saved look (§9.4, §12.1, §12.2).

29\. Rotate and detection commute: with split 2/4 active, rotating re-lays the N windows out on the rotated page (even grid); the drawn window and committed/detected boxes rotate with their pages; and **detection run on a rotated page returns its box in the rotated page's coordinate space** — rotate-then-detect equals detect-then-rotate (§8, §13).

30\. Dewarp honours the supersample setting and degrades gracefully: a failed mesh unwarp falls back to auto-deskew — never a dead button, a crashed batch, or a partial commit — and the fallback is **surfaced as one warning dialog after the batch**, never silent (§10.1, §14, §20).

31\. Windows placement: Settings and Help open aligned to the main window's top-left corner; Help's bottom edge never extends below the main window's bottom edge, and its height is computed only after pending layout is forced (`update_idletasks`) — never from a stale pre-layout size (§15, §16).

32\. Cursor read-out: while the pointer is over the page, its position (percent of the page) shows in the label at the **bottom-right corner of the right pane** (white, shared status font) and empties when the pointer leaves; **no text is drawn on the page image** — the output-page position appears only in the pinned nav bar (§6, §7.8, §19).

33\. Land on the result: a successful batch (detect, dewarp, filter, Crop) over a selection that does not contain the current page jumps the view to the selection's first page (§14).

34\. Hover nav arrows: `◀`/`▶` appear at the canvas's left/right edge midpoints while the pointer is over the canvas, styled like the bottom nav, and turn one output page per click; they hide when the pointer leaves and disable at their end of the document like the bottom nav (§6).

35\. A new box starts clean: creating a new live crop box — by Auto-detect or by drawing — drops the previously active box and resets all four offsets to 0 before the new box appears (§7.4).

36\. Help always contains an About section (app name, version, purpose), reachable from the Contents card (§16).

37\. Navigation disables at the bounds: Prev is disabled on the first output page, Next on the last, both on a one-page document — for the bottom nav and the hover arrows alike — and the disabled states refresh on every navigation path: buttons, arrows, wheel, keyboard, jump box (§7.8, §6).

