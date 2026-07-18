# SmartCrop PDF Web — Function & Connection Map

The canonical per-file function/line-number reference for this repo — CLAUDE.md and ARCHITECTURE.md
point here instead of duplicating these tables. Line numbers drift as files change; re-`grep` a
specific line before citing it in an edit rather than trusting a number here verbatim. §18 is a
proposed `AppModel` decomposition, not yet implemented as of this revision.

---

## 2. Real directory layout (derived from import paths)

| Path | Files | Constraint |
|---|---|---|
| `src/core/` | `constants, enums, errors, geometry, parsing, lru, viewmodel, document_state, settings, history, drag, batch, model`.ts | Zero DOM/Worker/pdf-lib/pdfjs-dist — enforced by `tests/architecture.test.ts` |
| `src/pdf/` | `loader.ts, imaging.ts, work_store.ts` | Main thread, DOM allowed, imports `@core/*` + `@workers/*` |
| `src/workers/` | `export.worker.ts, tiff.ts` | Only real Worker in the app; zero `window`/`document` |
| `src/ui/` | `app.ts, canvas_view.ts, constants.ts, dom.ts, detail_panel.ts, help_view.ts, nav_bar.ts, overlay.ts, persist.ts, settings_view.ts, theme.ts` | Imports `@core/*` + `@pdf/*`; core never imports ui |
| `src/ui/panels/` | `pages_panel.ts, crop_panel.ts, scan_panel.ts, output_panel.ts` | per `app.ts`'s `./panels/*` imports |
| `src/` | `main.ts, vite-env.d.ts` | entry point |

---

## 3. Dependency graph

```
core/constants,enums,errors,geometry,parsing,lru,viewmodel   (pure leaves)
        ▲
core/document_state, settings, history, drag, batch          (pure, depend on leaves)
        ▲
core/model.ts (AppModel)  ── injected RendererAdapter interface, implemented by pdf/loader.ts
        ▲
pdf/loader.ts ──uses──► pdf/imaging.ts ──uses──► onnxruntime-web, @techstark/opencv-js
     │                        │
     └──uses──► pdf/work_store.ts (IndexedDB)
     └──spawns──► workers/export.worker.ts ──uses──► pdf-lib, fflate, workers/tiff.ts
        ▲
ui/app.ts (AppController) ──owns──► AppModel + PdfRendererAdapter
        │
        ├─► ui/canvas_view.ts, ui/overlay.ts
        ├─► ui/panels/{pages,crop,scan,output}_panel.ts
        ├─► ui/nav_bar.ts
        ├─► ui/detail_panel.ts ──► ui/settings_view.ts, ui/help_view.ts
        ├─► ui/theme.ts, ui/persist.ts, ui/dom.ts
        ▲
main.ts
```

---

## 4. Core data model

**4.1 `DocumentState`** (`document_state.ts`) — the exactly-8-field undo boundary. `snapshot()` deep-copies per-page `Map`/array fields, shares frozen scalars/immutable `Box`/`Offsets`.

| Field | Type | Notes |
|---|---|---|
| `applied` | `Map<number, Box[]>` | committed crop(s) per source page |
| `crop_rects` | `Box[]` | live split rectangles (split 2/4) |
| `rotation` | `Map<number, number>` | page → 0/90/180/270 |
| `processed` | `Map<number, PageProcessIntent>` | per-page scan intent |
| `offsets` | `Offsets` | `{left,top,right,bottom}` % |
| `dewarp_on` | `boolean` | |
| `filter_mode` | `FilterMode` | NONE/BW/SHARPEN |
| `filter_strength` | `number` | 1\|2\|3 |

`drawn` (`Box \| null`, global hand-drawn pending window), `detect_cache` (`Map<number, Box>`, per-page last detect box), `union` (`Box \| null`, aggregate detection union), and `auto_active` (`boolean`, detect run at least once) are **not** `DocumentState` fields — they live directly on `AppModel` as `_drawn`/`_detect_cache`/`_union`/`_auto_active`, non-undoable, same tier as `_anchor_left`/`_keep_ratio`/`_split_count` (§6 fields list). Undo does not revert them; pressing Undo right after Auto-detect with nothing committed is a no-op.

**4.2 `Settings`** (`settings.ts`, NOT undoable — survives Undo, spec-web §12): `compress_preset, custom_dpi, paper_size, custom_paper_in, output_colours, export_format, output_postfix, undo_depth, dewarp_supersample`.

**4.3 `DragState`** (`drag.ts`) — tagged union on `kind`, transient (never snapshotted), lives on `AppModel._drag`:

| kind | Key fields | Used for |
|---|---|---|
| `AutoDrag` | `handle, rect0, offsets0, left_base, top_base` | resizing the live auto-crop rect |
| `SplitDrag` | `idx, handle, rect0, rects0[]` | one split-window resize/move; `rects0` = all windows at drag start (same-size mirror + §9.6 cancel restore) |
| `DrawDrag` | `start` only | rubber-banding a brand-new window |
| `DrawnDrag` | `handle, rect0` | moving/resizing the existing `_drawn` window |

**4.4 Batch** (`batch.ts`): `Ok/Cancelled/Failed(error)` → `BatchResult`. `BatchJob` interface: `title, total, done, cancel(), onProgress(cb), result(): Promise<BatchResult>`. `PageBatchJob` is the concrete impl; `.controller` getter exposes `{is_cancelled, advance(n?), complete(result)}` to the async executor driving it.

**4.5 `ViewSnapshot`/`OverlayBox`/`RendererAdapter`** — `ViewSnapshot.image` is `ImageBitmap | null` (null = loading); full field list in §6.12. `RendererAdapter` interface, incl. `VectorExportPage`/`export_pdf_vector?`, in §6 header / §8.

---

## 5. `geometry.ts` — pure functions (no I/O; `MIN_RECT = 5.0` lives here per spec-web §17)

| Function | Line | Purpose |
|---|---|---|
| `hit_handle(box,px,py,tol)` | 27 | corner→midpoint→interior→null hit test, returns `HandleId\|null` |
| `point_in_box` | 45 | inclusive bounds check |
| `clamp_box_shift(box,pw,ph)` | 51 | shift box into page, preserving W×H (used for `move`) |
| `clamp_box_drag(box,pw,ph)` | 66 | clamp each edge independently, enforces `MIN_RECT` (used for resize) |
| `apply_handle_drag(handle,rect0,start,cur,pw,ph)` | 76 | core drag math: moves only the dragged edges, dispatches to shift-clamp (move) or drag-clamp (resize) |
| `auto_crop_rect(detected,union,offsets,pw,ph,anchor_l,anchor_t)` | 108 | compute live auto-crop rect from detection + offsets (§9.2) |
| `offsets_from_rect(rect,detected,union,pw,ph,anchor_l,anchor_t)` | 131 | inverse of above — back-derive offsets from a dragged rect |
| `detection_union(boxes)` | 156 | spec-web §5 aggregate: `gL=min(x0), gT=min(y0), W=max(w), H=max(h)` — NOT a bbox union |
| `union_box(boxes)` | 170 | standard bbox union (non-detection uses) |
| `keep_ratio_normalise(box,ratio,pw,ph)` | 184 | top-left-anchored ratio lock (static sources: live auto-crop, fresh-draw release) |
| `keep_ratio_anchored(box,ratio,handle,pw,ph)` | 216 | ratio lock anchored opposite the dragged handle, live during drag (spec-web §6.7); one long function per its own comment — 4 corners + 2 symmetric edge pairs each need a distinct page-wall clamp |
| `rotate_box_cw(box,page_h)` | 269 | 90° CW box rotation for `rotate_pages()` |
| `rotate_box_ccw(box,page_w)` | 282 | algebraic inverse of `rotate_box_cw` — one CW step undone, composition-verified |
| `to_native_frame(box,pw,ph,rotation)` | 297 | current (rotation-applied) display frame → source's native rotation=0 frame; used by vector export (`loader.ts::export_pdf_vector`) to convert a box before `embedPage`'s clip |
| `edge_deltas(rect0,updated)` | 313 | per-edge deltas of a resize, for same-size propagation |
| `apply_edge_deltas(base,d,mirror_cols,mirror_rows,pw,ph)` | 327 | apply mirrored deltas to a partner window |
| `clamp_axis_deltas` (module-private) | 339 | one-axis headroom clamp, shared by X/Y in `clamp_edge_deltas` |
| `clamp_edge_deltas(d,rects0,mirror_cols,mirror_rows,pw,ph)` | 362 | cap same-size resize deltas so every window's own headroom is respected before applying |
| `split_rects_grid(n,pw,ph)` | 374 | initial 1/2/4 grid; order TL,BL,TR,BR for n=4 |
| `reindex_map(map,deleted)` | 394 | shift per-page `Map` keys after page deletion |
| `box_width/box_height/box_area` | 405–407 | trivial |

**Callers:** almost all of these are called from `model.ts` (drag helpers, `apply_crop`, `_rotate_page`, `delete_pages`, `set_split`, `_compute_detection_union`). `keep_ratio_anchored` is also invoked directly for `DrawnDrag`/`SplitDrag` live-ratio updates.

---

## 6. `AppModel` (`core/model.ts`, 600 lines) — the central facade

`model.ts` was decomposed into 8 collaborators (§18) to reach its current 600 lines; the
sub-sections below (§6.1–6.13) describe the facade's method GROUPS by public signature, which are
unchanged by that decomposition, not which file each method's body currently lives in — see §18
for the actual per-file breakdown.

`RendererAdapter` injected via constructor (`pdf/loader.ts`'s `PdfRendererAdapter` is the only implementation). Full interface: `load_files, get_source_image, get_work_image, render_output_image, detect_content_box, detect_text_box?, load_work?/persist_work?/clear_work_cache?, export_pdf, export_pdf_vector?, export_images, make_synth_page, close`. `VectorExportPage` (`orig_page, boxes, page_w, page_h, rotation`) is the payload type for `export_pdf_vector`.

### 6.1 Document lifecycle

| Method | Line | Calls out to | Called by (UI) |
|---|---|---|---|
| `load_files(files)` async | 247 | `adapter.load_files` → `_reset_state()` | `pages_panel.ts` file input (`dispatch_async`), `app.ts` initial `load_files([])`, drag-drop in `app.ts` |
| `reset()` async | 254 | `adapter.load_files([])` (re-opens same `_files`) → `_reset_state()` | `nav_bar.ts` Reset button (`dispatch_async`) |
| `_reset_state()` private | 262 | clears document/history/all 3 caches, resets `_drawn/_detect_cache/_union/_auto_active`, bumps `_doc_gen`, fire-and-forget `adapter.clear_work_cache?.()`, reseeds `_ratio` from page 0 aspect | internal only |
| `has_document` get | 299 | | gates nearly every panel's `refresh(busy)` |
| `page_count()` | 300 | returns `_page_map.length` | |
| `document_name` get | 304 | "" / name / "first.pdf +N more" | `pages_panel.ts` doc-name card |

### 6.2 Navigation

| Method | Line | Notes |
|---|---|---|
| `view_total` get | 314 | `viewmodel.output_page_count(page_count(), applied)` |
| `view_position` get | 319 | |
| `next_page/prev_page/jump_to_output_page(n)` | 321–323 | all funnel through `_go_to(pos)` |
| `_go_to(pos)` private | 325 | clamps, `viewmodel.view_to_source` → sets `_current_page`, syncs Select pattern if `current_follow`, invalidates `_current_bitmap` | Called by `canvas_view.ts` (wheel, nav arrows), `nav_bar.ts` prev/next/page-input |

### 6.3 Pages selection

| Method | Line |
|---|---|
| `set_pages_mode(mode)` | 342 — turns off `current_follow` if leaving SELECT |
| `set_select_pattern(pattern)` | 347 — manual edit turns `current_follow` off |
| `set_current_follow(on)` | 352 — turning on forces SELECT mode + pattern = current page |
| `resolve_pages()` | 360 — delegates to `parsing.resolve_pages(mode,total,pattern)` |

All called from `pages_panel.ts`'s mode buttons / pattern input / Current button.

### 6.4 Detect + crop application

| Method | Line | Behavior |
|---|---|---|
| `can_detect` get | 369 | `has_document && split_count===1 && (anchor_left\|\|anchor_top)` |
| `can_apply` get | 374 | split=1 always true; split>1 requires `crop_rects.length === split_count` |
| `detect_content()` → `BatchJob` | 380 | pre-flight throws `NoDocumentError`/`EmptySelectionError`; fires `_run_detect` async, returns job immediately |
| `_run_detect(job,pages)` private async | 390 | `_detect_each_page` → `_compute_detection_union` → history.push (still needed: protects `_refresh_committed_crops_after_detect`'s `applied` writes) → writes `_detect_cache`/`_union`/`_auto_active` (non-undoable) → `_refresh_committed_crops_after_detect` → re-derives `_ratio` from union aspect |
| `_detect_each_page(ctrl,pages)` private async | 419 | **NORMAL mode**: `adapter.detect_text_box(orig)` only — no raster fallback; a page with no usable text gets no detected box. **SCANNED mode**: raster/Sauvola on the raw source, unchanged. |
| `_compute_detection_union(boxes)` private | 456 | excludes boxes ≥`FULL_PAGE_FRAC` of page from the union |
| `_refresh_committed_crops_after_detect` private | 468 | re-detect refreshes already-committed pages in place (spec-web §4.5), doesn't drop them |
| `apply_crop()` | 482 | throws on no doc/empty selection/wrong split count; history.push; per selected page either `_compute_crop_boxes_for_page` (split=1) or copies `crop_rects` (split>1); clears `_drawn` |
| `_compute_crop_boxes_for_page(p)` private | 510 | precedence: hand-drawn window (clamped to page) → else auto-crop-rect from detect+union (if anchored) → else `null` |

Called by `crop_panel.ts`: Auto-detect button (`dispatch_job`), Crop button (`dispatch`).

*(Line numbers in §6.5–6.10 and §6.12–6.13 below are from the pre-vector-export revision of model.ts and have drifted by the net size of the changes above — method names, call order, and behavior are current; re-`grep` a specific line before citing it in an edit.)*

### 6.5 Anchors / offsets / keep-ratio / split / same-size

| Method | Line | Notes |
|---|---|---|
| `set_anchor(left,top)` | 503 | either arg `null` = leave unchanged |
| `set_keep_ratio(on,ratio?)` | 544 | explicit `ratio` wins; else off→on populates from `_default_ratio()` — comment flags a real prior bug (dead-code branch from checking `_keep_ratio` **after** mutating it) |
| `_default_ratio()` private | 561 | precedence: `crop_rects[0]` (split>1) → `_drawn` (split=1) → `_union` → current page aspect → `1.0` |
| `set_split(n)` | 578 | no-op if unchanged; clears `applied` + `drawn` + `manual_offsets_on` (committed crops and the manual-offsets window both belong to the old layout); reseeds `crop_rects` via `split_rects_grid`; re-derives ratio if keep-ratio is on (does NOT carry the old ratio proportionally — deliberate, spec-web §6.7) |
| `set_same_size(on)` | 605 | turning ON immediately normalizes every window to window[0]'s w×h, capped to each window's own headroom |
| `set_manual_offsets_on(on)` / `set_manual_offset(edge,value)` / `manual_offsets()` | — | spec-web §4.6, replaces the old "Advanced" accordion. Reuses the `drawn` window (not a new DocumentState field): on seeds it at `MANUAL_OFFSET_DEFAULT`% margin via `manual_offset_rect`; off clears it. `manual_offsets()` is a live view via `offsets_from_manual_rect`, not separately stored. |

Called by `crop_panel.ts` (Split 1/2/4, Same-size toggle, Anchor L/T checkboxes, Set offsets manual
switch + L/T/R/B fields, Keep-ratio toggle + ratio field).

### 6.6 Drag gesture state machine

| Method | Line | Dispatches to |
|---|---|---|
| `begin_drag(px,py,tol)` | 625 | split>1 → `_begin_split_drag`; else pending `drawn` window → grab handle/move/drop-and-redraw; committed page (split=1) → **always** `_begin_draw_drag` (not a resize target, spec-web §6.3); else `_begin_auto_drag`, falling back to `_begin_draw_drag` |
| `_begin_split_drag(pt,tol,sz)` private | 655 | hit-tests each `crop_rects[i]`; on hit, `history.push` **before** mutating, builds `SplitDrag` with `rects0` snapshot |
| `_begin_auto_drag(pt,tol,sz)` private | 675 | requires `auto_active && detected && union && (anchor_l\|\|anchor_t)`; hit-tests the live auto-crop rect; `history.push` before drag |
| `_begin_draw_drag(pt,sz)` private | 701 | drops any existing `drawn` window immediately (bug 6 fix) |
| `update_drag(px,py)` | 707 | dispatches on `drag.kind` to one of the 4 below |
| `_update_draw_drag` private | 718 | rubber-band clamped to page, and further clamped to the committed box if one exists (can only tighten) |
| `_update_auto_drag` private | 736 | `apply_handle_drag` → optional `keep_ratio_normalise` → writes back to `document.offsets` via `offsets_from_rect` |
| `_update_split_drag` private | 748 | `apply_handle_drag` → optional **live** `keep_ratio_anchored` (not normalise) → `_propagate_same_size` if same-size + resize (never on `move`) |
| `_propagate_same_size` private | 771 | mirrors raw edge deltas by grid parity (col/row parity from index), pre-clamped via `geometry.clamp_edge_deltas` |
| `_update_drawn_drag` private | 785 | same live-ratio pattern as split |
| `end_drag()` | 795 | only `draw` kind does anything: validates min size, optional ratio-normalise, `history.push`, commits to `_drawn` (global, not yet a crop) |
| `cancel_drag()` | 824 | restores per-kind: `auto`→`offsets0`, `split`→`rects0`, `drawn`→`rect0`; no-drag Esc drops a pending `drawn` window |

Called by `canvas_view.ts`'s `pointerdown/pointermove/pointerup/contextmenu/Escape` handlers (`_on_down/_on_move/_on_up/_cancel`).

### 6.7 Scan processing

| Method | Line | Notes |
|---|---|---|
| `run_dewarp()` → `BatchJob` | 871 | toggles `document.dewarp_on` synchronously (history-pushed first, undoable) then returns a job that pre-warms the selection's work rasters |
| `set_filter_mode(mode)` → `BatchJob` | 879 | pressing the active filter turns it OFF (toggle semantics) |
| `set_filter_strength(n)` → `BatchJob` | 888 | clamped `[FILTER_STRENGTH_MIN,MAX]` |
| `_require_scan_pages()` private | 857 | shared guard (was missing from `set_filter_strength` pre-fix per comment) |
| `_warm_work_cache/_run_warm` private | 897/903 | drives a `PageBatchJob` through `_get_work(p)` per page, yielding via `_yield_to_paint()` between pages so the overlay repaints and Cancel is honored |
| `_apply_scan_intents(pages)` private | 924 | records current global flags as each page's `PageProcessIntent`, drops cached rasters (no compute here — lazy) |

Called by `scan_panel.ts` (Dewarp/B-W/Sharpen/strength buttons, all via `dispatch_job`).

### 6.8 History

| Method | Line |
|---|---|
| `undo()` / `redo()` | 943 / 954 — both clear all 3 raster caches + invalidate current bitmap on a successful pop |
| `can_undo` / `can_redo` get | 965/966 |

Called by `nav_bar.ts` Undo/Redo buttons, `app.ts` Ctrl+Z/Ctrl+Y shortcuts.

### 6.9 Output settings (outside `History` — survive Undo)

| Method | Line |
|---|---|
| `set_compress_preset(name)` | 972 — validates against `DPI_PRESETS` keys or `CUSTOM_DPI_PRESET` |
| `set_paper_size(name)` | 975 — validates against `PAPER_SIZES` keys or `CUSTOM_PAPER_PRESET` |
| `set_custom_paper_in(h)` | 978 — clamp `[CUSTOM_PAPER_MIN,MAX]` |
| `set_custom_dpi(dpi)` | 982 — clamp `[CUSTOM_DPI_MIN,MAX]`, rounds |
| `set_output_colours(mode)` | 985 |
| `set_export_format(fmt)` | 986 — validates against `EXPORT_FORMATS` |
| `set_undo_depth(depth)` | 991 — clamps, propagates to `history.set_depth(d)` |
| `set_output_postfix(postfix)` | 996 |
| `set_dewarp_supersample(factor)` | 997 — clamp `[1.0, 4.0]` (note: literal, not a named constant here) |
| `_resolved_target_long_px()` private | 1005 | resolves compress-preset→DPI × paper-height-in → export long-side px (spec-web §10.4 math) |

Called by `output_panel.ts` (sidebar Output Quality card) and `settings_view.ts` (Settings→Output; shares the *same* `custom_dpi`/`paper_size` state — either control reflects the other).

### 6.10 Rotate / delete

| Method | Line | Notes |
|---|---|---|
| `rotate(pages)` (`page_ops_service.ts`) | 47 | history.push once, then `_rotate_page(p)` per selected page; after the loop, if `split_count>1`, reseeds `crop_rects` via `split_rects_grid` against the current page's now-rotated dims (bug: split windows staying stale after rotate) |
| `_rotate_page(p)` private | 52 | reads `page_dims(p)` **before** mutating rotation (order matters — box coords are in the pre-step frame); rotates `applied`/`detect_cache` boxes via `rotate_box_cw`; does **not** evict source/work caches — rotation is part of their cache key (§7), so the new angle simply resolves to a different entry; only `invalidate_output(p)` (the crop/split preview) is explicit; resets `offsets` to default; rebuilds `union` |
| `delete(pages)` (`page_ops_service.ts`) | 81 | throws `DeleteAllPagesError` if deleting everything; **`history.clear()`**, not push — delete is explicitly non-undoable; reindexes `applied/rotation/processed/detect_cache` via `geometry.reindex_map`; rebuilds `_page_map` **before** rebuilding `union` |

Called by `crop_panel.ts` Rotate/Delete buttons. Delete first checks `resolve_pages().length >=
page_count()` in the panel itself — deleting everything always throws, so that case shows a plain
info dialog instead of ever opening the confirm dialog; otherwise confirms via `ctrl.confirm()`
(`ui/confirm.ts::confirm_dialog`, a themed dialog — never native `window.confirm`).

### 6.11 Export

| Method | Line | Notes |
|---|---|---|
| `suggested_export_name()` | 1149 | strips source extension, appends `output_postfix` + format extension |
| `export(filename)` → `BatchJob` | 1159 | picks `_run_export_vector` when `mode===NORMAL && export_format==='PDF' && adapter.export_pdf_vector` exists, else `_run_export`; image formats double `job.total` (render phase + encode phase) so the bar doesn't freeze at 100% during zip encode — PDF (either path) has no separate encode phase |
| `_run_export(job,filename)` private async (raster) | 1180 | `_render_export_pages` → `adapter.export_pdf` or `adapter.export_images`(+zip) → `_download_pdf`/`_download_zip` callback |
| `_run_export_vector(job,filename)` private async | 1215 | builds `VectorExportPage[]` (current-frame box + rotation per page, via `_export_boxes_for_page`/`_page_dims`/`document.rotation`) → `adapter.export_pdf_vector(pages)` → `_download_pdf`. No `render_output_image`, no rasterization — box resolution is the only work done here, the adapter converts to the source's native frame itself. |
| `_render_export_pages` private async | 1243 | per page: `_get_work(p)` → `_export_boxes_for_page` → `adapter.render_output_image` per box, yields to paint between pages |
| `_export_boxes_for_page(p,sz)` private | 1277 | committed boxes → else live auto-crop → else full page; shared by both export runners |
| `_yield_to_paint()` private | 1273 | `setTimeout(0)` — deliberately not `window`/`document` so `core/` stays platform-agnostic |
| `set_download_handlers(pdf,zip)` | 1289 | wired once by `app.ts` at construction to actual `<a download>` blob logic |

Called by `output_panel.ts` Export button, `app.ts` Ctrl+S.

### 6.12 View snapshot + overlay building

| Method | Line | Notes |
|---|---|---|
| `view_snapshot()` | 1225 | no document → `_synth_snapshot()`. Committed page (split=1, has `applied[p]`): returns the **cropped** view (`crop_origin` = box top-left, `page_w/h` = box dims, image from `_output_cache`) + `_committed_overlay` (only the in-progress drawn window, clamped). Otherwise full page + `_build_overlay(p)`. |
| `_committed_overlay(box)` private | 1272 | only draws the pending `drawn` window clamped into the crop box — a plain committed crop shows **no** frame (bug 18 fix) |
| `prepare_current_view()` async | 1284 | must be awaited before reading `view_snapshot()` — sets `_is_loading`, resolves `_get_work(p)` → `_current_bitmap`, pre-renders committed split views, background-prefetches `p±1` |
| `_prefetch(p)` private | 1306 | de-duped via `_prefetching` Set; skips if already RAM-warm |
| `_prerender_output_views` private async | 1317 | renders every split view's output bitmap via `adapter.render_output_image` with `target_dpi=null, greyscale=false` — **preview never bakes in output-quality settings** (spec-web §10.1) |
| `_build_overlay(p)` private | 1472 | precedence: split rects (kind `split`) → global drawn window (kind `committed`, clamped to page) → committed crop(s) (kind `committed`) → live auto-crop (kind `auto`) → empty |
| `_invalidate_output_cache/_invalidate_current_bitmap` private | 1512/1516 | |
| `_status_string(p,sz)` private | 1518 | model-level only — nothing renders it (spec-web §3, no status text painted on the canvas) |
| `_synth_snapshot()` private | 1522 | placeholder doc snapshot |

Called every mutation by `app.ts::_refresh_async()`.

### 6.13 Private raster pipeline

| Method | Line | Notes |
|---|---|---|
| `_page_dims(p)` | 1369 | translates `p` (logical, post-delete) → original index via `_page_map`, swaps w/h if rotation is 90/270. **The one function everything reads page size through** — never read `doc.page_sizes[p]` directly. |
| `_get_source(p)` async | 1383 | RAM-cached (`_source_cache`, LRU `CACHE_WINDOW`); real doc → `adapter.get_source_image`; synthetic → `adapter.make_synth_page`. Every raster is rendered here exactly once per (page,rotation) — detect, NORMAL view, and the SCANNED work pipeline all funnel through this. |
| `_get_work(p)` async | 1398 | NORMAL mode: returns `src` directly, **not** re-cached in `_work_cache` (explicit double-close hazard comment — two close-on-evict caches holding the same bitmap would double-`close()` it). SCANNED + no-op intent: same short-circuit. SCANNED + real intent: disk-tier check (`_persisted_keys.has(key)`) → `adapter.get_work_image` → `_cache_work`. |
| `_cache_work/_page_process_intent/_work_disk_key/_load_work_from_disk` | 1430/1435/1447/1454 | disk key = `g{gen}|{origpage}|d{0,1}|f{mode-strength}|r{rot}|s{supersample}` — namespaced so a settings change or new document can never read a stale/wrong raster |
| `_live_auto_crop_for(p)` | 1460 | same math as `_build_overlay`'s auto branch, reused by `_export_boxes_for_page` |

---

## 7. `pdf/imaging.ts` (731 lines) — OpenCV.js + ONNX, main thread by design (§7a)

Entry points called from `loader.ts` directly (no `postMessage`):

```
detect_content_async(bitmap,page_w,page_h,mode)  [L126]
  → ensure_cv() [L66]  (module-cached init promise, fast-path if cv.Mat already exists)
  → detect_content(bitmap,page_w,page_h) [L375, module-private]
       → downscale to DETECT_MAX_PX → clean_document_bilevel(gray, BW_STRENGTH[2].k/minArea, ...) [L340]
            → illumination_flatten(gray,kernel) [L296] → morph_close_background [L313] (downscaled 1/BG_DOWNSCALE, spec-web §16)
            → sauvola_ink_mask(flat,window,k) [L230, in truncated 156-246 region — box-filter mean/std, T=mean·(1+k·(std/R−1))]
            → connectedComponentsWithStats → single-pass LUT despeckle by min_area
       → cv.connectedComponentsWithStats again on the bilevel ink → border-exclude + area-filter → bbox (border-touch fallback if nothing survives) → scale back up

process_page_async(bitmap,intent,supersample)  [L133]
  → ensure_cv(); if intent.dewarp: ensure_onnx() [L87]
  → process_page(bitmap,intent,supersample) [L464, module-private]
       → if dewarp: apply_dewarp(mat,supersample) [L571]
            stage 1: mat_to_resized_chw_f32 → f32→f16 → uvdoc.onnx → warp-field grid (handles both
                     Float16Array and Uint16Array ORT output shapes — bug 21 fix)
            stage 2: mat_to_chw_f32(full-res) + grid → bilinear_unwarping.onnx (GridSample) →
                     chw_f32_to_rgba_mat → optional cv.resize down if supersample≠1
       → if filter: apply_filter_mat(mat,mode,strength) [L501]
            BW      → clean_document_bilevel(gray, BW_STRENGTH[strength], ...) → grey2rgba
            SHARPEN → illumination_flatten → bilateralFilter(denoise, strength-scaled) →
                      GaussianBlur(strength-scaled) → addWeighted(unsharp, CLEAN_AMOUNT[strength]) → grey2rgba
       → copy mat.data into a fresh Uint8ClampedArray (NOT mat.data.buffer directly — that's the
         whole WASM heap and threw IndexSizeError, bug 3) → OffscreenCanvas → ImageBitmap

fetch_with_idb_cache(key,url)  [L691]  — used only for the two dewarp .onnx model files
  → open_idb (db 'smartcrop-models') → try cache → else fetch() (a failed fetch is NEVER cached,
    bug M3) → put → return bytes
```

f16↔f32 conversion helpers (`f32_to_f16_bits, f16_bits_to_f32, f32_array_to_f16_bits, f16_data_to_f32_array`, L154–229) are self-contained bit-twiddling, verified against numpy.float16 per their header comment — not re-read line-by-line for this map, treat as a stable black box unless a task specifically touches ONNX tensor packing.

---

## 8. `pdf/loader.ts` (503 lines) — `PdfRendererAdapter implements RendererAdapter`

| Method | Line | Notes |
|---|---|---|
| `load_files(files)` async | 168 | empty `files` + prior `_files` → reload (used by `reset()`); truly empty → synthetic doc (`SYNTH_PAGES=1` page); else builds `_pages: PageSource[]` (`{kind:'pdf',pdf,page_num}` or `{kind:'image',blob}`) — **this is what makes multi-file + mixed PDF/image documents work** (spec-web §9); classifies NORMAL if any page is native (`is_native_page`) |
| `get_source_image(page_idx,dpi,rotation)` async | 253 | image page: `createImageBitmap` direct, dpi ignored; PDF page: `page.getViewport({scale:dpi/72})` → render → `rotate_bitmap_cw` bakes rotation into pixels |
| `get_work_image(source,intent,supersample)` async | 277 | takes the **already-rendered** bitmap (not a page index) — single rasterization, spec-web §7; no-op intent short-circuits to `source` |
| `load_work/persist_work/clear_work_cache` | ~310 | thin delegates to `pdf/work_store.ts`'s `WorkRasterStore` |
| `render_output_image(src,box,pw,ph,target_long_px,greyscale)` | 295 | the WYSIWYG raster path — used by preview always, and by export whenever export rasterizes (SCANNED any format; NORMAL JPG/PNG/TIFF). NOT used for NORMAL-mode PDF export (see `export_pdf_vector`). `out_scale = target_long_px / max(crop_w,crop_h)` when sizing for export, else native `src.width/page_w`. Greyscale via manual luma weights on `getImageData`. |
| `detect_content_box` | 337 | thin delegate to `imaging.ts::detect_content_async`. SCANNED only, called by `_detect_each_page`. |
| `detect_text_box(page_idx)` | 350 | NORMAL-mode ONLY detection path: unions text-run boxes straight from `page.getTextContent()` + `pdfjs.Util.transform`; returns `null` for image pages, no usable text, or a degenerate <4px box — no raster fallback exists for NORMAL mode anymore (spec-web §5) |
| `export_pdf` / `export_images` | 384 / 391 | both go through `_export_worker()` (lazy-instantiated `RpcWorker` wrapping `export.worker.ts`), transferring bitmaps. Raster path — SCANNED any format, NORMAL JPG/PNG/TIFF. |
| `export_pdf_vector(pages)` async | 409 | NORMAL-mode PDF export (spec-web §10.3): for each `VectorExportPage` entry and each of its boxes, converts to the source's native frame (`geometry.ts::to_native_frame`) then either `outDoc.embedPage(srcPage, boundingBox)` + `drawPage` (PDF-sourced page — one pdf-lib parse per unique source file, cached via `PDFDocumentProxy.getData()` → `PDFDocument.load()`) or `embedPng`/`embedJpg` + an equivalent offset-draw (image-sourced page, lossless passthrough; any other decodable format goes through `reencode_as_png` first). `outPage.setRotation(degrees(rotation))` applies rotation. Runs on the main thread — no worker, no rasterization. |
| `make_synth_page(_idx,w,h)` | ~470 | direct Canvas API, no worker |
| `close()` / `_release_sources()` | 480 / 488 | destroys every open `PDFDocumentProxy` (plural — multi-file), terminates export worker |

**`RpcWorker`** (`class RpcWorker`, line 108): id-correlated `postMessage`, `Map<id,{resolve,reject,on_progress}>`; `'progress'` messages don't delete the pending entry (job isn't done yet), `'ok'`/`'error'` do.

**`rotate_bitmap_cw(bitmap,angle)`** (module fn, line 62): draws onto a rotated+dimension-swapped `OffscreenCanvas` via `ctx.translate/rotate`; equivalent to PIL's `img.rotate(-ang, expand=True)`.

**`reencode_as_png(blob)`** (module fn, line 83): decodes an image blob via `createImageBitmap` and re-encodes as PNG bytes — used by `export_pdf_vector` for an image-sourced page in any format pdf-lib can't embed directly (only JPEG/PNG).

---

## 9. Small support modules (verbatim source already in context — no line-hunting needed)

| File | Exports | One-liner |
|---|---|---|
| `core/history.ts` | `History` class | bounded undo/redo `DocumentState[]` stacks; `push` snapshots+clears redo; `undo`/`redo` swap between stacks; `set_depth` trims both on shrink |
| `core/lru.ts` | `LRUCache<K,V>` | `Map`-based, re-insert-on-get for LRU order; `onEvict` vs `onCapacityEvict` distinction is what makes the work-cache write-back tier possible (§6.13) |
| `core/parsing.ts` | `resolve_pages` | ALL/ODD/EVEN trivial; SELECT → `parse_pattern` → per-comma-part dispatch to `parse_range` (`a-b`) or `parse_slice` (`start:stop:step`, all optional) or bare int; 1-indexed input, 0-indexed output, deduped+sorted `Set` |
| `core/viewmodel.ts` | `output_page_count, view_to_source, source_to_first_view, source_to_view_range` | pure math converting between source-page index and 1-based output-view position, accounting for committed splits expanding one page into N views |
| `pdf/work_store.ts` | `WorkRasterStore` | IndexedDB PNG-blob store; every method best-effort (storage failure → no-op/null, never throws to caller); `put` snapshots pixels via `drawImage` synchronously before any `await` so a same-tick LRU eviction can't race the encode |
| `ui/dom.ts` | `requireEl, syncCustomReveal` | `requireEl` throws instead of silent-null (replaces `querySelector!`); `syncCustomReveal` is the one shared "Custom…" reveal/sync pattern used by both Output Quality's Custom DPI and Settings' Custom paper height |
| `ui/persist.ts` | `load_output_prefs, save_output_prefs` | `localStorage` key `scw.output.v1`; load degrades to `{}` on any error (private mode, quota, corrupt JSON), never throws |
| `ui/theme.ts` | `apply_theme, current_theme` | injects `DARK`/`LIGHT` CSS-custom-property tables onto `documentElement`; `'system'` wires a live `matchMedia` listener |
| `workers/tiff.ts` | `encode_tiff(rgba,w,h)` | hand-rolled baseline uncompressed 8-bit RGB single-strip TIFF, little-endian, alpha stripped |

---

## 10. `workers/export.worker.ts` (105 lines) — the one real Worker

```
onmessage(Req) → try/catch → err(id,message) on throw
  'export_pdf'    → build_pdf(pages,quality): pdf-lib PDFDocument, per page embedJpg(bitmap_to_jpeg(...))
                     + addPage + drawImage, closes each bitmap after embed, save({useObjectStreams:true})
  'export_images'  → zip_images(pages,format,base,quality,on_progress): per page encode_page(...) →
                     zipSync (fflate) entries "<base>_NNN.<ext>", level 0 for JPG/PNG, level 1 for TIFF
                     (level 6 made the final zipSync a progress-less freeze)
        encode_page → TIFF: getImageData → tiff.ts::encode_tiff; else convertToBlob(mime,quality)
```

Both response paths transfer `ArrayBuffer`s (`[bytes.buffer]`/`[zip.buffer]`), not clone.

---

## 11. `ui/app.ts` — `AppController` (443 lines)

Owns one `AppModel` + one `PdfRendererAdapter`. **The only error-catch sites in the app** (per CLAUDE.md's hard rule).

| Method | Purpose | Used by |
|---|---|---|
| `dispatch(command: () => void)` | try/catch → `_show_error`; always `_persist_output_prefs()` + `_refresh_async()` after | every synchronous panel action (toggles, manual-offset edits, undo/redo, etc.) |
| `dispatch_async(command: () => Promise<void>)` | `.then(refresh)` / `.catch(show_error + refresh)` | `load_files`, `reset` |
| `dispatch_job(make_job: () => BatchJob)` | pre-flight try/catch on `make_job()` itself (sync errors like `EmptySelectionError`); shows overlay if `job.total > 1`; wires `onProgress` → overlay; on `result()` hides overlay, shows error if `Failed` | `detect_content`, `run_dewarp`, `set_filter_mode/strength`, `export` |
| `toggle_detail(panel)` / `_open_detail` / `_close_detail` | Settings/Help panel open-close-swap, no animation between the two contents | `nav_bar.ts` Settings/Help buttons |
| `refresh_all()` / `_refresh_async()` private | awaits `prepare_current_view()` if a doc is loaded, then `view_snapshot()` → `canvas_view.paint` + every panel's `refresh(model,busy)` + `detail_panel.refresh(model,ui_config)` | called after every `dispatch*` |
| `_wire_drop_zone()` | dragover/dragleave/drop → `dispatch_async(load_files)` | canvas area |
| `set_theme/set_font_size/set_remember_folder/set_offline_enabled/zoom/set_ui_scale/_apply_scale` | `UIConfig` (presentation-only, invisible to `core/`) | `settings_view.ts` |
| `_restore_output_prefs()` / `_persist_output_prefs()` | bridges `AppModel` output settings ↔ `localStorage` via `persist.ts`, called once at construction / after every `dispatch()` | |
| `_show_error(e)` | unwraps `DocumentLoadError.cause_error` via `stringify_cause` (module fn), shows via `alert()` → `ui/confirm.ts::alert_dialog` (themed modal, single OK button, user-dismissed — not an auto-timeout toast) | |
| `_download_blob/_download_pdf/_download_zip` | `URL.createObjectURL` → `<a download>` click → revoke after 10s | wired into `model.set_download_handlers` at construction |
| `_on_shortcut` | `Escape` always closes detail panel (checked before the Ctrl gate); else `Ctrl+{O,Enter,S,Z,Y,+,-,0}` map to load/apply/export/undo/redo/zoom | `window.keydown` |

---

## 12. `ui/canvas_view.ts` — `CanvasView` (316 lines)

`paint(snap: ViewSnapshot)`: sizes backing store to `devicePixelRatio` (HiDPI fix), draws bg → page image → overlay boxes (`_draw_overlay_box`, dashed frame + square handles + split badge) → rubber-band (`_draw_rubber_band`) if `draw_rect` set → enables/disables the hover ◀/▶ arrows by `position`/`total`. No status text drawn (spec-web §3) — only the bottom-right `_coords_el` DOM overlay, updated on every `pointermove` via `_update_coords`.

Pointer/page-coordinate mapping accounts for `crop_origin` (spec-web §6.8):
```
page_coord = crop_origin + (canvas_px − img_origin) / scale
```

| DOM event | Handler | Model call |
|---|---|---|
| `pointerdown` | `_on_down` | `model.begin_drag(px,py,(HANDLE_R+HANDLE_SLACK)/scale)` |
| `pointermove` | `_on_move` | updates coords readout always; `model.update_drag(px,py)` only while dragging |
| `pointerup` | `_on_up` | `model.end_drag()` |
| `contextmenu` (right-click) | `_cancel` (via `e.preventDefault`) | `model.cancel_drag()` |
| `Escape` (window keydown) | `_on_key` → `_cancel` | `model.cancel_drag()` |
| `wheel` (no Ctrl/Meta) | `_on_wheel` | `model.next_page()`/`prev_page()` |
| nav arrow click | `_make_arrow` closures | `model.prev_page()`/`next_page()` |

Theme colors (`_read_theme`) are re-read from `getComputedStyle` every paint — Canvas 2D fill/strokeStyle don't resolve `var()` themselves.

---

## 13. `ui/panels/*.ts` — sidebar cards

All four follow the identical shape: constructor builds `innerHTML` cards + `requireEl`-wires fields + registers listeners that call `ctrl.dispatch(...)`/`dispatch_job(...)`; `refresh(model,busy)` sets `.value`/`.checked`/`.disabled`/`.classList` unconditionally (no diffing), and guards text-input sync with `document.activeElement !== input` so it never clobbers an in-progress edit.

| Panel | Cards built | Key model calls |
|---|---|---|
| `pages_panel.ts` | doc-name card, Document & State, Pages to Process | `load_files` (dispatch_async), `set_pages_mode`, `set_select_pattern`, `set_current_follow` |
| `crop_panel.ts` | Split, Detect Text Borders (incl. Set offsets manual switch + L/T/R/B fields, spec-web §4.6), Actions | `set_split`, `set_same_size`, `detect_content` (dispatch_job), `set_anchor`×2, `set_keep_ratio`×2 (toggle + ratio field), `set_manual_offsets_on`, `set_manual_offset` (on blur/Enter, one closure per edge), `apply_crop`, `rotate_pages`, `delete_pages` (pre-checked against deleting every page → `ctrl.alert()`, else behind `ctrl.confirm()`) |
| `scan_panel.ts` | Scan Processing (hidden unless `mode===SCANNED`) | `run_dewarp`, `set_filter_mode`(BW/SHARPEN), `set_filter_strength` — **all three via `dispatch_job`**, not `dispatch`, since the toggle is eager-but-warms-cache under a `BatchJob` |
| `output_panel.ts` | Output Quality, Export | `set_compress_preset`, `set_custom_dpi`, `set_output_colours`, `set_export_format`, `export` (dispatch_job, via `suggested_export_name()`) |

`crop_panel.refresh` detail worth remembering: Auto-detect/Anchor L/T are only enabled when `split_count===1` (`detect_only` local) — split>1 has no single detect target.

`output_panel.refresh` detail worth remembering: the whole Output Quality card (`_quality_card`, stored as a field) is hidden AND its 3 controls (`_compress_sel`/`_custom_dpi_inp`/`_colours_sel`) disabled whenever `show_quality = model.mode===SCANNED || model.export_format!=='PDF'` is false — i.e. a NORMAL document exporting to PDF (spec-web §10.3). The Export card (format select + button) is never gated by this.

---

## 14. `ui/{detail_panel,settings_view,help_view,nav_bar,overlay}.ts`

- **`detail_panel.ts`** — third column, `show(panel)`/`hide()`, swaps `SettingsView`/`HelpView` visibility via `.hidden` toggle (both always mounted, never re-created). `refresh` only calls `settings.refresh` when `active==='settings'` (help has no dynamic state).
- **`settings_view.ts`** — 4 sections (Appearance/Output/Behaviour/Scan). Two field categories with different owners: `UIConfig` fields (theme/font/zoom) go through `AppController` setters; domain `Settings` fields (postfix/custom-dpi/paper/undo-depth/supersample) go through `AppModel` setters directly — **no single `apply_setting()` dispatcher**. Custom DPI here writes the *same* `settings.custom_dpi` the sidebar Output Quality card writes, and additionally force-switches `compress_preset` to `CUSTOM_DPI_PRESET`.
- **`help_view.ts`** — static `SECTIONS` array of hardcoded copy; Contents card buttons `scrollIntoView`; `render_body`/`escape_html` handle `\n\n`-paragraph / `\n`-linebreak formatting safely (no `innerHTML` injection of user data — all copy is a hardcoded literal).
- **`nav_bar.ts`** — pinned bar: Settings/Help row, Undo/Redo/Reset row, page-nav row (`< [n]/total >`). Page input `change` → `model.jump_to_output_page(n)`.
- **`overlay.ts`** — `ProgressOverlay`: `show(job,on_cancel)`/`update(done,total)`/`hide()`; only shown by `dispatch_job` when `job.total > 1`.

---

## 15. `app.css` (674 lines) — presentation only, no domain logic reads it

Flat stylesheet, BEM-ish naming 1:1 with each panel's `innerHTML` classes (`.panel-card`, `.card-header/-title`, `.btn/-primary/-secondary/-danger/-toggle/-seg/-group`, `.select/.text-input`, `.toggle-label` pill switches, `.offset-grid`, `.filter-group`, `.mode-badge--{normal,scanned}`, `.settings-*`, `.help-*`, `.overlay*`, `.drop-zone`, `.canvas-nav--{left,right}`, `.canvas-coords`) — `.error-toast` was removed (errors go through `.overlay__card` now, same as confirm dialogs). All colors via `var(--*)` custom properties injected by `theme.ts` (`DARK`/`LIGHT` tables) — no hardcoded hex in the component rules themselves except the `:root` structural block (line 1–40, explicitly "never overridden by theme.ts"). No media queries / responsive breakpoints present anywhere in the file.

---

## 16. Cross-cutting flow traces

**16.1 Drag lifecycle by kind** (all via `canvas_view.ts` pointer handlers → `model.begin/update/end/cancel_drag`):

| Kind | begin | live update | on release | on cancel |
|---|---|---|---|---|
| `draw` | outside any window/committed-crop, or split>1 origin miss | rubber-band, clamped to committed box if any | validate min size → optional ratio-normalise → `history.push` → `_drawn` | nothing to restore (window never committed) |
| `auto` | handle-hit on the live auto-crop rect | `apply_handle_drag`→optional ratio→writes `document.offsets` | *(nothing extra — already live-committed)* | restore `offsets0` |
| `split` | handle-hit on a `crop_rects[i]` | `apply_handle_drag`→live ratio-anchored→same-size mirror if resize | *(nothing extra)* | restore ALL `rects0` |
| `drawn` | handle/interior-hit on existing `_drawn` | `apply_handle_drag`→live ratio-anchored | *(nothing extra)* | restore `rect0` |

**16.2 Scan pipeline + three-tier RAM cache** (`page_raster_pipeline.ts::get_work(p)`, no disk tier —
per-page rasters are RAM-only, §7) — RAM hit → return; NORMAL mode or no-op intent → alias to
`get_source(p)` (never double-cached, avoids double-`close()`); SCANNED + real intent: resolve
dewarp and filter as two separate cached steps — a dewarp-only call
(`get_work_image(src,{dewarp:true,filter:null},supersample)`) cached in `_dewarped_versions`
(keyed by rotation+supersample only), then, if a filter is also requested, a filter-only call
on that dewarped bitmap cached in `_work_versions` under the full intent key. Dewarp-only intents
return the `_dewarped_versions` entry directly rather than double-caching it (§9a).

**16.3 Detect flow** — NORMAL page: `loader.ts::detect_text_box` (text-layer union, no raster) first; only falls back to `_get_source(p)` + `imaging.ts::detect_content_async` (raster/Sauvola) if the text box is null/degenerate. SCANNED page: raster path only, and always against the **raw source**, never the dewarped/filtered work image (detect's `<100ms` budget depends on this — spec-web §16).

**16.4 Export flow** — `export(filename)` → `_render_export_pages` (per page: `_get_work` → boxes → `adapter.render_output_image` at `_resolved_target_long_px()`) → `PDF`: `adapter.export_pdf` → `_download_pdf`; `JPG/PNG/TIFF`: `adapter.export_images` → single zip → `_download_zip`. Both worker calls transfer bitmaps, not clone.

**16.5 Rotate/Delete side effects** — Rotate: undoable (history.push), reads `_page_dims` before mutating rotation, rotates stored boxes, invalidates that page's output-preview cache only — rotation is part of every raster cache's key (source/dewarped/work), so the new angle simply resolves to a different, uncomputed entry rather than needing an explicit evict — resets offsets, rebuilds union. Delete: **not** undoable (`history.clear()`), reindexes per-page maps, rebuilds `_page_map` **before** rebuilding union (ordering matters — union math reads dims through `_page_map`), and wholesale-clears every raster cache (`clear_ram()`) since delete shifts logical page numbers and every cache key would otherwise address the wrong page.

**16.6 Undo/Redo** — both clear only the output-preview cache + invalidate `_current_bitmap`; the source/dewarped/work raster caches are content-addressed per page (keyed by rotation/intent, not by history position) and are deliberately left alone — whatever state Undo/Redo lands on simply resolves to its own entry, a hit if still within `undo_depth` reach.

---

## 17. Gotchas worth remembering before editing

1. **`_current_bitmap` double-close guard** — every LRU `onEvict`/`onCapacityEvict` in `model.ts` checks `b !== this._current_bitmap` before calling `.close()`. Any new cache added later must repeat this check or risk "image source is detached" crashes on the on-screen bitmap.
2. **NORMAL-mode work/source aliasing** — `_get_work` returns `_get_source`'s bitmap directly for NORMAL pages (no separate work-cache entry). Don't add work-cache-only logic without accounting for this alias.
3. **`_page_map` is the delete-reindex boundary** — every adapter call site translates a logical index through `_page_map` first (`orig = this._page_map[p] ?? p`). A new per-page adapter call must do the same translation or will silently address the wrong original page after a delete.
4. **`_page_dims(p)` is the only correct page-size source** — never read `doc.page_sizes[p]` directly; it doesn't account for rotation swap.
5. **Ordering bugs already fixed once, easy to reintroduce**: rotate/delete must read pre-mutation dims before mutating rotation; `delete_pages` must rebuild `_page_map` before rebuilding `union`; `set_keep_ratio`'s off→on check must capture `was_off` **before** assigning `_keep_ratio`.
6. **`move` never propagates in same-size split mode** — this is a deliberate, explicit exclusion (spec-web §6.6). Don't "fix" it to mirror on move.
7. **Committed-page drag never resizes the crop** — any drag on a committed (split=1) page always starts a NEW `draw` window (spec-web §6.3); there is no `crop_edit` drag kind. If a task asks for "let me resize the committed crop directly," that's a spec change, flag it before implementing.
8. **Preview is never DPI/greyscale-adjusted** — `_prerender_output_views` hardcodes `target_dpi=null, greyscale=false`. Only `_render_export_pages` uses the resolved settings. Don't merge these call sites without re-reading spec-web §10.1.

---

## 18. `AppModel` decomposition (implemented)

`model.ts` was 1085 lines before this decomposition; it is now exactly 600 lines (the project's
file-size limit) after extracting 8 collaborators. Facade signatures are unchanged throughout —
`ui/` still calls the same public methods (see ARCHITECTURE.md §5, kept current there and not
duplicated here), every existing test using AppModel's public interface stayed green through the
extraction. LOC below is `wc -l` on the current file.

| Collaborator | LOC | Owns (state) | Absorbs (methods) | Depends on |
|---|---|---|---|---|
| `PageIndexMap` | 20 | index translation map | `remove(sorted)`, `reset(count)`, `orig(p)` | nothing |
| `PageRasterPipeline` | 237 | source/work/output caches, disk-tier bookkeeping, current bitmap | raster fetch/cache/prefetch | adapter, `PageIndexMap`, a `page_dims(p)` fn |
| `CropController` | 465 | drag state machine, anchors/offsets/keep-ratio/split/same-size | anchor/offset/split/drag gesture methods + `compute_crop_boxes_for_page` (crop-commit box resolution — added after the original 7-step plan, to reach the line limit) | `document`, `history`, `geometry.ts`, live detection-state reads |
| `PageOpsService` | 118 | none new | rotate/delete | `document`, `PageIndexMap`, `PageRasterPipeline`, `geometry.ts` |
| `DetectionService` | 147 | none new | `detect_content` (Auto-detect) + union aggregation + committed-crop refresh | adapter, `PageRasterPipeline`, `PageIndexMap`, live crop-state reads |
| `ScanProcessingService` | 94 | none new | dewarp/filter toggles + work-cache warming | `PageRasterPipeline`, `history`, `document.dewarp_on/filter_*` |
| `ExportService` | 176 | download handlers | `export`/vector export/`suggested_export_name` + target-DPI resolution (`_resolved_target_long_px`, moved in past the original plan) | adapter, `PageRasterPipeline`, `PageIndexMap` |
| `ViewSnapshotBuilder` | 152 | none new | `view_snapshot`/overlay-building/`live_auto_crop_for` — added after the original 7-step plan (which assumed extracting this wouldn't reduce coupling; it did, once everything else had already moved out) | `PageRasterPipeline`, `CropController`, live detection-state reads |

`model_types.ts` (105 lines) holds the pure type contracts (`RendererAdapter`, `DocInfo`,
`OutputPage`, `VectorExportPage`, `ViewSnapshot`, `OverlayBox`, `PageSize`), re-exported from
`model.ts` for every existing import site — no behavior, just relocated to stay under the limit.

**Stays on `AppModel`**: document lifecycle, navigation, pages selection, `apply_crop` (the
crop-commit orchestration — calls `CropController.compute_crop_boxes_for_page`), history wrapper,
output settings, `prepare_current_view` (async cache-warming ahead of a snapshot read), all plain
getters, and the `detect_cache`/`union`/`auto_active` detection-result fields themselves — read
live by `CropController`/`PageOpsService`/`DetectionService`/`ViewSnapshotBuilder` through each
collaborator's own context interface (the same "shared state stays on `AppModel`, exposed live,
not duplicated" pattern `PageRasterPipeline` established from step 1).

`Settings`-as-class (the original plan's optional 8th step) was not done — `AppModel`'s delegating
setters stayed as 1-liners; the line budget was met without it, and it would have touched every
`output_panel.ts`/`settings_view.ts` call site for no longer-necessary LOC saving.

The three duplicated context closures the original decomposition left behind (`document()`,
`page_dims(p)`, `current_page()` — independently re-declared in `CropController`'s and
`PageOpsService`'s constructor wiring) were unified into one shared object in `AppModel`'s
constructor, spread into every collaborator's context instead of retyped per collaborator.
