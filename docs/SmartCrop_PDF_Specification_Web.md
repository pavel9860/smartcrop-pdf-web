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

Real, user-visible gaps as of this document's last update (2026-07-10) — each row re-verified
against the actual running code this update (file:line, not documentation staleness); the
individual "Fixed/Deliberate deviation (date)" tags below record when each behavior itself last
changed, which predates this verification pass.

| # | Area (desktop spec) | Desktop behavior | Web behavior today | Architecture reference |
|---|---|---|---|---|
| 1 | Dewarp & Deskew (§10.1) | Removes page curl/fold and skew via the docuwarp/ONNX mesh unwarp | **Implemented, not a no-op.** Full two-stage ONNX pipeline (UVDoc warp-field model + bilinear resample), wired button→AppModel→ensure_onnx→apply_dewarp. Verified this update against the actual model files: io names/dims/dtypes match the code, output raster is non-identity (maxAbs diff 0.95, mean 0.29 vs input) [high]. Execution providers are `['webgpu','wasm']`, gated on `navigator.gpu`, `numThreads=1` — no SharedArrayBuffer/COOP-COEP dependency, required for GitHub Pages. In-browser (real GPU) execution and end-to-end visual correctness on an actual scanned page are **not yet confirmed** — verified only headlessly against raw model tensors. The Playwright suite now exists (2026-07-03) but the update sandbox had no GPU, so only the wasm EP ran in-browser; WebGPU-on-real-GPU still needs confirmation on a GPU host (or the GH Pages deploy). | ARCHITECTURE §9 |
| 2 | Export formats (§12.7) | PDF / JPG / PNG / TIFF | **Fixed (2026-07-03).** All four formats offered. TIFF is hand-encoded in `workers/tiff.ts` — baseline, uncompressed, 8-bit RGB, single strip, little-endian (canvas has no `image/tiff` path); alpha is dropped since output pages are opaque flattened rasters. Unit-tested (`tests/core/tiff.test.ts`: header/IFD validity, pixel order, strip size). Image exports (JPG/PNG/TIFF) now deliver a **single `.zip`** (see §W6), not N loose files. | ARCHITECTURE §1 |
| 3 | Multi-file PDF documents (§7.1a) | Several PDFs combine into one working document, pages in selection order | **Fixed (2026-07-03).** `pdf/loader.ts` holds `_pdfs[]` plus a per-output-page `_pages[]` `PageSource` map; each output index maps to its own PDF proxy + 1-based page number. Multi-PDF load combines all pages in selection order. Unit-tested (`tests/pdf/loader.test.ts`). | ARCHITECTURE §8 |
| 4 | Mixed PDF + image documents (§7.1a) | PDFs and images combine freely into one document | **Fixed (2026-07-03).** Same `_pages[]` `PageSource` map: image pages carry a `{kind:'image', blob}` source decoded on demand, so a mixed PDF+image load renders every index. Unit-tested. | ARCHITECTURE §8 |
| 5 | Batch responsiveness (§14, §17: ~150 ms/page target) | Long operations run off the interaction path via the Tk `after`-tick loop; the window stays responsive between pages | Detect / filter / dewarp run on the **main (UI) thread** — each page's processing blocks for its compute time (now well under budget, §W5); the app yields to the event loop **between** pages so the §14 progress overlay repaints and Cancel works. **Scan toggles are eager:** Dewarp/B-W/Sharpen/strength flip their intent instantly (undoable), then return a **BatchJob** that streams the Pages selection through the pipeline once under the §14 overlay (cancellable; a cancel keeps the intent — remaining pages compute lazily on view). **Pipeline architecture rebuilt (2026-07-10, task T4)** to hit the per-page budgets — the earlier design was ~10–20× too slow, and profiling (not the SIMD width) found the causes: **(a)** the illumination-flatten 51×51 morphology dominated everything (§W2 row 12 — fixed by the downscale trick, ~36×); **(b) double rasterization** — the model rendered each page once for `get_source_image` then `get_work_image` re-rendered the PDF a *second* time internally; the adapter now takes the already-rendered source bitmap (`get_work_image(source, …)`), so each page is rasterized exactly once; **(c) Auto-detect over-processing** — detection ran the *full* dewarp+filter work pipeline per page and then threw most of it away by downscaling to `DETECT_MAX_PX`; detection now runs on the **raw source raster** (matching desktop, which detects the content box on the raw scan's cleaned bilevel), so it never pays for dewarp/filter (dewarp's small geometric shift is not reflected in the detected bounds — an accepted fidelity tradeoff); **(d)** a **two-tier, write-back work-raster cache** — a small RAM LRU for the current viewing window plus an **IndexedDB** disk tier (`pdf/work_store.ts`, PNG blobs keyed by document-generation + page + processing-intent). It is **write-back**: a raster is persisted to disk **only when it is genuinely evicted from the RAM LRU** (capacity exceeded), never eagerly on compute — eager persist fired N concurrent PNG-encode+IDB-write jobs per pass that piled up (hundreds of ms each) and contended with the next page's OpenCV work. The disk is **read only for a key that was actually persisted** (an in-memory persisted-key set), so a document that fits in RAM (≤ `CACHE_WINDOW` pages) does **zero** IndexedDB I/O on the hot path — the disk tier only engages for long documents, exactly where a page can be evicted and later revisited. A page is thus processed **at most once per settings-generation**: revisiting an evicted page reloads its raster from disk instead of re-running OpenCV/ONNX. Per-page profiling (real browser) breaks the cost down as: PDF render ~30 ms (image-based scans; pdf.js decodes the embedded raster — **not** the 300–600 ms sometimes assumed), OpenCV ~120 ms at the desktop-asset size (1240×1755, 2.18 MP) / ~210 ms at 1653×2339 (3.87 MP), disk-read ~0 (skipped for never-persisted pages). Steady-state e2e ≈ **~150 ms/page** at the desktop-asset size (meets a 0.2 s/page target); larger pages scale with pixel count. First page of a session adds a one-time ~260 ms OpenCV WASM init. Replaces the earlier lazy-only design (16c1b6d) that deferred ALL processing to view/detect time with no progress UI ("dead slow autodetect / navigation"). | ARCHITECTURE §7a, §9 |
| 6 | `confirm_overwrite` setting (§15) | Warns before silently replacing an existing file on export | **Control removed (2026-07-04).** The web export path streams a browser download and cannot detect or block an overwrite (no File System Access write), so the setting was inert; the Settings checkbox is removed rather than shown with no effect. | §W6 below |
| 7 | Binarization DPI scaling (§10.2) | Sauvola window / background-kernel / min-area scale with the page's embedded DPI | Fixed kernel sizes — the web's scanned-mode source DPI (`SRC_DPI`) is a constant 200, unlike desktop's variable source DPI, so this mainly affects the B/W filter's kernel size relative to desktop's 150-DPI reference case, not correctness. | ARCHITECTURE §9 — low-severity fidelity residual |
| 8 | Output quality → preview (§12.1 WYSIWYG) | Preview is the exact output raster (WYSIWYG) | **Deliberate deviation (2026-07-04).** Compress DPI and output colour (Grayscale) apply to the **exported file only**, never the on-screen preview. Rendering the committed-crop preview at the export DPI made a crop appear at e.g. 75 dpi (395×505) and in grayscale; the editing view must stay full-resolution and true-colour. `render_output_image` remains the single render path — WYSIWYG is preserved for crop geometry, filters and rotation; only the DPI/colour arguments differ (preview: `null`/`false`; export: preset/colour). Set by `_prerender_output_views` (preview) vs `_render_export_pages` (export). **Output pixel size (2026-07-05):** the exported raster is sized as **output DPI × paper size** — each output page's long side `m = max(w,h)` is assumed to be the paper height, so the long side becomes `L = dpi × paper_height_in` pixels (A4 = 11.69 in → 300 dpi → 3507 px) and the short side scales by the crop's own aspect (no distortion, no padding). 'Original resolution' keeps the source raster size. Paper size is a Settings → Output dropdown (`PAPER_SIZES`: A2, A3, A4, A5, A6 — default A4), plus a **Custom…** entry (2026-07-10) backed by a numeric paper-height-in-inches field (`settings.custom_paper_in`, default 11.69, clamped `CUSTOM_PAPER_MIN`–`CUSTOM_PAPER_MAX` = 1–60) that reveals **exactly like the Custom DPI field** below — hidden by default (the `hidden` attribute on the field's markup itself, not just set by the first `refresh()` call) and shown only once `paper_size === 'Custom'`, via the same shared `syncCustomReveal()` helper (`ui/dom.ts`), not a second copy of the reveal logic. Custom DPI is editable in **both** the sidebar Output Quality card and Settings → Output — one shared state (`settings.custom_dpi`); editing the Settings field switches the preset to Custom. | ARCHITECTURE §1 |
| 9 | Keep-ratio during drags (§9.7) | Ratio snaps on RELEASE, anchored top-left; split rectangles snap on release | **Deliberate web deviation (2026-07-04).** Keep-ratio holds **live** throughout every resize (no deform-then-jump), including 2/4-split rectangles, and a resize is anchored on the corner/edge **opposite** the dragged handle — edge drags grow the perpendicular axis symmetrically about the box centre — so only the dragged side moves, never the whole window. Frozen §9.7 specifies on-release/top-left; this is a usability fix (extends the already-live drawn-window behavior to splits and corrects the anchor). `keep_ratio_anchored()` in `geometry.ts`, applied live in `_update_split_drag`/`_update_drawn_drag`; static sources (live auto crop, fresh-draw release) keep the top-left `keep_ratio_normalise`. **Wall clamp fixed (2026-07-10):** every anchor case now follows frozen §9.7's letter — "a ratio-constrained edge that would leave the page is clamped to the page and the opposite dimension follows" — the ratio-derived edge (e.g. `y1` for a `BR` drag) clamps to the page and the OTHER dimension re-derives from the clamped one, anchor corner unchanged, ratio held exactly; previously the final `clamp_box_drag` call clamped that edge without touching the other dimension, silently deforming the ratio (a 2-split window over 50% page width lost its lock). **Ratio pre-populate source changed (2026-07-10):** enabling keep-ratio (or changing the split count while it is already ON) re-derives the ratio from whatever crop shape is **currently on screen** — `crop_rects[0]` at split 2/4, the hand-drawn window at split 1 — falling back to the detection union then the page aspect only when no such shape exists yet, so a manual resize made *before* the toggle is honoured instead of silently overwritten by a page-derived formula (bug #4). Changing the split count always re-derives fresh from the newly-reseeded grid; it does **not** try to carry a previous ratio (typed or derived) forward proportionally — by explicit user decision, "drop the previous ratio if the split changes" — so split 1→2 with keep-ratio already on lands on exactly half the prior page-aspect ratio only as a side effect of the new grid's cell shape, not a deliberate ×0.5 rule (bug #3). Replaces the former split-count-keyed formula (`cell_h = split===4 ? h/2 : h`) with one shared `_default_ratio()` source read live off `document.crop_rects`/`document.drawn`/`document.union`, used by both the keep-ratio toggle and `set_split()`. | ARCHITECTURE §2 |
| 10 | Same-size split windows (§7.3, §9.6) | "Same size" is enforced on RELEASE: the other windows adopt the dragged window's w×h, keeping their own origins | **Restored to directional edge symmetry (2026-07-10), gated to resize only — see design history below.** For any RESIZE handle (corner/edge, never `move`) with Same-size ON: the dragged window's raw edge **deltas** propagate to every OTHER window, mirrored by grid parity, each applied to the partner's own rectangle at drag start. Partner in the other **column** (x-mirrored): `ΔL′=−ΔR, ΔR′=−ΔL`; other **row** (y-mirrored): `ΔT′=−ΔB, ΔB′=−ΔT`; same column/row copies that axis unchanged. (Grid order n=2 [left,right]; n=4 [TL,BL,TR,BR].) So dragging the LEFT edge of the left 2-split window moves the RIGHT edge of the right window the opposite direction; TOP/BOTTOM edges of a 2-split move the SAME direction (both windows span one row, so their top/bottom stay level); a 4-split syncs top/bottom within a row and left/right within a column the same way. Keep-ratio applies to the dragged window first; partners receive the resulting deltas. **Deltas are pre-clamped (bug #2, 2026-07-10)** against every window's own headroom (`geometry.clamp_edge_deltas`) *before* being applied, so growth simply stops at the tightest window's page-edge limit instead of a window needing to jump/reposition afterward — this replaces relying on each partner's own post-hoc `clamp_box_drag` call, which could deform a partner independently of the others and break the equal-size invariant. **Turning Same-size ON re-normalizes immediately** (`set_same_size`): every window snaps to the first window's width/height, capped to whatever fits every window's own (unmoved) origin, so the invariant holds from the toggle itself, not only after the next drag — a deliberate deviation from frozen §7.3's literal "dragging one resizes all of them" (which only describes the on-drag case). **`move` (translating a window by its interior) NEVER propagates, in any state** — position is fully independent per window for a move, always; this is an explicit correction, made this update, of the v2 design below, which mirrored move deltas too. **Esc/right-click during the drag restores every window** to its drag-start rectangle (`SplitDrag.rects0`), per frozen §9.6 "windows left unchanged". `geometry.apply_edge_deltas`/`clamp_edge_deltas`, driven from `_update_split_drag`. **Design history (flagging the reversal):** v1 positional mirror (rejected) → v2 edge-delta mirror applied to both move and resize (2026-07-05) → an attempted v3 read frozen §7.3's "each anchored at its own corner" literally as full per-window position independence (2026-07-10 same-day), which visually broke row/column alignment (a 2-split's two windows no longer shared top/bottom, a 4-split's rows/columns drifted apart) — user-reported and confirmed against the running build. This row restores the v2 mirroring mechanism for resize, permanently excludes it from move, and fixes bug #2's jump/jitter at the page edge. **This is a confirmed, deliberate contradiction of frozen §7.3's literal "each anchored at its own corner" text** for the axis a row/column shares — flagging per CLAUDE.md's "spec violations flagged directly" rule, not silently reinterpreted. | ARCHITECTURE §2 |
| 11 | Undo/redo depth (§15) | A plain numeric field, default 4, no fixed choices | **Web-only deviation, previously undocumented.** The web renders this as a **preset dropdown** (`UNDO_DEPTH_OPTIONS`) instead of a free numeric field — there is no equivalent constraint on desktop. `UNDO_DEPTH_OPTIONS = [1, 2, 4, 8]` (task #9, 2026-07-10; was `[2, 4, 10, 20, 50]`); `DEFAULT_UNDO_DEPTH` stays `2` (already a member of the new list). `AppModel.set_undo_depth()` clamps to `[UNDO_DEPTH_MIN, UNDO_DEPTH_MAX]` regardless of the preset list, so the dropdown and the clamp both read from the one constant. | ARCHITECTURE §5 |
| 12 | Illumination-flatten background estimate (§10.2) | `clean_document_bilevel` divides the page by a full-resolution 51×51 morphological-close background (native OpenCV, parallelized/large-kernel-optimized — ~38 ms/page) | **Deliberate web performance deviation (2026-07-10, task T4).** opencv.js (single-thread WASM, no large-kernel morphology optimization) runs that exact 51×51 `MORPH_CLOSE` in **≈580 ms–9 s/page** depending on resolution — it is the single dominant cost of both the B/W filter and Auto-detect, and SIMD barely moves it (morphology is not the SIMD-friendly part). The web therefore estimates the illumination background on a **downscaled** copy: gray → `resize ×1/BG_DOWNSCALE` (INTER_AREA) → `MORPH_CLOSE` with a `51/BG_DOWNSCALE`-sized ellipse → `resize` back up (INTER_LINEAR) → divide, exactly as before (`imaging.ts illumination_flatten`, `BG_DOWNSCALE` in `core/constants.ts`). The background is by definition low-frequency, so this is near-lossless: the intermediate flat image can differ by up to ~78/255 at a few high-contrast edges, but that washes out in the Sauvola threshold that consumes it — the **final bilevel output** agrees with the full-resolution result at **~95%** of pixels, the *same* agreement opencv.js-vs-opencv-python already has from box-filter/threshold numerical differences (i.e. the downscale adds ≈0 extra error). Measured `illumination_flatten` on a 1240×1755 asset: 583 ms → 16 ms (**36×**). Verified in `tests/perf/scan_speed.test.ts`. | ARCHITECTURE §9 |
| 13 | NORMAL-mode auto-detect source (§8) | Desktop `detect.py normal_page_box` derives the content box from the PDF **text layer** (glyph positions) for born-digital pages, rasterizing only when there is no text | **Same — text-layer fast path kept (decision 2026-07-10, task T4).** `_detect_each_page` calls `PdfRendererAdapter.detect_text_box(orig)` first for NORMAL pages; it only falls back to the ink/raster path (`detect_content_box`) when the text layer yields nothing usable (image page, or a degenerate <4 px box). This is deliberate desktop parity and avoids rasterizing every born-digital page just to find bounds. A prior test (`detect_union.test.ts`) asserted the *opposite* (ink-path only, to dodge an "advance-based right-margin inflation" a text run's trailing-whitespace advance can cause) — that was a TDD stub for a fix never made and whose own "§W2 row 10" citation was wrong (row 10 is split windows); the test was rewritten to assert the shipped text-layer behavior. If the right-margin inflation is confirmed on a real justified-text PDF, the fix is to clamp `textItem.width`'s trailing advance in `detect_text_box`, **not** to abandon the text-layer path. | ARCHITECTURE §9a |

Everything else in the desktop spec — classification (§4), coordinate system/canvas fit (§5), the
full crop-window state machine (§9) including keep-ratio (§9.7) and cancel-drag (§9.3/§9.6),
auto-detect (§8), the B/W and Sharpen filters (§10.2), pages selection (§11), apply/export/compress
(§12), history/reset/rotate/delete (§13), and the error taxonomy (§20) — is implemented and
exercised by the test suite. Current pass/fail counts and coverage live in ARCHITECTURE.md's status
table and §19 (Quality gates), not here, so this document doesn't go stale every time the suite
changes. The Playwright end-to-end suite (`tests/e2e/`: smoke, crop_split, committed_window;
chromium + firefox projects) exercises the synthetic-doc boot, three-column layout, split/crop
output-page math, committed-window gestures, and Settings-panel open/Esc-close in a real browser.
Confidence [high] for unit-level correctness and the chromium e2e paths; [med] for (a) Firefox (the
e2e project exists but was not runnable in the update sandbox — missing OS libs) and (b) in-app
WebGPU dewarp on a real GPU (the sandbox has no GPU; only the wasm EP was exercised in-browser).

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
The canvas carries a **bottom-right cursor read-out** as a DOM overlay (see **Status text** below
for the full account); nothing else is drawn on the canvas outside the page bitmap and crop
overlays. Settings → Appearance → Font size is a **preset
dropdown** (8, 10, 12, 15, 18, 22, 25 pt). Navigation **prefetches the adjacent pages'** work rasters
in the background after each view prepares, so next/prev is a cache hit rather than a blank
"Loading…" flash while a scanned-mode filter render runs on demand.
**Output-quality settings** (compress DPI, colour, export format) persist across document loads and
across browser sessions via `localStorage` (`ui/persist.ts`, key `scw.output.v1`), owned by the UI
layer so `core/` stays storage-free (ARCHITECTURE §10). They live solely in the sidebar **Output
Quality** card; the Settings Output section keeps postfix **plus two shared-state fields: Custom
DPI** (same `settings.custom_dpi` as the sidebar field; editing it switches the compress preset to
Custom) **and Paper size** (`PAPER_SIZES`: A2/A3/A4/A5/A6, default A4 — the export sizing base,
§W2 row 8). **Output folder was removed (2026-07-10)** — the web export path streams a browser
download and cannot write to a chosen folder, so the field was inert (same rationale as
`confirm_overwrite`'s removal, §W2 row 6); `AppModel.suggested_export_name()` now returns just the
filename, not a `[name, folder]` tuple.
The compress dropdown includes a **Custom…** entry backed by a numeric DPI field
(`AppModel.custom_dpi`, default 300, clamped 50–1200); like every output-quality setting it affects
the exported file only (§W2 row 8), never the preview.
Exact icon set, control widths, switch/field styling, and per-control coloring (e.g. Delete must
NOT be styled differently from other action buttons) must match `docs/app_design_screenshots/`,
which supersedes this section's prose wherever more specific.

**Detail panel** replaces the desktop's floating Settings/Help windows (§15, §16): a panel between
the sidebar and canvas, collapsed (width 0) by default. Clicking Settings or Help opens it showing
that content and shrinks the canvas to fill the remaining space (never below 400px). Pressing the
same button again, or **Esc**, closes it. Pressing the other button swaps content without a
close/reopen animation. No modal, no overlay dimming — it is part of the normal page flow.

**Status text** — the canvas has no page-number/size status element (removed 2026-07-05 by user
decision — deviation from desktop §3.3). `ViewSnapshot.status` still carries the string at the
model layer (`core/model.ts`); nothing renders it. Nothing is painted onto the page raster either
(desktop inv 32). The only canvas-adjacent text is the bottom-right cursor read-out, a DOM overlay
(`canvas_view.ts`'s `_coords_el`), updated on `pointermove`.

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
| Page navigation | < 100 ms (RAM cache hit: immediate bitmap draw; RAM-miss but disk-hit reloads the processed raster from IndexedDB, no recompute) |
| B/W or Sharpen filter per page (OpenCV half) | **< 500 ms** (task T4 budget; measured ~90 ms/page synthetic Node / ~360 ms/page real-browser 1653×2339 scan, SIMD WASM + downscaled-morph §W2 row 12). Verified by `tests/perf/scan_speed.test.ts` and `tests/e2e/scan_simd.spec.ts`. |
| Auto-detect per page | **< 100 ms** (task T4 budget; measured ~26–56 ms/page — detection runs on the raw source, not the processed work image, §W2 row 5). Verified by the perf suite. |
| Dewarp per page (ONNX stage, separate from the OpenCV half above) | Seconds on the 1-thread WASM EP; fast on WebGPU where available (§W2 row 1). Not part of the < 500 ms OpenCV budget. |
| Export per page | < 300 ms (JPEG encode + pdf-lib embedding) |
| First OpenCV.js WASM load | < 3 s, once per session (~10 MB SIMD build, lazy — scanned-mode documents only) |
| First ONNX model fetch + init | < 5 s, once per session (cached in IndexedDB after; 0 ms on repeat sessions). Dewarp is implemented (§W2 row 1) — this budget is now reachable in practice, pending in-browser timing confirmation via Playwright. |

**CV runtime (task T4):** OpenCV.js is a **SIMD (v128) WASM build, single-thread** — no `SharedArrayBuffer`, no COOP/COEP (GitHub Pages cannot set those headers). The vendored upstream `@techstark/opencv-js` was a scalar (non-SIMD) build; it was replaced with a from-source OpenCV 4.10.0 build compiled `-msimd128`, verified to actually contain v128 ops (166,485 SIMD instructions in the shipped `.wasm` vs 0 before) and ~1.5–4.5× faster on the matched pipeline. See `vendor/opencv-js-simd/BUILD.md` and ARCHITECTURE for the build/verification detail. SIMD alone did **not** meet the budget — the architectural fixes in §W2 row 5 and the morphology change in row 12 did the bulk of the work.

---

## W6. File I/O behavior (browser-native equivalent of desktop spec §7.1/§12.5)

**Load:** a file picker (`<input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff">`)
or drag-and-drop onto the canvas/window. Combine order, per-file page contribution, and mode
classification follow desktop spec §7.1a unchanged (multi-file and mixed PDF+image combination
work — §W2 rows 3–4, fixed 2026-07-03).

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
- **Overwrite confirmation** (desktop spec §15's `confirm_overwrite` setting) has no web equivalent:
  the browser download path cannot detect an overwrite (§W2 row 6). The inert Settings checkbox has
  been removed.

---

## W7. What does not change

Everything in desktop spec §4–§22 not listed in §W2's deviation table: the crop-never-dropped
invariant (§9.5, §12.4), the one-render-path WYSIWYG guarantee (§12.1, qualified by §W2 row 8 — compress DPI and
output colour are export-only, not applied to the preview), the LRU memory bound (§17),
the keep-ratio lock (§9.7, qualified by §W2 row 9 — the web holds the ratio live during drags and
anchors a resize on the opposite handle, not on-release/top-left), the batch fail-fast/cancel
behavior (§14), the error taxonomy and dispatch contract (§20), the card layout and control order
(§6, adapted per §W3), and every acceptance invariant in §22 except where §W2 documents a gap.

---

## W8. Committed-page crop coordinates (browser mechanism for desktop spec §9.3)

A committed single-crop page (split = 1) is shown **cropped/zoomed to the committed box** and stays
that way until Undo or a split-mode switch (desktop §9.1, §9.3). The desktop reads pointer input and
paints overlays in the shown output's coordinates and maps them back to page coordinates; the web
build makes that mapping explicit through one field.

`ViewSnapshot.crop_origin {x,y}` is the full-page-unit top-left of the shown image: `{0,0}` on a full
page, and the committed box's `(x0,y0)` on a committed page (where `page_w/page_h` are the box's own
width/height). `canvas_view.ts` centres the cropped bitmap in the canvas, then for every
page↔canvas conversion shifts by `crop_origin`:

```
canvas_px = img_origin + (page_coord − crop_origin) · scale      // painting overlays / draw_rect
page_coord = crop_origin + (canvas_px − img_origin) / scale       // pointer → page
```

Consequences, matching desktop §9.3 behavior:

- A drag on a committed page rubber-bands a **new drawn window over the cropped view with no zoom
  change** — the canvas never flips back to the full page. The window is clamped to the committed box
  (a new window can only tighten). It is committed only by the **Crop** button (draw is separate from
  Crop, §12.2); `end_drag` never writes `applied`.
- The committed crop itself is **not a drag target** — there is no "resize the committed box" gesture
  (the web build has no `crop_edit` drag; grabbing the crop's edge draws a new window). Editing is:
  draw a new window → Crop, or Undo. Esc / right-click drops the in-progress drawn window and leaves
  the committed crop untouched (desktop §9.5 crop-never-dropped).
