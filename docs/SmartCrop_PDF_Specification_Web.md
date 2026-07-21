# SmartCrop PDF Web — Specification

A browser app to combine, crop, straighten, clean and compress PDFs, scans and images for reading
on e-readers, phones and tablets. It loads one or many files (PDFs and/or images) into a single
working document, crops/filters/compresses them, and exports as PDF or a chosen image format. This
document is the behavioral contract: architecture, UI, algorithms, state and acceptance invariants.
`ARCHITECTURE.md` explains *how* this is implemented (module layout, dependency graph, worker
model, build/deploy); this document explains *what the user experiences*. Where a fact could belong
to either, ask "does the user experience this?" — if yes, here; if no, ARCHITECTURE.md.

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
`page_w`/`page_h` above are the committed box's own dimensions, not the full page — see §6.8's
`crop_origin` mechanism for the exact pointer↔page mapping in that case.

The page view is always **fit-to-window**: `scale` recomputes on every render and on canvas resize,
so the whole page (or the whole committed crop) is always fully inside the canvas on both axes —
never magnified out of view. There is no page zoom; **the mouse wheel over the canvas turns pages**
(up = previous, down = next). `Ctrl +/-` scales the whole UI (§14 Settings), not the fitted page.

**NORMAL-mode preview sharpness.** The underlying page raster is rendered at a DPI independent of
this fit-to-canvas `scale` — `scale` only decides how that raster is drawn into the canvas, not
what resolution it's rendered at. On a large window or a HiDPI display, drawing a fixed
150dpi (`NORMAL_DPI`) raster at a much larger `scale` upscales it, which blurs. Whenever the
canvas resizes, it reports its physical-pixels-per-page-unit ratio (`scale × devicePixelRatio`)
to `AppModel.set_display_scale()`, which re-renders the NORMAL-mode source raster at whatever DPI
that ratio actually needs — never below `NORMAL_DPI`, capped at `NORMAL_DISPLAY_DPI_MAX` — only
when meaningfully sharper (>10%) than the last render, and never back down once bumped in a
session. This is purely a display/rendering concern: crop/split/offset geometry (all in PDF
points, per above) is completely unaffected by which DPI the raster happens to be shown at — the
operation metadata that actually gets exported (§10.3) never touches this raster at all for a
NORMAL+PDF export. SCANNED mode is untouched — `SRC_DPI` stays fixed; the scan pipeline's
performance budgets (§16) are tuned against it, and re-deriving a whole dewarped/filtered raster
at a different resolution on every window resize would be far more expensive than a plain PDF.js
re-render.

---

## 3. Layout

A fixed three-column layout: a scrollable left sidebar, a collapsible detail panel, and the page
canvas filling the rest (never below 400px). There is no floating window, no modal, no OS-level
draggable sash — everything is a normal DOM sibling and a normal flex participant. The detail panel
is collapsed to zero width by default; opening it grows its width — to match the sidebar for
Settings, to 1.5× the sidebar for Help (more room for prose and the contents list) — which reflows
the canvas column to the right by that same amount (the canvas's fit-to-canvas scale/ratio changes
accordingly, same as any other window-width change).

```
+--SmartCrop PDF — filename.pdf-----------------------------------------+
| [left sidebar] [detail panel: same width] [canvas: flex, reflows]     |
|                                                                        |
| Document & State      <- Settings or Help content        page bitmap  |
| Pages to Process         appears here when active,                    |
| Scan Processing          pushing the canvas right by      crop frame  |
| Split Each Page Into     the panel's width.                overlay    |
| Detect Text Borders                                                   |
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
Processing (SCANNED only, no residual gap when hidden), Split Each Page Into, Detect Text Borders
(includes the drawn-window L/T/R/B fields, §4.6), Actions, Output Quality, Export.
Pinned bottom bar, outside scroll,
one instance only: Settings/Help row, then Undo/Redo/Reset (3 equal buttons), then page nav
`< [n] / total >`.

**Detail panel** — collapsed to zero width by default. Settings grows to the sidebar's own width
(its rows are laid out to fit that width, wrapping onto a second line where a label + control don't
both fit); Help grows to 1.5× that width. Clicking Settings or Help grows it from the sidebar/canvas
boundary, reflowing the canvas right by the panel's width; closing it (same button again, or
**Esc**) reflows the canvas back. Pressing the other button swaps content (and width) with no
close/reopen animation.

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
| Dewarp & Deskew | Turns dewarp on over the Pages selection (§6). Pressing it again while already on is a no-op — it does not toggle back off; Undo is the only way to remove it. |
| B/W / Sharpen (mutually exclusive) | Sets the filter mode over the Pages selection. Switching to the other filter replaces it in one step. Pressing the already-active one is a no-op — it does not toggle back off; Undo is the only way to remove it. |
| Strength 1 / 2 / 3 | Always selectable regardless of whether a filter is active; applies once a filter mode is on. |

Nothing here runs automatically — only on a button press. A processing operation persists until
explicitly undone; there is no separate "reverse" gesture on the same button (§7).

### 4.4 Split Each Page Into

`1 / 2 / 4` → that many output pages per source page (§7.4). N > 1 reveals **Same size** and
switches Detect/anchors to per-region detection (§4.5, §5a) — the drawn-window L/T/R/B fields
(§4.6) stay split = 1 only, since a hand-drawn window is a single global rectangle with no notion
of "region". Changing the split count clears any committed crop from the previous layout and
re-seeds an even grid of N windows (§7.4), and discards any prior per-region detect result (the
regions themselves changed shape/count) — Auto-detect needs a fresh press after a split-count
change.

**Keep ratio** (toggle + numeric field): when on, the crop height is locked to `width / ratio` for
every crop source in both modes (§7.7). The field pre-populates from whatever crop shape is
currently on screen when the toggle turns on.

### 4.5 Detect Text Borders

| Control | Action |
|---|---|
| Auto-detect | Runs detection over the Pages selection (§6). An action, not a toggle — never highlighted, always re-pressable. Disabled when both anchors are off or a batch is running. At split = 1, drops any hand-drawn window (§6.1) and replaces it with the fresh detected union. At split = 2/4, replaces `crop_rects` with a fresh detected-and-anchored set of N windows (§5a) — same effect on the split layout a fresh drag would have. |
| Anchor Left / Anchor Top | Left/top edge from this page's (or, at split > 1, this region's) own detected content (on) or the shared union edge (off). At least one anchor must be on for a crop to exist. |

Re-running Auto-detect refreshes an already-committed page's crop to the fresh box instead of
dropping it (§4.5, §7.4) — split = 1 and split > 1 alike.

### 4.6 Drawn-window L/T/R/B fields *(split = 1)*

No switch — the fields appear automatically whenever a crop window is hand-drawn (§6.1 item 2,
§6.4) and disappear when it's dropped. Four per-edge percent fields, `L T R B` (±`OFFSET_LIMIT`,
step 0.1): each shows that edge's position relative to its own page side — `L`/`T` measured from
the left/top, `R`/`B` measured in from the right/bottom — as a percentage of the page dimension.
Editing a field moves that edge directly; dragging a handle and editing a field always agree, both
describing the same window (§6.4's existing drag mechanics are unchanged — click outside it drops
it and starts a new draw, same as any other drawn window). The fields have nothing to show while
no window is drawn.

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
  there is no raster fallback.
- **SCANNED:** `content_box` over a real Sauvola-filtered binarization of the page (§6), downscaled
  to `DETECT_MAX_PX` for speed, run on the **raw source raster** — never the dewarped/filtered work
  image (dewarp's small geometric shift is not reflected in the detected bounds — an accepted
  fidelity tradeoff; this is also what keeps detection within its <100ms/page budget, §16). No ink →
  no detected box for that page.

A page with no detected box of its own is **not** left uncropped: it has no per-page
anchor point, so instead of `auto_crop_rect`'s anchor-based placement it gets the shared union's
own W×H, **centered** on the page — `centered_crop_rect` (geometry.ts). This applies everywhere the
per-page auto-crop is resolved: committing (Crop), the live preview overlay, export of an
uncommitted page, and refreshing an already-committed page after a re-detect. Still gated on the
same "auto-detect is active and at least one anchor is on" condition as every other auto-crop —
with both anchors off, such a page stays uncropped like before.

Then aggregate across the selection to fix one constant crop size for the whole document:

```
gL = min(x0)            gT = min(y0)                # top-/left-most corner (anchor-OFF base)
W  = max(x1 − x0)       H  = max(y1 − y0)           # largest content width / height across pages
union = (gL, gT, gL+W, gT+H)
```

`W,H` is by default the *largest* content box found, not the bounding span of all edges. Full-page
fallback boxes are excluded from the aggregate (any page whose detected box is ≥ `FULL_PAGE_FRAC` of
the sheet in both axes), so one failed page can't blow `W,H` up to the sheet size. This exclusion is
re-applied identically whenever the union is rebuilt after a rotate or a delete (§12) — one shared
`_compute_detection_union` helper, no separate re-implementation. Per-page boxes and the union are
cached (non-undoable AppModel state — §13).

**Outlier tolerance**: Settings → Behaviour → "Ignore N outlier pages"
(`DETECT_OUTLIER_OPTIONS = [0,1,2,5,10]`, default 2). When N > 0, `W`/`H` are each the
`(N+1)`-th *largest* per-page width/height — sorted independently, so the page contributing `W`
need not be the same page contributing `H` — instead of always the maximum; `gL`/`gT` (the min
corner) are unaffected. This lets a handful of oversized pages (e.g. a few fold-out or
larger-trim pages in an otherwise uniform scan) get excluded from sizing the shared crop instead
of inflating every page's crop to fit them. N=0 reproduces the plain-max behavior exactly. The
same `settings.detect_outlier_pages` value and the same aggregation helper apply to the initial
detect and to every union rebuild (rotate, delete) — no separate tolerance-aware code path.

`content_box(bilevel)`:

```
ink        = bilevel < threshold
merged     = morphological_close(ink, DETECT_CLOSE_W × DETECT_CLOSE_H)  # bridge inter-glyph gaps
components = connected_components(merged, 8-connectivity)
keep       = components with area >= MIN_COMP_FRAC · page_area
                 AND not touching the outer BORDER_FRAC margin
if keep is empty:  keep = components with area >= MIN_COMP_FRAC · page_area   # fallback
box        = bounding rectangle of the kept pixels
```

The close step is required, not cosmetic: at `DETECT_MAX_PX` resolution individual glyphs rarely
touch their neighbours, so without it every letter is its own component and none clears
`MIN_COMP_FRAC` on its own — real body text was discarded entirely, leaving only incidental large
components (a rule line, an image) to define the box. The close is horizontal-biased (bridges
inter-letter/inter-word gaps within a line) without merging separate lines into one blob — each
kept component is still a text line, not a whole paragraph; the bounding rectangle over all of them
gives the same tight paragraph-level box as before.

Detection is non-destructive and deterministic; it is always safe to re-run.

**Rotation-aware mapping.** Detection always returns a box in the rotated page's current coordinate
space: the SCANNED path reads the already-rotated work raster; the NORMAL path reads the document's
(unrotated) text layer and the caller accounts for rotation when caching. Detecting after a rotation
therefore equals rotating after a detection.

### 5a. Auto-detect at split = 2/4

Detection runs independently within each of the N regions of the even grid `split_rects_grid`
seeds (§7.4, §9.6) — a page's left half never influences its right half's detected box, and
vice versa. Per region:

- **SCANNED:** the same Sauvola/connected-components `content_box` as §5, run only over that
  region's pixels (the source raster cropped to the region first) — border/min-area exclusion is
  judged against the *region's* size, not the whole page, so a box spanning the whole region (not
  the whole page) is what counts as a "full page" fallback to exclude from that region's union.
- **NORMAL:** the same text-run union as §5, but only over runs whose centre falls inside the
  region (a run straddling the boundary belongs to whichever region contains its centre, never
  both).

Each region then aggregates its own cross-page union exactly as §5's `gL/gT/W/H` does (same
`detection_union`, same outlier tolerance, same FULL_PAGE_FRAC exclusion — just judged region-by-
region instead of once for the whole page).

**Resolving into `crop_rects`.** Unlike split = 1 — where each page resolves its own crop from its
own cached box at apply time (§6.2) — `crop_rects` is one shared set of N windows applied
identically to every page (§7.3, §9.6): there is no per-page variation to compute, and critically,
no well-defined *single page* to anchor a shared template to either. Each region's window is
simply **that region's own cross-page union**, clamped to the region:

```
per region r:
  region_r = split_rects_grid(n)[r]     # this region's slice of the page (any page — see below)
  W, H     = SameSize ? (max width, max height across all N regions' own unions) : union_r's own W,H
  rect_r   = union_r's own top-left corner, sized W×H, clamped to region_r
```

Earlier revisions anchored each region's window to the *current* page's own detected box instead
of the union directly — plausible by analogy with split = 1's per-page anchoring, but wrong here:
with no per-page target to write the result into, that anchor point was really "whichever page the
user happened to be viewing when they pressed Auto-detect," an incidental piece of navigation
state. Confirmed as a real, reproducible bug, not a hypothetical: identical content produced
different `crop_rects` depending on which page was open, and adjacent regions' windows could leave
a gap between them even though their own unions met exactly at the region boundary — the arbitrary
per-page box just didn't happen to reach it. `region_r` itself is still read from *some* page's
dims (any selected page — `split_rects_grid`'s geometry only, not its content) purely to know the
grid's pixel layout; unlike the corner/size above, that's page-*size*, not page-*content*, so it's
stable in practice (pages in one document essentially always share dimensions) and never varies
based on detected content. `Anchor Left`/`Anchor Top` keep their existing gate — at least one must
be on for a crop to exist — but no longer influence split-mode positioning, for the same reason:
there is no per-page anchor point to nudge away from once the result is one shared template.

`Same size` OFF: every region simply gets its own union's size. `Same size` ON: every region grows
to the *largest* union size found across all N regions, each still anchored at its own union's own
top-left corner — a region that was already the largest is unaffected; smaller regions grow without
moving that corner.

A region with no detected content on ANY page (union is null — nothing survived the min-area/
border/FULL_PAGE_FRAC filters anywhere) falls back to that region's own raw slice, unresized —
the same "detection found nothing, don't fabricate a box" principle as whole-page detect.

Re-running Auto-detect at split > 1 refreshes already-committed split pages' `applied` entries to
the fresh `crop_rects`, same as §4.5 does for split = 1.

**Rotate/delete residual note.** A rotation reshuffles which grid cell is "top-left" and a delete
changes which pages exist; rather than rebuild each region's cross-page union against the new
layout (as §12 does for the single-crop union), rotate/delete simply discard the per-region detect
result and require a fresh Auto-detect press — simpler, and never silently wrong, at the cost of an
extra click.

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

This formula needs `B_p` (this page's own detected box) whenever an anchor is on. A page with no
`B_p` (§5) instead gets `W,H` centered on the page — `x0=(w−W)/2, y0=(h−H)/2` — with no anchor/offset
applied: there is no per-page point for `left_base`/`top_base` to be, or for an offset
to nudge away from.

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
deformed.

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
              Dewarp & Deskew ON ? ----------- no ----------------------------+
                           | yes                                              |
              classify (classic CV, §7.1a): warped, skewed-only, or flat?     |
                    |                  |                    |                 |
                 warped          skewed-only               flat              |
                    |                  |                    |                 |
      docuwarp/ONNX mesh unwarp   classic-CV rotate     no-op (page           |
        (deskew included)         by detected angle     already flat)         |
                    |                  |                    |                 |
                    +------------------+--------------------+-----------------+
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
lazily on view. Each page is processed at most once per distinct (page, rotation, dewarp, filter,
strength) combination, and — critically — walking through a long document costs the same as viewing
one page: each page owns its OWN small RAM-only version history (plain LRU, oldest dropped first —
no disk tier, no shared cross-page capacity to exhaust), capacity = the Undo/redo-depth setting + 1
(the current combination plus as many prior ones as Undo can still reach — no separate cache-size
number to keep in sync with it). Keyed by the full combination, not by page number alone, so
Undo/Redo re-hit an already-computed bitmap when it is still within that page's own reach instead of
recomputing, and never serve a stale bitmap for a different combination. A crop/split (§6) is
processing in the same sense — the shown and cached bitmap is the actual cropped/split pixels, never
a full-page bitmap plus a remembered crop rectangle — but its cache entry is cheap to rebuild from
the (separately cached) processed page, so Undo/Redo simply drop and re-derive it rather than needing
a version history of its own.

### 7.1 Dewarp & Deskew

A single toggle. Pressing it runs a per-page pipeline that decides, per selected page, which of
three things it needs:

```
                    source[i]
                        |
        warp classifier (§7.1a, classic CV, no ONNX/DBNet)
                 |                        |
              warped                  not warped
                 |                        |
   ONNX two-stage pipeline    text-line detection + vanishing-point
   (UVDoc, unchanged)         fit (§7.1b, DBNet + PROSAC/MSAC/IRLS)
                 |                        |
                 |          needs correction?  ---no---> no-op
                 |                        |
                 |                       yes
                 |                        |
                 |          one remap corrects skew (§7.1b)
                 +------------------------+
                            |
                          base (§7)
```

This exists because a page that has already been correctly dewarped elsewhere and only carries
incidental skew would otherwise be needlessly re-warped by the ONNX pass, which can introduce its
own small residual distortion on input that didn't need mesh correction. Execution providers for
the ONNX path are `['webgpu','wasm']`, gated on `navigator.gpu`, `numThreads=1` — no
`SharedArrayBuffer` dependency (GitHub Pages cannot set the COOP/COEP headers that would require).
The **Dewarp supersample** setting (§14, default 2.0) renders the page larger before the mesh remap
and downsamples after, trading time for less resampling blur — it has no effect on the not-warped
branch.

Whichever path a page takes runs against the page's own content, independent of its current display
rotation — rotating a page that already has Dewarp&Deskew applied never re-runs the classifier or
either correction path, only cheaply reorients the already-computed result. Only pressing the Dewarp
& Deskew button computes it; only Undo removes it.

There is no separate "just rotate" path for skew: §7.1b's vanishing-point-based rotation estimate is
just materially more precise than a hand-rolled row-profile search would be, since it's fit from many
individually detected text lines rather than one whole-page aggregate — see §7.1b. Automatic
trapezoid/keystone correction (beyond simple rotation) was investigated and abandoned as unreliable
on real content; see `docs/detrapezoid_research.md` (gitignored, local reference only).

### 7.1a Warp classifier (classic CV, no ONNX/DBNet)

Per selected page, against the raw `source[i]` raster (never the already-processed `work[i]`, same
rule as Auto-detect, §16.3):

1. **Rotation angle** — binarize a downscaled copy (`DESKEW_CLASSIFY_DOWNSCALE_PX` long edge, Otsu
   threshold) and search candidate rotation angles within `±DESKEW_MAX_DEG`, coarse-to-fine, picking
   the angle that maximizes the binarized row-sum profile's variance (the angle at which text lines
   align most sharply into rows). This is the same family of operation as the B/W filter's box-filter
   work (§7.2, §16) — cheap, no ONNX, no DBNet, no OpenCV mesh warp.
2. **Sharpness score** — from that same search, `best_row_variance / mean_ink_per_row²` at the winning
   angle. A page whose curl/fold cannot be fixed by any single rotation keeps a blurred row profile
   even at its best angle, so this stays low; a flat or purely-rotated page's profile becomes sharp
   at *some* angle, so this stays high. `WARP_SHARPNESS_MIN` (§17) is the cutoff.
3. **Branch**: `sharpness < WARP_SHARPNESS_MIN` → **warped** → the existing ONNX two-stage pipeline
   (unchanged). Otherwise → **not warped** → §7.1b.

Targets well under 100ms/page (§16) — this angle search's own result is not reused by §7.1b, which
estimates its own angle from a different, more precise source (detected text lines, not a single
whole-page row profile).

### 7.1b Skew correction (DBNet + vanishing point)

Runs only for a page the classifier (§7.1a) found not warped.

Automatic trapezoid/keystone correction (detecting and removing a page tilted about a horizontal or
vertical axis, not just simple rotation) was investigated at length — a second vanishing point from
character-stroke direction, a direct line-width-vs-position fit, and inter-character pitch were all
tried — and abandoned: none cleared the measurement-noise floor of DBNet's own per-region detection
precision on real scanned pages, across multiple real content types. See
`docs/detrapezoid_research.md` (gitignored, local reference only) for the full investigation. §7.1b
therefore corrects **rotation (skew) only** — via a single vanishing point, estimated more precisely
than §7.1a's own row-profile search because it's fit from many individually detected text lines, not
one whole-page aggregate.

1. **Text-line detection** — a lightweight scene-text detector (DBNet, PP-OCRv4 mobile, ONNX,
   Apache-2.0, ~4.7MB — same lazy-fetch-once + IndexedDB-cache pattern as the UVDoc dewarp models,
   §7.1) finds text regions as tilted quadrilaterals (not axis-aligned boxes) plus a per-region
   detection confidence. Only elongated, unambiguous quads are kept (`DBNET_MIN_WIDTH_PX`,
   `DBNET_MIN_ASPECT_RATIO`) — a near-square region (most often a short page-number box) has no
   well-defined long axis, and including it corrupts the fit with a spurious near-zero-angle
   reading. Each kept quad becomes one line segment (its long axis's two endpoints) with two
   weights: detection confidence (is this really text?) and a leverage weight, `width²` (how
   precisely can this region's angle even be measured? — a narrow region's contour is
   pixel-quantized enough that a small true tilt can round away to exactly zero before any fitting
   ever sees it; width alone, independent of confidence, determines how much that quantization
   matters). Both weights are required — confidence alone under-penalizes a narrow-but-confident
   detection, which was found (real skewed-page fixture) to cause the fit to overshoot; adding the
   leverage weight fixed it completely (residual dropped from -1.60° to +0.04° on that same page,
   verified).
2. **Vanishing-point estimation** — text lines that are truly parallel in the real document
   converge to a common vanishing point when extended. Estimated via:
   - **PROSAC**: line *pairs* are tried in order of decreasing combined confidence×leverage, not
     uniform-random order — a real, well-measured text line is more likely to give a good initial
     vanishing-point hypothesis than a random one.
   - **MSAC**: each candidate is scored by a bounded loss (`min(residual², threshold²)` summed,
     weighted), not a hard inlier count — smoother preference among close candidates.
   - **IRLS**: the winning candidate is refined by iterating confidence×leverage×Huber-residual
     reweighted least squares (via eigendecomposition of the weighted line-coefficient matrix) until
     convergence. The vanishing point itself is represented in homogeneous coordinates
     `(vx, vy, vz)` on the unit sphere.
3. **Reading the angle** — the implied local text-line angle is the direction from a point toward
   the vanishing point, evaluated at the *center of the observed text's own extent* — NOT the
   page's physical center — never extrapolated out to the page's physical edges: extrapolating past
   where any text actually was amplifies slope-estimation noise into a large false reading
   (verified: doing this produced a spurious multi-degree reading on a known-flat real page).
4. **Decision**: correct if `|center| > DESKEW_MIN_DEG` (§17); otherwise no-op. Also no-op if too
   few text lines were detected to fit a vanishing point at all (e.g. a near-blank page) — the safe
   default is to leave such a page alone, same as "flat".
5. **Correction** — a single rotation about the page's own center, anchored so that point stays
   fixed. The ideal rotation is split into `theta_coarse` (the nearest multiple of 90°) and a small
   residual. **Only the residual is ever applied** — Dewarp & Deskew never performs a coarse
   90°/180°/270° reorientation regardless of what the detected vanishing point implies; that stays
   `Rotate`'s job (§12), and this is true independent of the page's current display rotation,
   consistent with §7.1's "runs against the page's own content" invariant. A page whose real content
   happens to be rotated a multiple of 90° (e.g. fed sideways) keeps that orientation — only its
   fine skew, if any, is corrected.

Target: DBNet inference + vanishing-point fit + the rotation remap together, well under 1s/page
(§16) — this branch is only reached for pages that already avoided the ONNX path, so the budget
does not stack with it.

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
**original** page content via pdf-lib — no `render_output_image` call, no rasterization at all. This
is the **only** case that bypasses §10.1's one-raster-path rule — a NORMAL document exporting to
JPG/PNG/TIFF still uses `render_output_image` like everything else. Box coordinates convert from the
app's current (rotation-adjusted) display frame to the source page's own native frame first, since
the clip/embed operations below operate in that frame.

Two paths, chosen for output size, both batched per SOURCE DOCUMENT rather than
called once per page:

- **Unsplit (one crop window per page, the common case):** `copyPages()` + `setCropBox()` clones the
  page's own content stream/resources as-is (still compressed, nothing re-embedded) and narrows the
  visible area via CropBox, then `setRotation` — no Form-XObject conversion at all.
- **Split (N crop windows from one source page) or an image-sourced page:** a page can only carry
  one CropBox, so this still needs `embedPage`/`embedPng`/`embedJpg` — but the source page (or image)
  is embedded **once**, full, not once per box; each split window draws that single embed at a
  per-box offset (PDF/image pages clip to their own bounds, so nothing outside the window renders).

Both paths batch their pdf-lib work per source document: `copyPages()` is called once with every
page index needed from that document (not once per page), and `embedPage` is called once per source
page (not once per split box). pdf-lib does not automatically deduplicate a resource (a font, an
image) shared across pages when the same operation runs in separate calls — calling either one
per-page/per-box instead of batched measurably duplicated shared resources: ~19.5× on a real 190-page
book (one shared font embedded once per page) for the unsplit path, ~3.6× for a 4-way split (one
page's photo re-embedded once per box). Batching restores near-1:1 output sizing. Image-sourced
pages inside a mixed PDF+image NORMAL document embed losslessly (PNG/JPEG passthrough, no re-encode)
via the same coordinate math expressed as a draw offset; any other browser-decodable image format
re-encodes once as PNG.

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

### 10.6 Only a committed crop affects the exported file

On export each page's box is: the committed box if committed, else the whole page — never a live
auto crop or a drawn/manual window that hasn't been applied. Export never implicitly commits
anything; a crop frame that's merely visible on screen (previewed, not yet applied via Crop/Split &
Crop) exports as the full, uncropped page. This was previously inconsistent — the live auto-crop
case alone silently applied itself on export while a drawn/manual window or an unapplied split
never did — the fix is to make every uncommitted case behave like the drawn/manual/split ones
already did: nothing is exported that Crop didn't actually commit.

---

## 11. Progress overlay & batch model

Long operations (detect on scans, dewarp, filter, export) show a centred card on the canvas —
message, determinate bar, page counter, Cancel — not a separate window. A worker or the main-thread
event loop drives the batch page-by-page, yielding between pages so the overlay repaints and Cancel
is honored. A single-page job (`display_total === 1`) skips the overlay and runs synchronously.
Cancel sets a flag checked before each page and stops promptly with no partial file. While a batch
is busy, controls are disabled and further clicks are ignored (no command queueing). A per-page
exception surfaces as an error dialog (§19) and ends the batch cleanly.

`BatchJob.total` (the bar's step count) and `display_total` (the counter's page count) can differ:
an image export doubles `total` — render phase + encode phase — so the bar keeps moving instead of
stalling at 100% while the zip is encoded, but the counter always shows real progress against
`display_total`, never the doubled internal count.

---

## 12. History, reset, rotate, delete

`DocumentState`'s undo boundary is exactly 8 fields: `applied` (committed crop/split), `crop_rects`
(live split layout), `rotation`, `processed` (scan-processing intent), `offsets`, `dewarp_on`,
`filter_mode`, `filter_strength`. Auto-detect's results (the per-page detected-box cache, the union,
whether detection has run at all — plus, at split > 1, the per-region equivalents, §5a) and the
in-progress hand-drawn window are **non-undoable** `AppModel` fields, not `DocumentState` fields —
they are scaffolding used to *arrive* at a committed operation, not an operation themselves.
Concretely: pressing Undo immediately after Auto-detect, before anything is committed via Crop, is
a no-op; finishing a rubber-band draw (§6.4) does not push a checkpoint either — only **Crop**
(`apply_crop()`) does. Undo continues to fully revert
`applied`/`rotation`/`offsets`/(SCANNED-mode) `processed`/`dewarp_on`/`filter_mode`/`filter_strength`
— `crop_rects` too, since Auto-detect at split > 1 writes it directly (§5a), same as a split drag.
Rotate/delete rebuild the split=1 union against the new page layout (below) but simply discard the
split>1 per-region result instead (§5a's residual note) — the next Auto-detect press rebuilds it.

- **Undo/Redo** — a bounded stack of `DocumentState` snapshots, depth from the Undo/redo-depth
  setting (preset dropdown, `UNDO_DEPTH_OPTIONS = [1,2,4,8]`, default 2). A snapshot is taken before
  every undoable mutation (Crop, offset commit, a completed drag resize, rotate) — see above for what
  is deliberately excluded. Restoring a snapshot drops only the cheap crop/split output preview (§7);
  the source and processed-page raster caches are content-addressed by (page, rotation, dewarp,
  filter, strength) — except the Dewarp&Deskew result itself, addressed by page only, deliberately
  not rotation (§7.1) — and are left alone, since a reverted combination naturally resolves to its
  own cache entry — a hit if still resident, one clean recompute if it was evicted. Neither cache is
  ever wiped wholesale by Undo/Redo (§7).
- **Reset** — reloads the same input files (or the synthetic placeholder) and re-combines them,
  clearing all crops, rotation, detection, processing and history; returns Split to 1 and clears
  filter/dewarp highlights.
- **Rotate** — a per-page rotation-angle map (0/90/180/270° CW). Adds 90°; rotation is part of the
  source/filter cache key (§7), so the new angle simply resolves to a different cache entry
  (re-rendered once, then cached) without needing to evict the old angle's entry — except a
  Dewarp&Deskew result already computed for the page, which is never re-run: rotate only reorients
  it (a cheap bitmap rotation, §7.1), never re-invokes the ONNX pass. Rotate also drops that
  page's crop/split output preview, since the committed crop and the cached detected box are
  carried through by rotating their coordinates 90° CW, so cropping survives a rotate. Offsets reset
  to default; the detection union is rebuilt (with the same `FULL_PAGE_FRAC` exclusion §5 applies at
  detect time — never a raw re-aggregate that would readmit an excluded fallback box). With split 2/4
  active, the windows reset to a fresh even grid sized for the rotated page (any prior manual window
  positioning was sized for the pre-rotation page and is discarded, same as first turning split on).
  Fully undoable.
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
  Ignore N outlier pages   [ 2   v ]           preset dropdown, [0,1,2,5,10], default 2 (auto-crop sizing, §5)
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
per section, clicking scrolls the body to it), then the section blocks in order: the numbered
workflow steps, Undo/Settings/Keyboard shortcuts, an About block (app name, purpose), and finally
Contacts (support email addresses). Content must describe actual current behavior — see §16 for the
review pass that keeps it accurate.

---

## 15. File I/O

**Load:** a file picker (`<input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff">`) or
drag-and-drop onto the canvas. Combine order and mode classification follow §9.

**Export:** PDF triggers a browser download directly (vector for NORMAL, raster-embedded for
SCANNED, §10.3). JPG/PNG/TIFF download as one `.zip` (§10.5). There is no overwrite-confirmation
control — a browser download cannot detect or block an overwrite, so no such setting is offered.

**Icons & installability:** a full icon set (favicon SVG/ICO/PNG, apple-touch-icon, 192/512
maskable PWA icons) and a web app manifest (`public/site.webmanifest`) make the app installable
as a standalone PWA. Manifest icon paths are relative (not root-absolute) so they resolve
correctly under a GitHub Pages project-page subpath, where the manifest itself doesn't live at
the domain root — Vite does not rewrite `public/` file contents the way it rewrites `index.html`'s
own `%BASE_URL%`-prefixed links, so a root-absolute manifest icon path would silently 404 under a
subpath deploy.

**Offline:** a hand-rolled service worker (`public/sw.js`, registered only in production builds —
never in dev, to avoid intercepting Vite's HMR with stale cached responses) caches every
same-origin GET response opportunistically as the running app requests it: cache-first on repeat
requests, falling back to network and populating the cache on a miss. There is no static
build-time precache manifest (the JS/CSS bundle's filenames are content-hashed per build); instead,
a normal boot plus one scanned-mode run naturally pulls the app shell, OpenCV wasm, ONNX models,
pdf.js worker/cmaps/fonts and icons through the cache at least once, which is what "the app works
offline after one online load" requires. No `SharedArrayBuffer`/COOP-COEP dependency.

Settings → **"Enable offline mode"** — off by default. The passive caching above only covers
whatever a session actually used, so a user who has only used NORMAL mode online would find
SCANNED-mode dewarp/filters failing offline despite the app otherwise working offline. Turning the
switch on runs the real OpenCV/ONNX/DBNet init paths once (the same ones SCANNED mode itself uses,
including §7.1b's text-line detector, not just UVDoc), so their downloads populate the cache
immediately — every feature works offline right after, not just whichever were already used. No
install/PWA-add-to-homescreen step is required either way.

---

## 16. Performance targets

| Operation | Target |
|---|---|
| Canvas repaint (non-imaging) | < 16ms (60fps during drag) |
| Page navigation | < 100ms (RAM cache hit: immediate draw; RAM-miss recomputes once — no disk tier, §7) |
| Orchestration overhead (dispatch → cache lookup → batch loop), excluding the mocked adapter's own compute | Dewarp&Deskew < 0.5s, filter apply < 0.3s, over a multi-page selection — regression tests at the AppModel level with an instant-return mock adapter (tests/core/scan_orchestration_speed.test.ts), isolating pipeline/cache overhead from real OpenCV/ONNX cost (which is covered separately above and in tests/perf/scan_speed.test.ts) |
| B/W or Sharpen filter per page | < 500ms (SIMD WASM opencv.js + downscaled illumination-flatten morphology) |
| Auto-detect per page | < 100ms (SCANNED: raw source, not the processed work image; NORMAL: text-layer, no raster at all) |
| Dewarp per page (ONNX stage) | seconds on the 1-thread WASM execution provider; fast on WebGPU where available |
| Warp classifier per page (§7.1a, classic CV) | < 100ms — flag and investigate if exceeded |
| Skew correction per page (§7.1b, DBNet + vanishing point) | < 1s — flag and investigate if exceeded; only reached on pages that already skipped the ONNX path |
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
SRC_DPI = 150.0    NORMAL_DPI = 150.0    NORMAL_DISPLAY_DPI_MAX = 450.0
# raster cache capacity = Undo/redo-depth setting + 1, per page (§7) — not a separate constant
# crop geometry
HANDLE_R = 10    HANDLE_SLACK = 6    CANVAS_MARGIN = 0    OFFSET_LIMIT = 100.0    MIN_RECT = 5.0 (geometry.ts)
# classification / detection
MODE_TEXT_MIN = 8    DETECT_MAX_PX = 1400    BORDER_FRAC = 0.02
MIN_COMP_FRAC = 2.5e-4    FULL_PAGE_FRAC = 0.97    DESKEW_MAX_DEG = 15.0
# warp classifier (§7.1a) — DESKEW_MAX_DEG above is the search RANGE, not a decision cutoff
WARP_SHARPNESS_MIN = 1.0    DESKEW_CLASSIFY_DOWNSCALE_PX = 400
# skew correction (§7.1b) — decision cutoff, calibrated against real-content noise floor (a
# known-flat real page reads ~0.2-0.3deg center on this estimator, so this sits clearly above
# that, not at the originally-hoped-for 0.2deg — see PROGRESS.md)
DESKEW_MIN_DEG = 0.5
# DBNet (PP-OCRv4 mobile det, ONNX, Apache-2.0) text-line detection for §7.1b
DBNET_MODEL_URL = 'models/ch_PP-OCRv4_det.onnx'    DBNET_MODEL_CACHE_KEY = 'dbnet-ppocrv4-det-v1'
DBNET_MAX_SIDE_PX = 1920    DBNET_PROB_THRESH = 0.3    DBNET_UNCLIP_RATIO = 1.6
DBNET_MIN_AREA_PX = 20    DBNET_MIN_WIDTH_PX = 30    DBNET_MIN_ASPECT_RATIO = 3.0
# vanishing-point estimation (§7.1b) — PROSAC/MSAC/IRLS
VP_INLIER_THRESH = 0.02    VP_HUBER_DELTA = 0.02    VP_IRLS_ITERS = 8    VP_MAX_PAIRS = 400
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
DEFAULT_DETECT_OUTLIER = 2    DETECT_OUTLIER_OPTIONS = [0,1,2,5,10]
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
a themed modal dialog (`AppController.alert`, `ui/confirm.ts::alert_dialog` — same shell as the
yes/no confirm dialog, single OK button), never a silent failure and never an auto-dismissing toast.

- No document loaded → actions are no-ops; nav shows `/ 0`.
- Empty Pages selection → the relevant action throws `EmptySelectionError`, surfaced as a dialog; no
  partial mutation.
- A drag collapsing a rectangle clamps to `MIN_RECT`, never inverts.
- A crop rectangle is always clamped to the page; degenerate results are skipped.
- A failed dewarp/filter/export on one page in a batch ends the batch with an error dialog; the
  document is left in its pre-batch state for that page (no partial commit).
- Deleting every page in the Pages selection is checked before the confirm dialog even opens: an
  info dialog ("Cannot delete all pages.") replaces it, since that action was never going to
  succeed — no confirm-then-error two-step, no `DeleteAllPagesError` reaching the UI in the normal
  flow (the model-level guard stays as a defensive invariant regardless).

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
| `Delete` | Delete the Pages selection (same confirm as the Delete button) |
| `Esc` / right-click during a drag | Cancel drag |
| `Esc` (not during a drag) | Drops the current live crop window (§6.3) |

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
9. Resident raster memory per page stays bounded regardless of how many other pages have been
   visited (each page's own RAM LRU, capacity = Undo/redo-depth + 1, no disk tier; export streams).
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
21. Dewarp & Deskew's per-page pipeline (§7.1a/§7.1b) is deterministic and content-only: the same
    `source[i]` always classifies the same way and takes the same path (ONNX / skew correction /
    no-op), independent of page order, selection size, or prior Undo/Redo state.
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
    failure surfaces as an error dialog.
26. A new live crop box (Auto-detect or a fresh draw) drops the previously active box and resets all
    four offsets to 0 before the new box appears.
27. Navigating away before a page's bitmap fetch resolves never lets that late resolution become
    the shown bitmap — it is paired against whichever page is actually current when it lands, and a
    different rotation swaps width/height, so a stale bitmap there would show as a distorted page
    for a moment. Only the fetch for the still-current page commits.
