SMARTCROP PDF WEB — REMAINING WORK: MASTER LIST + TASK INDEX
============================================================
Generated from: the uploaded code review (smartcrop-review.md), the user's running bug/feature
list, and the A–J roadmap. NOTE: review line numbers are PRE-Batch-D and may be stale — every task
says "locate by symbol, verify against the attached code first; some items may already be fixed."

HOW TO USE
- One task = one fresh session (Claude Code or Cowork web). Upload only the files that task lists.
- Do tasks in order T0 -> T9. Commit after each. NEVER run two uncommitted tasks in parallel
  (they touch overlapping files: model.ts, geometry.ts, settings, spec-web).
- Each task file has: (1) files to attach, (2) what/where to fix, (3) spec updates, (4) test
  commands, (5) commit command, (6) notes.

SHARED RULES (apply to EVERY task — also repeated in each file)
- Read CLAUDE.md first. Root-cause fixes ONLY. No monkeypatching. Do NOT rewrite large parts of
  the code unless absolutely necessary. Prefer the smallest correct change.
- REUSE, don't duplicate. Many bugs were fixed in NORMAL mode but persist in SCANNED; 1/2/4-split
  paths diverge needlessly. Unify shared logic behind one code path; if you must special-case,
  say why. While in a file, FLAG any monkeypatch / duplication / over-complication / non-senior
  solution you see and append it to 99_FOUND_ISSUES.txt (create it) — do not silently fix outside
  the task's scope.
- Process order: update docs/SmartCrop_PDF_Specification_Web.md FIRST, THEN tests (TDD: write the
  failing test first, confirm it fails, then fix, confirm it passes), THEN code.
- Edit ONLY the files the task lists. If a fix needs another file, stop and note it.
- Ask before guessing on any ambiguity or spec conflict.

GATE (run all; must be green before "done")
  npx tsc --noEmit
  npx eslint src tests
  npx vitest run                      # if slow, shard: npx vitest run tests/core ;
                                       #   npx vitest run tests/ui tests/pdf ; npx vitest run tests/architecture.test.ts
  npx vite build
  npx playwright test                 # chromium; add --project=firefox if runnable
(Equivalent npm scripts may exist — check package.json "scripts"; `npm run build` = tsc+vite build.)

COMMIT (run from a NATIVE path — the FUSE mount blocks .git writes)
  cd /run/media/me/D/DOCS/Python/smartcrop-pdf-web && \
  rm -f .git/index.lock && git add -A && git reset -q .idea 2>/dev/null; \
  git commit -F - <<'MSG'
  <type>(<scope>): <summary>

  <body: what + why, review IDs / bug numbers covered>

  Gate: tsc 0; eslint 0; vitest <N>; vite build OK; playwright <M>.
  MSG

====================================================================
CONSOLIDATED BUG / FEATURE LIST  (ID legend: Cx/Hx/Mx/Lx = review; #n = user bug number)
====================================================================
CORRECTNESS / DATA-LOSS
  C1  Split change (and set_offset/commit_offsets/_begin_auto_drag/_begin_split_drag) mutate
      undoable DocumentState with NO history.push first; set_split also .clear()s applied ->
      committed crops destroyed, Ctrl+Z skips the loss.               [T1]
  H1  cancel_drag has no revert for 'split'/'drawn' drags -> cancelling a move/resize of an
      existing window drops it instead of restoring rect0.            [T1]
  M4  set_filter_strength missing the EmptySelectionError guard its siblings have.  [T1]
  C3  ensure_cv() concurrent-init race -> a clobbered caller's promise never resolves. [T4]
  M3  fetch_with_idb_cache caches without resp.ok -> a 404/500 permanently poisons the IDB
      model cache.                                                    [T4]
  C2  Preset-DPI export math divides crop_w(points) by src_dpi(200) not 72 -> ~0.36x labelled
      DPI. VERIFY: Batch D moved export to paper-based target_long_px; may be fixed/changed. [T3]

USER — NEW
  #1,#2  Split "same size" must mean SAME DIMENSIONS with INDEPENDENT positions: resizing one
         window resizes the others to match size (and ratio if set), but windows keep their own
         places and do NOT move symmetrically/together. Reject v1 positional-mirror AND v2
         directional-delta propagation.                              [T2]
  #3     Keep-ratio in 2-split breaks when a window's width exceeds 50% of the page.  [T2]
  #4     Scan mode (autodetect/filters/dewarp) still ~10x too slow; must be comparable to the
         desktop CPU build. Do NOT rely on WebGPU — the CPU/WASM path must be fast (SIMD).  [T4]
  #5     Autodetect status (normal mode) freezes, then jumps, then runs fast.  [T5]
  #6     Paper size selector A0–A6 + Custom (numeric field, like the custom-DPI field).  [T3]
  #7     Speed regression test: 200p native PDF + 10p scanned; capture a desktop reference once;
         print measured speed; pass if <=30% slower than reference.  [T4]
  #8     Remove "Output folder" from Settings (meaningless in the browser).  [T3]
  #9     Undo/redo depth options -> [1,2,4,8].                        [T3]
  #10    Prepared icon package — place + wire into index.html/build.  [T7]
  #11    Auto-detect OUTLIER TOLERANCE (new): detection_union W/H = the (N+1)-th LARGEST per-page
         width/height instead of always the max, so a few oversized pages don't inflate every crop.
         Settings preset [0,1,2,5,10] (N = pages to ignore; 0 = max = unchanged/desktop parity).  [T5]

INPUT / UX / REFACTOR (review)
  H3 nav_bar page input missing activeElement guard. H4 parse_slice seeds p=start (no
  Math.max(1,start)) -> tab freeze on "-999...:5". M1 zoom dropdown shows nearest preset not live
  %. M5 hand-rolled Error cause vs ES2022 Error.cause. M6 PageBatchJob controller unsafe cast +
  non-readonly done. M7 unused constants (PANEL_WIDTH/DETAIL_PANEL_WIDTH/CANVAS_MIN_WIDTH/
  STATUS_IDLE_MS/SCALE_THROTTLE_MS). L1 window.confirm. L2 root.children[1]. L3 THEMES-driven
  buttons + dead current_theme(). L4 view_to_source guard. L5 anchors not undoable. L6 main.ts
  dead AppController/destroy. L7 doc_state comment count. L8 icon-btn vs .btn-icon. L9
  nav-bar__row--top no CSS. L10 dead CSS selectors.                   [T6]

FEATURES / POLISH / VERIFY
  #19 tooltips on every control. #20 rewrite Help to be correct/concise.  [T8]
  Offline auto-precache service worker (old task 5).                  [T7]
  Docs reconciliation: M8/M9 status-text contradiction; spec-web vs CLAUDE.md vs ARCHITECTURE.md
  overlaps; mark fixed/spotted. CODE + this list are the source of truth, the spec is ahead.  [T0]
  Final coherence pass + full gate + real-browser verification.        [T9]

CROSS-CUTTING (call out in EVERY task)
  * Normal-vs-scanned parity: reuse the same gesture/crop/keep-ratio/history logic in both modes.
  * 1/2/4-split unification: one parametrised path, not three.
  * Status bar (page/size) already REMOVED in D -> review H2/M2/M8/M9 are largely moot; verify.

TASK INDEX
  T0  docs reconciliation (spec-web / CLAUDE.md / ARCHITECTURE.md)      -> 01_docs_reconciliation.txt
  T1  undo/history correctness (C1,H1,M4,L5)                            -> 02_undo_history.txt
  T2  split same-size v3 + keep-ratio wall (#1,#2,#3)                   -> 03_split_samesize_keepratio.txt
  T3  export sizing + output settings (C2,#6,#8,#9)                     -> 04_export_paper_settings.txt
  T4  scan perf: SIMD + speed test + CV robustness (#4,#7,C3,M3)        -> 05_scan_perf_simd.txt
  T5  auto-detect: progress freeze/jump (#5) + outlier tolerance (#11) -> 06_autodetect.txt
  T6  input robustness + refactor/cleanup (H3,H4,M1,M5,M6,M7,L1–L10)   -> 07_input_and_cleanup.txt
  T7  icons/favicon + offline precache (#10, offline)                  -> 08_icons_offline.txt
  T8  tooltips + help rewrite (#19,#20)                                 -> 09_tooltips_help.txt
  T9  final coherence + full gate + browser verify (J)                 -> 10_final_gate.txt
