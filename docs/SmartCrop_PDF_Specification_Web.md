# SmartCrop PDF Web — Specification

A browser app to combine, crop, straighten, clean and compress PDFs, scans and images for reading
on e-readers, phones and tablets. It loads one or many files (PDFs and/or images) into a single
working document, crops/filters/compresses them, and exports as PDF or a chosen image format. This
document is the behavioral contract: architecture, UI, algorithms, state and acceptance invariants.
`ARCHITECTURE.md` explains *how* this is implemented (module layout, dependency graph, worker
model, build/deploy); this document explains *what the user experiences*. Where a fact could belong
to either, ask "does the user experience this?" — if yes, here; if no, ARCHITECTURE.md.
`docs/app_design_screenshots/` is a further reference for exact layout/icon/spacing fidelity.

Out of scope: OCR / searchable text, a thumbnail page picker, N×M auto-grid split.

---

## 1. Modes & classification

On load, every page of the combined document (§9) is classified, and the document mode follows
from whether *any* page carries vector data:

```
page_is_native = extractable text length >= MODE_TEXT_MIN  OR  page has any vector drawing path
document_mode  = NORMAL if any page_is_native else SCANNED     # SCANNED only when *every* page is a raster image
```

A document is **NORMAL** if it contains any vector data — real text or vector drawings on at least
one page. It is **SCANNED** only when every page is a raster image with no vector content. A page's
own incidental text below `MODE_TEXT_MIN` characters does not by itself make the *page* native, but
one genuinely native page anywhere in the document is enough to make the whole *document* NORMAL.

| Mode | Page unit | Stage chain |
|---|---|---|
| NORMAL | PDF points | detect/draw → adjust → crop → export (vector, PDF output) or render+compress (other formats) |
| SCANNED | raster px @ `SRC_DPI` | dewarp? → filter? → detect/draw → adjust → crop → render+compress → export |

**NORMAL documents stay vector.** A NORMAL page is never rasterized to decide its crop, rotation or
split — crop/rotate/split state is stored as operation metadata (page-relative boxes, a rotation
angle, split layout — §13), not as pixels or a rasterized preview cache. The on-screen preview still
*renders* a NORMAL page as a raster bitmap (there is no vector canvas backend — §3), but that raster
is disposable presentation output, generated on demand from the metadata; it is never the source of
truth and never stored in `DocumentState`. Exporting a NORMAL document to **PDF** reuses this same
vector metadata against the original page content with no rasterization at all (§10). Exporting a
NORMAL document to JPG/PNG/TIFF, or any export of a SCANNED document, necessarily rasterizes (image
formats have no vector alternative) via the one raster render path (§9.1 below).

The mode is shown as a non-interactive badge (`NORMAL`/`SCANNED`) on the Document & State card; it
is set by classification on load and never user-toggled. The Scan Processing card is shown only for
a SCANNED document.

`Mode` (`NORMAL`/`SCANNED`), `FilterMode` (`NONE`/`BW`/`SHARPEN`) and `PagesMode`
(`ALL`/`ODD`/`EVEN`/`SELECT`) are string-backed TypeScript enums (`core/enums.ts`).

With no file open, a synthetic placeholder document (`SYNTH_PAGES = 1` blank page, drawn directly
via the Canvas API, no PDF.js involved) is shown so every control is usable immediately.

---

## 2. Coordinate system & page view

All crop/split/offset geometry is in **page units**: PDF points for a NORMAL page, raster pixels at
`SRC_DPI` for a SCANNED page. Canvas mapping:

```
canvas_x = page_x · scale + img_x          page_x = (canvas_x − img_x) / scale
scale    = min((cw − CANVAS_MARGIN)/page_w, (ch − CANVAS_MARGIN)/page_h)   # fit, aspect kept
img_x, img_y = centre the fitted bitmap in the canvas
```

`CANVAS_MARGIN = 0` — the page fills the canvas edge-to-edge. On a committed single-crop page,
`page_w`/`page_h` above are the committed box's own dimensions, not the full page — see §9.8's
`crop_origin` mechanism for the exact pointer↔page mapping in that case.

The page view is always **fit-to-window**: `scale` recomputes on every render and on canvas resize,
so the whole page (or the whole committed crop) is always fully inside the canvas on both axes —
never magnified out of view. There is no page zoom; **the mouse wheel over the canvas turns pages**
(up = previous, down = next). `Ctrl +/-` scales the whole UI (§14 Settings), not the fitted page.

---

## 3. Layout

A fixed three-column layout: a scrollable left sidebar (320px), a collapsible detail panel that
slides in between the sidebar and the canvas, and the page canvas filling the rest (never below
400px). There is no floating window, no modal, no OS-level draggable sash — everything is a normal
DOM sibling.

```
+--SmartCrop PDF — filename.pdf-----------------------------------------+
| [left sidebar 320px]  [detail panel, slides in]  [canvas: flex]       |
|                                                                        |
| Document & State      <- Settings or Help content        page bitmap  |
| Pages to Process         appears here when active.                    |
| Scan Processing          Slides in with a transition.    crop frame   |
| Split Each Page Into     Canvas shrinks to fill           overlay     |
| Detect Text Borders      remaining space (min 400px).                 |
| > Advanced                                                            |
| Actions                                                               |
| Output Quality                                                        |
| Export                  (scrollable stack)                            |
| ----------------------                                                |
| Settings  Help                                                        |
| Undo  Redo  Reset                                                     |
| <  [n] / total  >     (pinned, outside scroll)                        |
+------------------------------------------------------------------------+
```

**Left sidebar** — scrollable, fixed width. Card order top→bottom: the loaded-document-name card
(its own card at the very top, above Document & State — hidden entirely when nothing is loaded,
shows the single file's name or `"first.pdf +N more"`), Document & State, Pages to Process, Scan
Processing (SCANNED only, no residual gap when hidden), Split Each Page Into, Detect Text Borders,
Advanced (collapsed by default), Actions, Output Quality, Export. Pinned bottom bar, outside scroll,
one instance only: Settings/Help row, then Undo/Redo/Reset (3 equal buttons), then page nav
`< [n] / total >`.

**Detail panel** — collapsed (width 0) by default. Clicking Settings or Help opens it showing that
content and shrinks the canvas to fill the remaining space. Pressing the same button again, or
**Esc**, closes it. Pressing the other button swaps content with no close/reopen animation.

**Canvas** — carries a bottom-right cursor read-out DOM overlay (`x nn.n% y nn.n%`, percent of the
page), updated on `pointermove`, empty when the pointer leaves. Nothing else is drawn on the canvas
outside the page bitmap and the crop/split overlay boxes — no page-number/size status text is
painted on or near the canvas.

Exact icon set, control widths, switch/field styling and per-control coloring must match
`docs/app_design_screenshots/`, which supersedes this section's prose wherever more specific.

---

## 4. Control reference

Every interactive control should carry a tooltip describing what it does (`title=` attribute or the
app's tooltip primitive — coverage of this is tracked as ongoing work, not yet on every control).

### 4.1 Document & State

| Control | Action |
|---|---|
| Mode badge | Non-interactive `NORMAL`/`SCANNED` marker (§1). |
| Load PDF/Image Files | Opens a multi-select file picker (`Ctrl+O`) filtered to PDFs and images (`.pdf/.jpg/.jpeg/.png/.tif/.tiff`). Selected files combine into one working document (§9) → resets all per-document state (crops, rotation, detection, processing, history) → classifies → sets mode. |

Undo/Redo/Reset live in the pinned bottom bar (§4.9), not this card.

### 4.2 Pages to Process

Four buttons, always visible: `All · Odd · Even · Selected` (§8). **Selected** reveals an inline
Pattern text field and a **Current** follow-toggle button (styled like the segment, highlights when
following). Placed near the top of the stack — every operation below reads this selection (Scan
Processing, Auto-detect, Split-apply, Actions).

### 4.3 Scan Processing *(SCANNED documents only)*

| Control | Action |
|---|---|
| Dewarp & Deskew (toggle) | Sets the dewarp intent over the Pages selection (§6). |
| B/W / Sharpen (mutually exclusive toggle) | Sets the filter mode over the Pages selection; pressing the active one turns it off. |
| Strength 1 / 2 / 3 | Always selectable regardless of whether a filter is active; applies once a filter mode is on. |

Nothing here runs automatically — only on a button press.

### 4.4 Split Each Page Into

`1 / 2 / 4` → that many output pages per source page (§7.4). N > 1 disables Detect/anchors/offsets
(manual split is the crop source) and reveals **Same size**. Changing the split count clears any
committed crop from the previous layout and re-seeds an even grid of N windows (§7.4).

**Keep ratio** (toggle + numeric field): when on, the crop height is locked to `width / ratio` for
every crop source in both modes (§7.7). The field pre-populates from whatever crop shape is
currently on screen when the toggle turns on.

### 4.5 Detect Text Borders *(split = 1)*

| Control | Action |
|---|---|
| Auto-detect | Runs detection over the Pages selection (§6). An action, not a toggle — never highlighted, always re-pressable. Disabled when split > 1, both anchors are off, or a batch is running. |
| Anchor Left / Anchor Top | Left/top edge from this page's own detected content (on) or the shared union edge (off). At least one anchor must be on for a crop to exist. |

Re-running Auto-detect refreshes an already-committed page's crop to the fresh box instead of
dropping it (§4.5, §7.4).

### 4.6 Advanced *(collapsible, split = 1)*

Collapsed by default; a header arrow toggles it. Expanded, shows four per-edge percent offset
fields on one row: `L T R B` (±`OFFSET_LIMIT`, step 0.1). Each moves exactly one edge (§7.2). On
commit (blur or Enter) an out-of-range value is snapped to the largest the page allows.

### 4.7 Actions

**Crop** (single full-width button, label reads "Split & Crop" when split > 1) commits the current
crop source over the Pages selection (§10.2). **Rotate** (90° CW) and **Delete** sit below it as a
two-button row, both acting on the Pages selection (§12). Delete asks for confirmation first.

### 4.8 Output Quality & Export

Two separate cards. **Output Quality**: a DPI/compress preset dropdown (with a **Custom…** numeric
DPI field) and an Output colours dropdown (`Original colors`/`Grayscale`). This card — and its three
controls — is hidden and disabled whenever the loaded document is NORMAL and the export format is
PDF, since that combination exports as a genuine vector PDF with no rasterization step for these
settings to configure (§10.3). It reappears the moment the export format switches to JPG/PNG/TIFF,
and is always shown for a SCANNED document. **Export**: a button (label tracks the chosen format,
e.g. "Export PDF") plus an adjacent format `<select>` (PDF/JPG/PNG/TIFF); never gated by the rule
above. `Ctrl+S` triggers Export.

Output-quality settings (compress preset, custom DPI, colours, export format) persist across
document loads and browser sessions via `localStorage`.

### 4.9 Settings / Help, history & nav (pinned)

Three rows, pinned to the bottom of the sidebar, outside scroll, one instance only: **Settings** +
**Help** (open the detail panel, §3); **Undo / Redo / Reset** (3 equal buttons — Reset re-loads the
whole document from its original files, §12); page nav `< [n] / total >`. `total` is the **output**
page count — a committed split expands one source page into N views (§7.6), so navigation walks
every split in order and the counter always matches what will be exported. Prev disables on the
first output page, Next on the last.

---

## 5. Auto-detect algorithm

Detection yields a per-page content box `B_p = (x0,y0,x1,y1)`; anchors and offsets (§7) turn it into
the crop rectangle. Per page over the Pages selection:

- **NORMAL:** the union of the page's text-run bounding boxes, read directly from the PDF's text
  layer (`page.getTextContent()`) — no rasterization, no OpenCV, ever. A page with no extractable
  text (an image page inside a mixed document, or a degenerate box) simply gets **no detected box**;
  there is no raster fallback. Downstream consumers already null-check a missing detected box and
  degrade to "no auto-crop for this page."
- **SCANNED:** `content_box` over a real Sauvola-filtered binarization of the page (§6), downscaled
  to `DETECT_MAX_PX` for speed, run on the **raw source raster** — never the dewarped/filtered work
  image (dewarp's small geometric shift is not reflected in the detected bounds — an accepted
  fidelity tradeoff; this is also what keeps detection within its <100ms/page budget, §16). No ink →
  no detected box for that page.

Then aggregate across the selection to fix one constant crop size for the whole document:

```
gL = min(x0)            gT = min(y0)                # top-/left-most corner (anchor-OFF base)
W  = max(x1 − x0)       H  = max(y1 − y0)           # largest content width / height across pages
union = (gL, gT, gL+W, gT+H)
```

`W,H` is the *largest* content box found, not the bounding span of all edges. Full-page fallback
boxes are excluded from the aggregate (any page whose detected box is ≥ `FULL_PAGE_FRAC` of the
sheet in both axes), so one failed page can't blow `W,H` up to the sheet size. This exclusion is
re-applied identically whenever the union is rebuilt after a rotate or a delete (§12) — one shared
`_compute_detection_union` helper, no separate re-implementation. Per-page boxes and the union are
cached (non-undoable AppModel state — §13).

`content_box(bilevel)`:

```
ink        = bilevel < threshold
components = connected_components(ink, 8-connectivity)
keep       = components with area >= MIN_COMP_FRAC · page_area
                 AND not touching the outer BORDER_FRAC margin
if keep is empty:  keep = components with area >= MIN_COMP_FRAC · page_area   # fallback
box        = bounding rectangle of the kept pixels
```

Detection is non-destructive and deterministic; it is always safe to re-run.

**Rotation-aware mapping.** Detection always returns a box in the rotated page's current coordinate
space: the SCANNED path reads the already-rotated work raster; the NORMAL path reads the document's
(unrotated) text layer and the caller accounts for rotation when caching. Detecting after a rotation
therefore equals rotating after a detection.

---

## 6. Crop windows & drag

### 6.1 The crop sources

At any moment a page's crop comes from exactly one of:

1. **Live auto crop** — computed on the fly from the cached union frame + anchors + offsets (§6.2).
   Exists only when split = 1, auto-detect is active, and ≥ 1 anchor is on. Drawn as a dashed frame
   with corner handles (resize) and border handles (move one edge); dragging inside moves the whole
   box. It is global: the four offsets are shared, so editing it changes the live crop on every page.
2. **Drawn crop window** — the one rectangle rubber-banded by mouse at split = 1 (§6.4). Behaves like
   the auto-detect frame except its position/size come from the mouse: global (shown on every
   uncommitted page, clamped to each page's extent), a live window rather than a commit, and while it
   exists it overrides the live auto crop everywhere. `Esc`/right-click (outside a drag) drops it;
   **Crop** commits it over the Pages selection. It rotates with the pages.
3. **Committed crop** — a per-page list of one box (single) or N boxes (split), set by Crop or
   refreshed by re-detect. This is the persisted, undoable state. A committed page is shown exactly
   as it will be exported: a single crop as the cropped/resized image, a 2/4 split as its N output
   pages. It stays shown cropped while edited; only Undo or Reset returns it to full extent.
4. **Split rectangles** — the up-to-N rectangles adjusted by mouse when split = 2/4 (§4.4, §6.6).
   Directly draggable/resizable; each becomes an output page on Crop.

### 6.2 Live auto-crop geometry (per page)

`w,h` = page size; offsets are percent of the page dimension:

```
left_base = AnchorLeft ? B_p.x0 : gL          # on: this page's content left;  off: union-min left
top_base  = AnchorTop  ? B_p.y0 : gT          # on: this page's content top;   off: union-min top
left   = left_base − L%·w                       right  = left_base + W + R%·w
top    = top_base  − T%·h                       bottom = top_base + H + B%·h
# fit onto the page — if it overhangs, SHIFT inward (opposite edge extends) to keep the constant
# W×H; shrink a side to the page (>= MIN_RECT) ONLY if W/H itself exceeds the page.
```

Each offset moves exactly one edge — right/bottom are anchored to `left_base+W`/`top_base+H`, not to
the moved left/top, so dragging one edge never drags its opposite. Width/height stay the constant
`W,H`, so the box is the same size on every page.

### 6.3 Mouse gestures (single crop, split = 1)

The canvas always shows a page at its current crop: uncommitted → full page with the live rectangle
+ handles drawn on it; committed → the saved cropped look, staying cropped while edited (only Undo/
Reset returns it to full extent).

| Press / drag | Result |
|---|---|
| a border line | move just that edge |
| a corner | resize (moves the two edges meeting at that corner) |
| inside the rectangle (away from handles) | move the whole rectangle |
| empty area | rubber-band a new drawn window (§6.4) — the view scale never changes |
| Esc / right-click during a drag | cancel — discard the in-progress drag, commit nothing, leave the crop exactly as before |
| Esc / right-click, no drag in progress | drop the current live window (the drawn window if one exists, else deactivate the auto-detect frame — its cached result survives and re-activates on the next Auto-detect press) |

On a committed page the one gesture is drawing, which behaves the same way: the rubber-band (mapped
back to page coordinates through `crop_origin`, §6.8) becomes the global drawn window, shown over
the cropped view with no zoom change; **Crop** re-commits the selection through it.

### 6.4 Drawing creates the live crop window — not a commit

A rubber-banded rectangle becomes the drawn window: the mouse-placed equivalent of the auto-detect
frame, shown with the standard dashed frame + handles on every uncommitted page (clamped to each
page's extent), taking precedence over the auto frame on screen, at Crop, and at export. **Finishing
a draw does not by itself create an undo checkpoint** — the drawn window is non-undoable scaffolding
state (§13); nothing undo-tracked changes until **Crop** commits it into the applied crop. A new draw
replaces the window; a draw smaller than `2·MIN_RECT` is discarded; Esc/right-click outside a drag
drops it. While Keep ratio is off, releasing a draw updates the ratio field to the drawn box's
width/height. The window does not touch the cached auto-detect union — that result survives and
reappears when the window is dropped.

### 6.5 A crop is never dropped except by Undo or a valid replacement

- On a committed page, a gesture that commits nothing valid (a stray click with no drag, or a draw
  smaller than `2·MIN_RECT`) leaves the committed crop unchanged.
- Editing a committed crop (a new draw, or a border/corner drag) re-commits the tightened box; it
  never silently reverts to uncommitted. Undo/Reset is the only way back to the full page.
- Re-detect refreshes committed pages instead of clearing them.
- Export writes every page through its committed box, else its drawn window, else its live auto
  crop, else the whole page — so a crop visible on screen is always exported.

### 6.6 Mouse gestures (split = 2 / 4)

Split 2/4 auto-creates N windows as an even grid; the same gesture model as a single crop applies to
each. On press: a window's interior moves it, a border moves that edge, a corner resizes it,
Esc/right-click during a drag cancels it (every window restores to its drag-start rectangle).

**Same size** (when on) and **Keep ratio** both hold **live** during the drag, not just on release —

- **Same size:** for any resize handle (corner/edge, never `move`) the dragged window's raw edge
  *deltas* propagate to every other window immediately, mirrored by grid parity: a partner in the
  other column is x-mirrored (`ΔL′=−ΔR, ΔR′=−ΔL`), a partner in the other row is y-mirrored
  (`ΔT′=−ΔB, ΔB′=−ΔT`), same column/row copies that axis unchanged. Grid order is `[left,right]` for
  n=2, `[TL,BL,TR,BR]` for n=4. Deltas are pre-clamped against every window's own headroom before
  being applied, so growth stops at the tightest window's page-edge limit instead of a partner
  needing to jump afterward. Turning **Same size** on immediately snaps every window to the first
  window's size (capped to each window's own unmoved origin) — the invariant holds from the toggle
  itself, not only after the next drag. A `move` (translating a window by its interior) never
  propagates to other windows, in any state — position is fully independent per window for a move.
- **Keep ratio:** holds live throughout the resize, anchored on the corner/edge opposite the dragged
  handle, so only the dragged side moves (§6.7).

A committed split page accepts no window gestures: no press/drag flips it back to the full page or
moves a split window. The one gesture that still works is drawing a new rectangle inside a shown
output page, which re-commits that window only (tightened), leaving the other windows untouched. To
rearrange the windows themselves: Undo (or Reset), adjust, Crop again.

### 6.7 Keep ratio holds in every case, live not on-release

Keep ratio locks `height = width/ratio` for every way a crop can be produced, holding it **live**
during the gesture rather than snapping on release (a deliberate usability improvement over
snap-on-release):

| Crop source | How the ratio is enforced |
|---|---|
| Live auto crop | normalised to the ratio on every render, anchored top-left. |
| Handle drag / move (drawn window, split rectangle) | held live throughout the drag, anchored on the corner/edge **opposite** the dragged handle — an edge drag grows the perpendicular axis symmetrically about the box centre, so only the dragged side moves. |
| Offset edits | committing an offset re-normalises the rectangle to the ratio. |
| A fresh draw | ratio-normalised (top-left anchored) when the draw is released. |

A ratio-constrained edge that would leave the page clamps to the page and the *other* dimension
re-derives from the clamped one — the anchor corner stays put and the ratio is held exactly, never
deformed (this replaced an earlier bug where the final page-edge clamp touched only one edge,
silently breaking the ratio for e.g. a 2-split window wider than half the page).

### 6.8 Committed-page crop coordinates

A committed single-crop page (split = 1) is shown cropped/zoomed to the committed box.
`ViewSnapshot.crop_origin {x,y}` is the full-page-unit top-left of the shown image: `{0,0}` on a full
page, the committed box's `(x0,y0)` on a committed page. Every page↔canvas conversion shifts by it:

```
canvas_px = img_origin + (page_coord − crop_origin) · scale      // painting overlays / draw_rect
page_coord = crop_origin + (canvas_px − img_origin) / scale       // pointer → page
```

A drag on a committed page rubber-bands a new drawn window over the cropped view with no zoom
change — the canvas never flips back to the full page; the window is clamped to the committed box
(a new window can only tighten it).

---

## 7. Scan processing pipeline *(SCANNED mode only)*

Two rasters per page: **`source[i]`** — rendered once at `SRC_DPI`, pre-process and immutable (the
basis for idempotency and Reset); **`work[i]`** — the current processed raster, shown on the canvas
and cropped/exported. `work` is always re-derived from `source` through the current intent, so
repeated presses equal one press and re-filtering starts from the un-filtered image. Each page is
rasterized exactly once per (page, rotation) — the source render is never re-run to derive `work`.

```
                       source[i]   (immutable, @ SRC_DPI)
                           |
              Dewarp & Deskew ON ? ----------- no ----------+
                           | yes                            |
              docuwarp/ONNX mesh unwarp (deskew included)   |
                           |                                |
                           +---------------+----------------+
                                           v
                                         base
                                           |
            +------------------------------+------------------------------+
        Filter = B/W                   Filter = Sharpen                Filter = None
   Sauvola bilevel (1/2/3)       flatten + denoise + unsharp (1/2/3)        |
            +------------------------------+------------------------------+
                                           v
                                        work[i]  -->  detect / crop / export
```

Scan toggles are eager: Dewarp/B-W/Sharpen/strength flip their intent instantly (undoable), then
return a batch job that streams the Pages selection's rasters through the pipeline once under the
progress overlay (§11) — cancellable; a cancelled pass keeps the new intent, remaining pages compute
lazily on view. A two-tier, write-back raster cache backs this: a small in-memory LRU
(`CACHE_WINDOW` pages) for the current viewing window, plus an IndexedDB disk tier keyed by
document-generation + page + processing-intent — a raster is persisted to disk only when genuinely
evicted from the RAM tier (write-back, not eager), and the disk is read only for a key that was
actually persisted, so a document that fits in RAM does zero IndexedDB I/O on the hot path.

### 7.1 Dewarp & Deskew

A single toggle. A two-stage ONNX pipeline (UVDoc warp-field model + bilinear resample) removes page
curl/fold and incidental skew in one pass — there is no separate deskew step. Execution providers
are `['webgpu','wasm']`, gated on `navigator.gpu`, `numThreads=1` — no `SharedArrayBuffer`
dependency (GitHub Pages cannot set the COOP/COEP headers that would require). The **Dewarp
supersample** setting (§14, default 2.0) renders the page larger before the mesh remap and
downsamples after, trading time for less resampling blur.

### 7.2 Filter modes (each 3 strengths)

- **B/W (bilevel):** illumination-flatten (divide by a morphological-close background estimate,
  computed on a downscaled copy for speed — see §16) → Sauvola threshold → connected-component
  despeckle. Strength selects `(sauvola_k, min_area)`.
- **Sharpen:** illumination-flatten → bilateral denoise → unsharp mask; keeps continuous tone so
  photos survive. Strength drives both the denoise/blur radius and the unsharp gain.

Processing is committed only on a button press, over the Pages selection. Detect and crop read
`work`, except Auto-detect, which always reads the **raw source** even in SCANNED mode (§5).

---

## 8. Pages selection

Four buttons, always visible: `All · Odd · Even · Selected` (1-indexed; Odd = 1,3,5 → indices 0,2,4;
Even = 2,4,6 → 1,3,5). The resolved index set drives detect, dewarp, filter, crop, rotate and
delete.

**Selected** reveals an inline Pattern field and a Current button:

- **Pattern** accepts a 1-indexed list, inclusive `a-b` ranges, and colon slices
  `start:stop[:step]` (1-indexed inclusive; optional ends/step — `1:4`==`1-4`, `1:100:5`==1,6,...,96,
  `::2`==every odd page, `10:`==page 10 to the end), mixed freely: `1:4, 10:30, 35, 37`. Out-of-range
  values are ignored.
- **Current** is a follow toggle: pressing it switches to Selected, fills Pattern with the current
  page, and keeps Pattern synced to the page as you navigate. Pressing it again, editing Pattern by
  hand, or choosing All/Odd/Even turns follow off, leaving the pattern as-is.

---

## 9. Multi-file load & combine order

Load Files opens a multi-select picker filtered to PDFs and images. The chosen inputs concatenate
into one working document, each contributing its pages in order: a PDF contributes all its pages in
document order; an image becomes one page sized to the image. The combined order is the order the
picker returns the selection. A document built entirely from images (no vector data) classifies
SCANNED; a mix including any native PDF page classifies NORMAL.

---

## 10. Rendering, crop application & export

### 10.1 The one raster render path

`render_output_image(src, box, page_w, page_h, target_long_px, greyscale)` is the one raster image
path, used by the on-screen preview always, and by export whenever export rasterizes: a SCANNED
document in any format, or a NORMAL document exporting to JPG/PNG/TIFF. It crops to `box`, resamples
to `target_long_px` (`null` = native resolution), optionally desaturates.

**The preview is never DPI/colour-adjusted** — it always renders at native resolution, full colour,
regardless of the Output Quality settings; those settings (compress DPI, output colours) apply to
the exported file only. Rendering a preview at export DPI made a small crop appear e.g. 75dpi and
grayscale on screen, which was wrong for an editing view. WYSIWYG is preserved for what actually
varies live under user control — crop geometry, filters, rotation, split — just not the two
export-only settings.

### 10.2 Apply Crop

Stores the crop box(es) per page (§6.1) over the Pages selection; other pages are untouched. This is
the persisted, undoable crop state. Crop requires a crop source (§4.7); with none it is a no-op —
nothing is committed, no history snapshot taken. Per selected page the committed box is: the drawn
window if one exists, else the page's live auto crop if active, else the page is skipped. A
committed split page turns each source page into its 2 or 4 windows, so the document holds 2×/4× as
many output pages, including in navigation (§4.9).

### 10.3 NORMAL-mode PDF export is vector, not rasterized

For a NORMAL document exporting to PDF, crop/rotate/split apply as vector operations against the
**original** page content via pdf-lib (`embedPage` with a clipping bounding box, `setRotation`) — no
`render_output_image` call, no rasterization at all. A split page's N crop windows each become their
own output page via N `embedPage`+`drawPage` calls against the same source page. Box coordinates
convert from the app's current (rotation-adjusted) display frame to the source page's own native
frame first, since `embedPage`'s clip operates in that frame. Image-sourced pages inside a mixed
PDF+image NORMAL document embed losslessly (PNG/JPEG passthrough, no re-encode) via the same
coordinate math expressed as a draw offset; any other browser-decodable image format re-encodes once
as PNG. This is the **only** case that bypasses §10.1's one-raster-path rule — a NORMAL document
exporting to JPG/PNG/TIFF still uses `render_output_image` like everything else.

### 10.4 Compress / output sizing (rasterized exports only)

Applies only when export actually rasterizes (§10.1). The output DPI × paper-size math: each output
page's long side `L = dpi × paper_height_in` pixels (e.g. A4 → 11.69in → 300dpi → 3507px), the short
side scales by the crop's own aspect (no distortion, no padding). `Original resolution` keeps the
source raster size. Paper size is a Settings → Output dropdown (`PAPER_SIZES`: A2–A6, default A4)
plus a Custom… entry backed by a numeric paper-height-in-inches field, revealed the same way as
Custom DPI (§4.8) — both via one shared `syncCustomReveal()` helper. Custom DPI is editable in both
the sidebar Output Quality card and Settings → Output — one shared state; editing either switches
the preset to Custom.

### 10.5 Export formats

| Format | Ext | Output |
|---|---|---|
| PDF (default) | `.pdf` | one PDF file — vector for NORMAL (§10.3) or a raster-embedded page-per-page PDF for SCANNED. |
| JPG | `.jpg` | one `.zip` containing one JPG per output page. |
| PNG | `.png` | one `.zip` containing one PNG per output page. |
| TIFF | `.tif` | one `.zip` containing one TIFF per output page (hand-rolled baseline uncompressed 8-bit RGB single-strip encoder — the browser canvas has no native TIFF path). |

Image formats (JPG/PNG/TIFF) always deliver **one `.zip`** (`<base>.zip`, entries
`<base>_NNN.<ext>`), never N loose downloads — a browser cannot write a chosen folder without a
per-file save prompt, so a single archive is the correct behavior here. The export progress bar
spans both phases for image formats: render advances the first
half, per-page encode the second, so it does not complete then hang during zip encoding. Export
yields to the event loop between pages so the bar actually animates.

### 10.6 A visible crop is never dropped from the file

On export each page's box is: the committed box if committed, else the drawn window, else its live
auto crop when active, else the whole page. Export first commits the drawn/live crop of any
uncommitted selected page; with Split active it (re)commits the selection's N rectangles regardless
of earlier single-crop state.

---

## 11. Progress overlay & batch model

Long operations (detect on scans, dewarp, filter, export) show a centred card on the canvas —
message, determinate bar, page counter, Cancel — not a separate window. A worker or the main-thread
event loop drives the batch page-by-page, yielding between pages so the overlay repaints and Cancel
is honored. A single-page job (`total === 1`) skips the overlay and runs synchronously. Cancel sets
a flag checked before each page and stops promptly with no partial file. While a batch is busy,
controls are disabled and further clicks are ignored (no command queueing). A per-page exception
surfaces as an error toast and ends the batch cleanly.

---

## 12. History, reset, rotate, delete

`DocumentState`'s undo boundary is exactly 8 fields: `applied` (committed crop/split), `crop_rects`
(live split layout), `rotation`, `processed` (scan-processing intent), `offsets`, `dewarp_on`,
`filter_mode`, `filter_strength`. Auto-detect's results (the per-page detected-box cache, the union,
whether detection has run at all) and the in-progress hand-drawn window are **non-undoable**
`AppModel` fields, not `DocumentState` fields — they are scaffolding used to *arrive* at a committed
operation, not an operation themselves. Concretely: pressing Undo immediately after Auto-detect,
before anything is committed via Crop, is a no-op; finishing a rubber-band draw (§6.4) does not push
a checkpoint either — only **Crop** (`apply_crop()`) does. Undo continues to fully revert
`applied`/`rotation`/`offsets`/(SCANNED-mode) `processed`/`dewarp_on`/`filter_mode`/`filter_strength`.

- **Undo/Redo** — a bounded stack of `DocumentState` snapshots, depth from the Undo/redo-depth
  setting (preset dropdown, `UNDO_DEPTH_OPTIONS = [1,2,4,8]`, default 2). A snapshot is taken before
  every undoable mutation (Crop, offset commit, a completed drag resize, rotate) — see above for what
  is deliberately excluded. Restoring a snapshot clears the raster caches so pages re-render.
- **Reset** — reloads the same input files (or the synthetic placeholder) and re-combines them,
  clearing all crops, rotation, detection, processing and history; returns Split to 1 and clears
  filter/dewarp highlights.
- **Rotate** — a per-page rotation-angle map (0/90/180/270° CW). Adds 90° and drops only that page's
  rasters (they re-render at the new angle); the committed crop and the cached detected box are
  carried through by rotating their coordinates 90° CW, so cropping survives a rotate. Offsets reset
  to default; the detection union is rebuilt (with the same `FULL_PAGE_FRAC` exclusion §5 applies at
  detect time — never a raw re-aggregate that would readmit an excluded fallback box). With split 2/4
  active, the windows re-lay out automatically to the rotated page. Fully undoable.
- **Delete** — removes the Pages selection, refuses to delete every page, confirms first. Reindexes
  every per-page map (`applied`, `rotation`, `processed`, the detection cache) so surviving pages'
  adjustments are preserved; the page-index map is rebuilt *before* the union rebuild, since the
  union math judges each remaining box against its own post-reindex page dimensions. **Not
  undoable** (`history.clear()`, not push) — the page-index map lives outside `DocumentState`, so a
  restored snapshot could reference indices the map no longer has.

---

## 13. Settings

A section of the detail panel, four blocks in order:

```
Appearance
  Colour scheme    [ Dark | Light | System ]   segmented, applied live
  Font size        [ 15            v ]         preset dropdown (8,10,12,15,18,22,25pt)
  Zoom (UI scale)  [ 100%          v ]         preset dropdown (70–200%); = Ctrl +/-
Output
  Output postfix     [ _cropped         ]      appended before the extension
  Custom DPI         [ 300              ]      shared with the sidebar Output Quality field
  Paper size         [ A4              v ]     PAPER_SIZES + Custom… (export sizing base, §10.4)
  Custom height (in) [ 11.69            ]      shown only when Paper size = Custom
Behaviour
  Remember last folder     [ on  ]
  Undo / redo depth        [ 2   v ]           preset dropdown, [1,2,4,8]
Scan
  Dewarp supersample       [ 2.0 ]             quality lever for dewarp (§7.1); 1.0 = off
```

Theme/font-size/zoom are presentation-only `UIConfig`, owned by the UI layer, invisible to the
domain model. Everything else in this panel is a domain `Settings` field (survives Undo, §12) and,
for postfix/Custom DPI/paper size/undo depth/dewarp supersample, has its own typed setter on
`AppModel` — there is no single `apply_setting()` dispatcher. Output-quality fields shared with the
sidebar (Custom DPI) write through the same setter either control uses, so editing one always
updates the other.

---

## 14. Help

A section of the detail panel: a heading, a one-line description, then a Contents card (one button
per section, clicking scrolls the body to it), then the section blocks in order, ending with an
About block (app name, purpose). Content must describe actual current behavior — see §16 for the
review pass that keeps it accurate.

---

## 15. File I/O

**Load:** a file picker (`<input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff">`) or
drag-and-drop onto the canvas. Combine order and mode classification follow §9.

**Export:** PDF triggers a browser download directly (vector for NORMAL, raster-embedded for
SCANNED, §10.3). JPG/PNG/TIFF download as one `.zip` (§10.5). There is no overwrite-confirmation
control — a browser download cannot detect or block an overwrite, so no such setting is offered.

---

## 16. Performance targets

| Operation | Target |
|---|---|
| Canvas repaint (non-imaging) | < 16ms (60fps during drag) |
| Page navigation | < 100ms (RAM cache hit: immediate draw; RAM-miss but disk-hit reloads from IndexedDB, no recompute) |
| B/W or Sharpen filter per page | < 500ms (SIMD WASM opencv.js + downscaled illumination-flatten morphology) |
| Auto-detect per page | < 100ms (SCANNED: raw source, not the processed work image; NORMAL: text-layer, no raster at all) |
| Dewarp per page (ONNX stage) | seconds on the 1-thread WASM execution provider; fast on WebGPU where available |
| Export per page (rasterized path) | < 300ms |
| First OpenCV.js WASM load | < 3s, once per session (~10MB SIMD build, lazy — SCANNED documents only) |
| First ONNX model fetch + init | < 5s, once per session (cached in IndexedDB after; 0ms on repeat sessions) |

OpenCV.js is a SIMD (v128) WASM build, single-thread — no `SharedArrayBuffer`, no COOP/COEP (GitHub
Pages cannot set those headers). The illumination-flatten background estimate for the B/W filter and
Auto-detect (§7.2, §5) runs its 51×51 morphological close on a downscaled copy (`BG_DOWNSCALE`) and
scales back up — near-lossless (the final bilevel output agrees with a full-resolution result at
~95% of pixels — the same numerical agreement opencv.js already has vs. a reference implementation
from box-filter/threshold differences alone) and roughly 36× cheaper, since single-thread WASM
morphology has no large-kernel optimization and would otherwise dominate both operations' cost.

---

## 17. Constants

`src/core/constants.ts` is the single source of truth for domain tunables (mirror it exactly; do not
duplicate values into logic). UI-only tunables live in `src/ui/constants.ts`.

```
# DPI / caches
SRC_DPI = 150.0    NORMAL_DPI = 150.0    CACHE_WINDOW = 4
# crop geometry
HANDLE_R = 10    HANDLE_SLACK = 6    CANVAS_MARGIN = 0    OFFSET_LIMIT = 100.0    MIN_RECT = 5.0 (geometry.ts)
# classification / detection
MODE_TEXT_MIN = 8    DETECT_MAX_PX = 1400    BORDER_FRAC = 0.02
MIN_COMP_FRAC = 2.5e-4    FULL_PAGE_FRAC = 0.97    DESKEW_MAX_DEG = 15.0
# Sauvola / illumination-flatten (real box-filter Sauvola, not an adaptiveThreshold approximation)
SAUVOLA_R = 127.5    SAUVOLA_WINDOW = 51    BG_KERNEL_SIZE = 51    BG_DOWNSCALE = 4
SAUVOLA_DPI_REFERENCE = 150.0    SAUVOLA_DPI_SCALE_MIN/MAX = 0.5 / 4.0
# filter strengths
BW_STRENGTH[1..3]      = { k, minArea } per level
SHARPEN_STRENGTH[1..3] = { d, sigmaColor, sigmaSpace, blurSigma } per level
CLEAN_AMOUNT[1..3]     = 0.6 / 1.1 / 1.6   # Sharpen unsharp gain
FILTER_STRENGTH_MIN/MAX = 1 / 3
# split / synthetic doc
MAX_SPLIT = 4    SYNTH_PAGES = 1    SYNTH_W = 595    SYNTH_H = 842   # A4 @ 72dpi points
# output sizing
DPI_PRESETS = {"Original resolution": null, "High — 300 dpi": 300, "Medium — 150 dpi": 150, "Low — 75 dpi": 75}
CUSTOM_DPI_PRESET = "Custom"   DEFAULT_CUSTOM_DPI = 300   CUSTOM_DPI_MIN/MAX = 50 / 1200
PAPER_SIZES = { A2, A3, A4 (default), A5, A6 }  (width_in, height_in per size)
CUSTOM_PAPER_PRESET = "Custom"   DEFAULT_CUSTOM_PAPER_IN = A4.height_in   CUSTOM_PAPER_MIN/MAX = 1 / 60
EXPORT_FORMATS = ["PDF","JPG","PNG","TIFF"]    IMAGE_LOAD_EXT = [.pdf,.jpg,.jpeg,.png,.tif,.tiff]
JPEG_QUALITY = 0.92
# defaults / behaviour
DEFAULT_COMPRESS_PRESET = "Original resolution"   DEFAULT_OUTPUT_COLOURS = "Original colors"
DEFAULT_EXPORT_FORMAT = "PDF"    DEFAULT_OUTPUT_POSTFIX = "_cropped"
DEFAULT_UNDO_DEPTH = 2    UNDO_DEPTH_OPTIONS = [1,2,4,8]    UNDO_DEPTH_MIN/MAX = 1 / 50
DEFAULT_DEWARP_SUPERSAMPLE = 2.0
# dewarp model (pstwh/docuwarp, two-stage ONNX)
DEWARP_MODEL_W/H = 488 / 712   (fixed CNN input size, not tunable)
```

The Undo/redo depth and Dewarp-supersample are runtime `Settings` (§13), not constants.

---

## 18. Typography & theme

CSS custom properties inject a warm-gray-chrome + blue-accent palette, dark/light/system (`system`
follows `prefers-color-scheme` live via a `matchMedia` listener) — `src/ui/theme.ts`. Font size is a
preset dropdown (`FONT_SIZE_PRESETS`: 8,10,12,15,18,22,25pt, default 15); UI zoom is a preset
dropdown (`ZOOM_PRESETS`: 70–200%) layered on CSS `font-size` scaling, sharing state with the
`Ctrl +/-`/`Ctrl 0` keyboard steps. Buttons carrying a primary action lead their label with a small
glyph (`↩ Undo`, `↪ Redo`, `↺ Reset`, `✦ Auto-detect`, `✂️ Crop`, `↻ Rotate`, `🗑︎ Delete`,
`📂︎ Load PDF/Image Files`, `💾︎ Export`, `⚙ Settings`, `? Help`), glyph first, then the control's
name. Nothing is drawn onto the page bitmap itself; the only canvas-adjacent text is the bottom-right
cursor read-out (§3).

---

## 19. Error handling

`core/errors.ts` defines a typed error taxonomy, raised in `core/` and caught only at `AppController`
dispatch sites: `NoDocumentError`, `EmptySelectionError`, `InvalidSplitError`, `DeleteAllPagesError`,
`DocumentLoadError`, `ImagingError`, `MissingDependencyError`. `AppController.dispatch`/
`dispatch_async`/`dispatch_job` are the only error-catch sites in the app; a caught error surfaces as
a dismissible toast, never a silent failure. An unhandled promise rejection is caught by a global
`window.addEventListener('unhandledrejection')` handler that clears the current job, hides the
overlay, repaints, and surfaces the error — the app always lands on a usable, repaint-consistent
state.

- No document loaded → actions are no-ops; nav shows `/ 0`.
- Empty Pages selection → the relevant action throws `EmptySelectionError`, surfaced as a toast; no
  partial mutation.
- A drag collapsing a rectangle clamps to `MIN_RECT`, never inverts.
- A crop rectangle is always clamped to the page; degenerate results are skipped.
- A failed dewarp/filter/export on one page in a batch ends the batch with an error toast; the
  document is left in its pre-batch state for that page (no partial commit).

---

## 20. Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+O` | Load Files |
| `Ctrl+Enter` | Apply Crop |
| `Ctrl+S` | Export (current format) |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `ArrowLeft`/`ArrowRight`, `PageUp`/`PageDown`, mouse wheel over canvas | Prev/Next page |
| `Ctrl +`/`Ctrl -`/`Ctrl 0` | Zoom UI / reset (shares state with the Settings dropdown) |
| `Enter` in the page box | Jump to page |
| `Esc` / right-click during a drag | Cancel drag |
| `Esc` (not during a drag) | Closes the detail panel if open, else drops the current live crop window (§6.3) |

---

## 21. Acceptance invariants

1. After Auto-detect with all offsets 0, each page's crop is the constant `W×H` union size, starting
   at its anchored top-left — shifted inward where it would overhang the page, never shrunk (§5, §6.2).
2. Dragging any handle leaves every non-dragged edge pixel-stable across the whole drag.
3. Repeated Dewarp/filter presses produce the same `work` raster as one press (idempotent from
   `source`, §7).
4. Undo reverts crop, rotate, and (SCANNED) dewarp/filter; it does **not** revert a bare Auto-detect
   or an uncommitted drawn window (§12). Reset re-opens the whole document.
5. Rotate preserves filtering and the committed/detected crop (boxes rotate with the page); Delete
   preserves kept pages' adjustments via reindexing, never a wipe (§12).
6. Nothing in scan processing runs without an explicit button press.
7. Crop rectangles never extend outside the page.
8. Batches run page-by-page with a yield between pages; the overlay reports progress for detect,
   dewarp, filter and export and paints smoothly; Cancel stops before the next page with no partial
   file (§11).
9. Resident raster memory stays bounded regardless of page count (RAM LRU `CACHE_WINDOW`; disk tier
   write-back only; export streams).
10. NORMAL-mode PDF export never rasterizes (§10.3); every other export path goes through the one
    raster render function (§10.1) — never a second raster path.
11. A committed 2/4-split page is navigable as N output pages per source page in reading order; the
    page counter shows the output total and matches the export (§4.9).
12. Preview and a rasterized export produce identical crop/rotation/filter pixels via the one render
    path; compress DPI and output colours apply to the exported file only, never the preview (§10.1).
13. The drawn window is the mouse twin of Auto-detect: it never touches the cached detection state,
    and dropping it restores the auto frame. Auto-detect symmetrically replaces a drawn window on the
    spot.
14. The fitted page/crop never overflows the canvas; the wheel turns pages and never magnifies.
15. A crop is never dropped except by Undo or a valid replacement — on screen and in the exported
    file (§6.5, §10.6).
16. Auto-detect works after a crop: re-detect refreshes a committed crop on detected pages instead of
    clearing it; pages outside the selection keep theirs.
17. Multi-file combine: loading several files builds one document in the picker's selection order
    (§9).
18. Classification: NORMAL if any page carries vector data, SCANNED only when every page is
    image-only (§1).
19. Keep ratio holds live in every case — the live auto crop, every drag gesture, offset edits, the
    drawn window and split rectangles, in both modes — no gesture bypasses it (§6.7).
20. Image-format export (JPG/PNG/TIFF) always delivers one `.zip`, never loose per-page files
    (§10.5).
21. Crop with no source is a no-op: at split = 1 with no active detection and no drawn window on any
    selected page, Crop commits nothing and takes no snapshot.
22. A committed split page ignores window gestures except a fresh draw, which re-commits only the
    window it was drawn on.
23. A completed drag resize (auto crop, split window, drawn window) is undoable one drag at a time;
    finishing a rubber-band draw is not, by itself (§6.4, §12).
24. Rotate and detection commute: rotating re-lays split windows out on the rotated page; the drawn
    window and committed/detected boxes rotate with their pages; detection on a rotated page returns
    its box in the rotated page's coordinate space.
25. A failed dewarp inference does not crash the batch or commit a half-processed selection; the
    failure surfaces as an error toast.
26. A new live crop box (Auto-detect or a fresh draw) drops the previously active box and resets all
    four offsets to 0 before the new box appears.
