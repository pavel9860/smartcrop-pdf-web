# SmartCrop PDF Web — Specification Supplement

This document supplements `docs/SmartCrop_PDF_Specification.md` (the canonical, platform-agnostic
behavioral contract — §1–§22, copied verbatim from the desktop repo, unchanged for the web, and
FROZEN — never edit that file). It does not restate that contract. It records only: **§W1** how
the two documents relate, **§W2** every point where the web platform forces a real behavioral
difference from the desktop spec — written as current fact, verified against the running
toolchain, not aspiration — and **§W3–§W7** behavior the desktop has no equivalent of at all
(browser-native layout, file I/O, shortcuts).

`ARCHITECTURE.md` is the third document in this set: it explains *how* the behavior described here
and in the desktop spec is implemented in TypeScript (module layout, dependency graph, worker
model, build/deploy). Behavior lives in the two spec documents; mechanism lives in
`ARCHITECTURE.md`. Where a fact could belong to either, ask: "does the user experience this?" —
if yes, spec; if no, architecture. `docs/app_design_screenshots/` is a fourth reference, UI-only:
it is the ground truth for exact desktop layout/icon/control fidelity that §W3 describes in
prose — when the two disagree on a visual detail, the screenshots win.

---

## W1. Scope & relationship to the desktop spec

Desktop spec sections apply to the web port **verbatim** except where §W2 below says otherwise:
purpose & scope (§1), modes & classification (§4), coordinate system & canvas fit (§5), auto-detect
algorithm (§8), the crop-window drag state machine (§9, including keep-ratio §9.7), the scan
processing pipeline (§10), pages selection (§11), apply/export/compress rules (§12), history/reset/
rotate/delete (§13), the progress-overlay/batch behavioral contract (§14 — *what* the user sees;
the Tk `after`-tick mechanism itself does not apply, see §W2 row 5), constants (§18 — same values,
ported to `src/core/constants.ts`), error-handling behavior (§20), and every acceptance invariant
in §22 except where §W2 documents a gap. `ARCHITECTURE.md` §20 maps each §22 invariant to the test
file that exercises it in this repo.

Window layout (desktop spec §6), Settings window layout (§15), Help window layout (§16),
typography/theme (§19) and shortcuts (§21) describe **desktop widget arrangements** (Tk panes,
dialog windows) that have no browser equivalent. §W3–§W6 below are this document's own account of
the same *behavior* (what panels exist, what they contain, what open/closes them, what the palette
and shortcut set are) adapted to a web page — not a re-derivation of new behavior. For exact visual
fidelity (icon set, control grouping, spacing, color of specific controls), `docs/app_design_screenshots/`
is authoritative over this section's prose.

---

## W2. Known behavioral deviations from the desktop spec

Real, user-visible gaps as of this document's last update (2026-07-03) — verified against the
actual running toolchain this update, not documentation staleness.

| # | Area (desktop spec) | Desktop behavior | Web behavior today | Architecture reference |
|---|---|---|---|---|
| 1 | Dewarp & Deskew (§10.1) | Removes page curl/fold and skew via the docuwarp/ONNX mesh unwarp | **Implemented, not a no-op.** Full two-stage ONNX pipeline (UVDoc warp-field model + bilinear resample), wired button→AppModel→ensure_onnx→apply_dewarp. Verified this update against the actual model files: io names/dims/dtypes match the code, output raster is non-identity (maxAbs diff 0.95, mean 0.29 vs input) [high]. Execution providers are `['webgpu','wasm']`, gated on `navigator.gpu`, `numThreads=1` — no SharedArrayBuffer/COOP-COEP dependency, required for GitHub Pages. In-browser (real GPU) execution and end-to-end visual correctness on an actual scanned page are **not yet confirmed** — verified only headlessly against raw model tensors. The Playwright suite now exists (2026-07-03) but the update sandbox had no GPU, so only the wasm EP ran in-browser; WebGPU-on-real-GPU still needs confirmation on a GPU host (or the GH Pages deploy). | ARCHITECTURE §9 |
| 2 | Export formats (§12.7) | PDF / JPG / PNG / TIFF | **Fixed (2026-07-03).** All four formats offered. TIFF is hand-encoded in `workers/tiff.ts` — baseline, uncompressed, 8-bit RGB, single strip, little-endian (canvas has no `image/tiff` path); alpha is dropped since output pages are opaque flattened rasters. Unit-tested (`tests/core/tiff.test.ts`: header/IFD validity, pixel order, strip size). Image exports (JPG/PNG/TIFF) now deliver a **single `.zip`** (see §W6), not N loose files. | ARCHITECTURE §1 |
| 3 | Multi-file PDF documents (§7.1a) | Several PDFs combine into one working document, pages in selection order | **Fixed (2026-07-03).** `pdf/loader.ts` holds `_pdfs[]` plus a per-output-page `_pages[]` `PageSource` map; each output index maps to its own PDF proxy + 1-based page number. Multi-PDF load combines all pages in selection order. Unit-tested (`tests/pdf/loader.test.ts`). | ARCHITECTURE §8 |
| 4 | Mixed PDF + image documents (§7.1a) | PDFs and images combine freely into one document | **Fixed (2026-07-03).** Same `_pages[]` `PageSource` map: image pages carry a `{kind:'image', blob}` source decoded on demand, so a mixed PDF+image load renders every index. Unit-tested. | ARCHITECTURE §8 |
| 5 | Batch responsiveness (§14, §17: ~150 ms/page target) | Long operations run off the interaction path via the Tk `after`-tick loop; the window stays responsive between pages | Detect / filter / dewarp run on the **main (UI) thread** — the tab can visibly pause for the duration of each page's processing (still bounded per-page, §W5) rather than staying responsive between pages. | ARCHITECTURE §7a |
| 6 | `confirm_overwrite` setting (§15) | Warns before silently replacing an existing file on export | **Stored but not enforced.** No overwrite-detection path exists yet; the setting is inert. | §W6 below — no File System Access API overwrite check wired up |
| 7 | Binarization DPI scaling (§10.2) | Sauvola window / background-kernel / min-area scale with the page's embedded DPI | Fixed kernel sizes — the web's scanned-mode source DPI (`SRC_DPI`) is a constant 200, unlike desktop's variable source DPI, so this mainly affects the B/W filter's kernel size relative to desktop's 150-DPI reference case, not correctness. | ARCHITECTURE §9 — low-severity fidelity residual |

Everything else in the desktop spec — classification (§4), coordinate system/canvas fit (§5), the
full crop-window state machine (§9) including keep-ratio (§9.7) and cancel-drag (§9.3/§9.6),
auto-detect (§8), the B/W and Sharpen filters (§10.2), pages selection (§11), apply/export/compress
(§12), history/reset/rotate/delete (§13), and the error taxonomy (§20) — is implemented and passes
the unit-test gate (279/279 as of 2026-07-03, up from 151 — now includes tests/ui/ jsdom coverage
for every panel/view and additional core edge tests). A Playwright end-to-end suite now exists
(`tests/e2e/`: smoke + crop_split, 6/6 green on chromium) and exercises the synthetic-doc boot,
three-column layout, split/crop output-page math, and Settings-panel open/Esc-close in a real
browser. Confidence [high] for unit-level correctness and for the chromium e2e paths; [med] for
(a) Firefox (the e2e project exists but was not runnable in the update sandbox — missing OS libs)
and (b) in-app WebGPU dewarp on a real GPU (the sandbox has no GPU; only the wasm EP was exercised
in-browser). See TODO.txt items 8 and 15.

---

## W3. Layout & panel behavior

The desktop's two-pane, sash-split window with floating Settings/Help dialogs (spec §6, §15, §16)
has no browser equivalent — there is no OS-level draggable sash or native dialog window in this
context. The web port instead uses a fixed **three-column layout**:

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

**Left sidebar** — fixed width, scrollable. Same card order and content as desktop spec §6's card
stack (Document & State → Pages to Process → Scan Processing, scanned-only, no residual gap when
hidden → Split Each Page Into → Detect Text Borders → Advanced, collapsed by default → Actions →
Output Quality → Export), renamed "Compress Document" to "Output Quality" and split into two cards
(Output Quality + Export) matching the desktop's actual code (`ui/panels.py`'s `_build_compress`/
`_build_export` split) rather than the spec prose's single "Compress Document" card title, which is
stale relative to the desktop app itself. Pinned bottom bar, outside scroll: Settings + Help
buttons, then Undo/Redo/Reset, then page nav — same content and order as desktop spec §7.8.
The loaded document name sits in **its own card at the very top** of the sidebar (above Document &
State), same card frame as Advanced and the Load-button label font — single file → its name, several
→ "first.pdf +N more", card hidden entirely when nothing is loaded (`AppModel.document_name`).
The canvas carries a **bottom-left status bar** (`ViewSnapshot.status`: page index + page size) as a
DOM overlay, mirroring desktop §3.3, alongside the existing bottom-right cursor read-out; neither is
painted on the page raster (desktop inv 32). Settings → Appearance → Font size is a **preset
dropdown** (8, 10, 12, 15, 18, 22, 25 pt). Navigation **prefetches the adjacent pages'** work rasters
in the background after each view prepares, so next/prev is a cache hit rather than a blank
"Loading…" flash while a scanned-mode filter render runs on demand.
Exact icon set, control widths, switch/field styling, and per-control coloring (e.g. Delete must
NOT be styled differently from other action buttons — see TODO.txt item 4) must match
`docs/app_design_screenshots/`, which supersedes this section's prose wherever more specific.

**Detail panel** replaces the desktop's floating Settings/Help windows (§15, §16): a panel between
the sidebar and canvas, collapsed (width 0) by default. Clicking Settings or Help opens it showing
that content and shrinks the canvas to fill the remaining space (never below 400px). Pressing the
same button again, or **Esc**, closes it. Pressing the other button swaps content without a
close/reopen animation. No modal, no overlay dimming — it is part of the normal page flow.

**Status text** — coordinates and page number are drawn on the page image itself at top-left with a
shadow/backdrop, exactly as desktop spec §19 describes ("Status text is drawn on the page image at
top-left with a shadow for readability"), not in a separate strip. Mouse coordinates update on
pointer move; the page counter updates on navigation.

---

## W4. Keyboard shortcuts (web-mapped subset of desktop spec §21)

| Shortcut | Action | Desktop spec §21 equivalent |
|---|---|---|
| `Ctrl+O` | Load Files | same |
| `Ctrl+Enter` | Apply Crop | same |
| `Ctrl+S` | Export (current format) | same |
| `Ctrl+Z` | Undo | same |
| `Ctrl+Y` | Redo | same (desktop: `Ctrl+Y`) |
| `ArrowLeft` / `ArrowRight`, `PageUp` / `PageDown`, mouse wheel over canvas | Prev / Next page | same |
| `Ctrl +` / `Ctrl -` / `Ctrl 0` | Zoom UI / reset | same (CSS `font-size` scaling instead of Tk widget scaling). Settings → Appearance → "Zoom (UI scale)" is a **preset dropdown** (70–200%, desktop `scale_presets`) that sets the scale directly via `set_ui_scale`; the keyboard steps and the dropdown share the one `ui_scale` state. |
| `Enter` in page box | Jump to page | same |
| `Esc` / right-click during drag | Cancel drag; `Esc` also closes the detail panel (§W3, no desktop equivalent — no floating window to close) | same for drag-cancel |

---

## W5. Performance targets (web-appropriate restatement of desktop spec §17)

Desktop spec §17's ~150 ms/page target and LRU memory bound apply unchanged (§18's `CACHE_WINDOW`
constant is identical). Web-specific budgets, given the browser execution environment:

| Operation | Target |
|---|---|
| Canvas repaint (non-imaging) | < 16 ms (60 fps during drag) |
| Page navigation | < 100 ms (LRU cache hit: immediate bitmap draw) |
| Filter/dewarp per page | < 200 ms (OpenCV.js WASM; desktop target ~150 ms/page, §17 — WASM is competitive but not identical) |
| Export per page | < 300 ms (JPEG encode + pdf-lib embedding) |
| First OpenCV.js WASM load | < 3 s, once per session (8 MB, lazy — scanned-mode documents only) |
| First ONNX model fetch + init | < 5 s, once per session (cached in IndexedDB after; 0 ms on repeat sessions). Dewarp is implemented (§W2 row 1) — this budget is now reachable in practice, pending in-browser timing confirmation via Playwright. |

---

## W6. File I/O behavior (browser-native equivalent of desktop spec §7.1/§12.5)

**Load:** a file picker (`<input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff">`)
or drag-and-drop onto the canvas/window. Combine order, per-file page contribution, and mode
classification follow desktop spec §7.1a unchanged — **except see §W2 rows 3–4: multi-file and
mixed-type combination is currently broken**, not yet a working equivalent of the desktop
behavior this row describes.

**Export:**
- PDF (single file): triggers a browser download directly.
- JPG/PNG/TIFF (§12.7): every output page is encoded in `export.worker.ts` and packed into **one
  `.zip`** via `fflate` (`zipSync`), named `<base>.zip`; entries are `<base>_NNN.<ext>` (1-based,
  3-digit). This is now the sole image-export path on **all** browsers — the desktop's N-loose-files
  behavior is deliberately not reproduced (browsers cannot write a chosen folder without a
  per-file save prompt; a single archive is the web-correct equivalent). Deflate level 0 for
  JPG/PNG (already compressed), 1 for TIFF (fast deflate — level 6 made the final `zipSync` a long
  progress-less freeze). `fflate` is a declared, installed dependency [high]. The export progress
  bar spans **both** phases: render advances the first half, per-page encode the second (job total
  = `view_total × 2` for image formats), so it no longer completes then hangs during encoding.
  Export also **yields to the event loop between pages** (`render_output_image` runs on the main
  thread), so the progress bar actually animates instead of the tab freezing for the whole run
  (bug: PDF export stalled ~20 s with a static bar before the download appeared).
- **Overwrite confirmation** (desktop spec §15's `confirm_overwrite` setting) is not yet enforced
  on the web — see §W2 row 6. The setting exists in Settings but has no effect today.

---

## W7. What does not change

Everything in desktop spec §4–§22 not listed in §W2's deviation table: the crop-never-dropped
invariant (§9.5, §12.4), the one-render-path WYSIWYG guarantee (§12.1), the LRU memory bound (§17),
the keep-ratio lock enforced at the final normalisation step (§9.7), the batch fail-fast/cancel
behavior (§14), the error taxonomy and dispatch contract (§20), the card layout and control order
(§6, adapted per §W3), and every acceptance invariant in §22 except where §W2 documents a gap.
