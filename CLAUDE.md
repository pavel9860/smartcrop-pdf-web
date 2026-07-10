CLAUDE.md — SmartCrop PDF Web

Current state (read this before anything else)
HEAD is GREEN, verified 2026-07-10 (T3 export-sizing/output-settings pass, after the T2 same-size
v3/v2-restore pass — see 99_FOUND_ISSUES.txt item 7 for that design history/reversal): `tsc
--noEmit` is 0 errors. `vitest run`: 374/377 passing, 3 failures, all in
`tests/core/detect_union.test.ts` (a union-rebuild-after-rotate/delete regression, and a
NORMAL-mode text-layer-vs-ink-path detection contradiction; both unresolved, see
99_FOUND_ISSUES.txt item 2). `eslint src tests` is clean. `vite build` succeeds. `playwright test`:
14/14 passing (chromium + firefox; smoke/crop_split/committed_window). T3 verified export sizing
is paper-based (C2, locked by a new `tests/pdf/loader.test.ts` test against the real
`render_output_image` math, not just the mock target_long_px parameter); added `PAPER_SIZES`
Custom entry (`settings.custom_paper_in`, reveals like Custom DPI via the new shared
`ui/dom.ts:syncCustomReveal()`); set `UNDO_DEPTH_OPTIONS = [1,2,4,8]` (was `[2,4,10,20,50]`);
removed the dead `Output folder` setting end to end (T2's continuation task). Red still: vitest run
--coverage (ui/ and pdf/ below threshold on some files) — not touched this pass.
Do not trust a "gate green" claim in an old commit message without re-running it —
commit 9cf743d claimed "344 unit + 7 e2e green" while already shipping the tsc-breaking import
above; every prior doc test-count (319/319, 349/349) inherited that false claim uncorrected.
Do not trust any older ARCHITECTURE.md/spec-web claim not yet corrected against this —
verify every "Implemented"/"verified" row yourself before relying on it, and correct the doc as
part of the work, not as a followup. Dewarp specifically is NOT a stub: full two-stage ONNX
pipeline, verified end-to-end against the actual model files (io names/shapes/dtypes match,
output is non-identity), wired button→AppModel→ensure_onnx→apply_dewarp. Any doc still calling
it a "no-op" is stale.

UI ground truth
docs/app_design_screenshots/ contains the desktop app's screens across its different mode
workflows. This — not spec prose, not memory of the desktop app — is the ground truth for UI
parity. Before touching any file in src/ui/, read every screenshot in that folder relevant to
the panel/mode being changed. If a needed state isn't covered there, stop and ask; do not infer
desktop layout, icon set, or control grouping from spec-web's prose description alone.

Environment constraints (mechanical — verified this session, not hypothesis)
This repo, as connected, sits on a mount where cross-boundary writes are not atomic: git's
`.git/index.lock` cannot be removed (`unlink` forbidden), and rewriting a file in place can
truncate it mid-write (this has hit package.json, vite.config.ts, and tests output files —
symptom: `.fuse_hidden*` orphan files in the tree, or a file ending mid-token/mid-comment).
Consequence: git commits cannot run from a sandboxed session on this mount, and any file write
must be verified (re-read after write) before being trusted.
Fix, apply once: operate on a native Linux path (WSL home, not a /mnt/c-style path) for any
session that needs to commit. Once on a native path, commits should happen automatically after
every gate-passing step — this section exists so that requirement doesn't collide with the mount
bug again. If still on the Windows-mounted path, do not assume a write succeeded; re-view the
file after writing, and do not attempt git add/commit — hand those back to the user with the
exact files changed.
`node_modules/.bin/*` (tsc, eslint) can lose their executable bit on this mount — `npx tsc`/
`npx eslint` then fail (`Permission denied`, or eslint silently falls back to a stray global
install missing the flat config). Verified 2026-07-10. Workaround: `node node_modules/typescript/
bin/tsc` / `node node_modules/eslint/bin/eslint.js` (same args). Fix the bit with `chmod +x` if
the write survives the mount; don't assume `npx <tool>` failing means the tool itself is broken.

Source of truth
docs/SmartCrop_PDF_Specification.md is the canonical, platform-agnostic behavioral contract —
copied verbatim from the desktop repo, unchanged for web, and FROZEN — never edit it.
docs/SmartCrop_PDF_Specification_Web.md is the web-only supplement (every point where the browser
forces a real deviation, plus browser-only behavior the desktop has no equivalent of). Code
conforms to both, not the reverse. Any behavior change requires updating the relevant spec FIRST,
then tests, then code — in that order. ARCHITECTURE.md is mechanism only (module layout, build/
test/deploy) — if a fact describes what the user experiences, it belongs in a spec doc, not there.
docs/app_design_screenshots/ is the UI ground truth (see above) — it does not replace spec-web,
it constrains how spec-web's described controls are laid out and styled.

Gates — must pass before any step is marked done
tsc --noEmit && eslint src && vitest run --coverage --reporter=verbose && playwright test
All four in one line, plus `vite build` succeeding and producing a working dist/. If any fails,
the step is not done — do not update the ARCHITECTURE.md status table to "Implemented" until it
passes.

Hard rules (mechanical — not principles)
core/ never imports window, document, Worker, pdfjs-dist, or pdf-lib — enforced by
tests/architecture.test.ts (exists, wired into `vitest run`, negative-tested — confirmed).
Dependency direction is one-way: core/ → pdf/ + workers/ → ui/ → main.ts. core/ never imports ui/.
Every AppModel public method has ≥1 test that uses only the public interface. No assertions on
private fields (model._document, model._drag, etc.).
No function over 30 lines without a why-comment explaining why it cannot be split.
No magic numbers inline — domain tunables in src/core/constants.ts, presentation tunables in
src/ui/constants.ts.
render_output_image() in pdf/loader.ts is the ONE image path for preview and export (WYSIWYG,
spec §8.3/§22.12). Never add a second rendering path.
Only export.worker.ts is a real Web Worker. PDF.js (loader.ts) and OpenCV.js (imaging.ts) run on
the main thread — this was a deliberate reversal after both proved incompatible with dedicated
Worker context; see ARCHITECTURE.md §7a before "fixing" this back to a worker.
ONNX execution providers: ['webgpu','wasm'], gated on navigator.gpu, ort.env.wasm.numThreads = 1.
No SharedArrayBuffer dependency — required because GitHub Pages cannot set COOP/COEP headers.
Do not reintroduce threaded WASM without solving the Pages header constraint first.
TIFF export IS supported (added 2026-07-03) via a hand-rolled baseline encoder
(src/workers/tiff.ts, uncompressed 8-bit RGB single strip). Image exports (JPG/PNG/TIFF) deliver
ONE .zip (fflate, in export.worker.ts), not N loose files — never reintroduce per-page loose
downloads or a "TIFF excluded" claim.
Known desktop bug, already fixed there, must not be reintroduced here: split=1, left-click-drag
still magnifying the page, root cause was self._scale. Verify canvas_view.ts's drag/scale handling
carries the equivalent fix before treating split=1 drag as working.
confirm_overwrite (spec §13) depends on the File System Access API, which is Chromium-only. Do
not report this control as working without stating the Safari/Firefox behavior explicitly.
GitHub Pages deploy risk: Vite `base` path misconfiguration and WASM asset MIME/header
requirements (OpenCV.js, ONNX Runtime, §18) are known failure modes on GH Pages. A local build
succeeding is not sufficient evidence the deploy will work — verify against the actual Pages
output, not just dist/.

Architecture
See ARCHITECTURE.md for the file map, dependency graph, and state split. Target layout is
src/core (pure TS), src/pdf (PDF.js + pdf-lib adapters, main thread), src/workers (export.worker.ts
only), src/ui (DOM/canvas/panels), tests/{core,ui,e2e,fixtures}.

AppModel public interface, ViewSnapshot fields, BatchJob protocol
Full signatures live in ARCHITECTURE.md — §5 (AppModel), §5a (ViewSnapshot, incl. crop_origin/
is_loading), §6 (BatchJob) — and are kept current there, not duplicated here: this block's own
copy drifted stale twice (missing set_paper_size/set_custom_dpi/paper_size/custom_dpi/
document_name; a phantom is_finished() on BatchJob that doesn't exist in src/core/batch.ts).
In Step 4+ sessions: read ARCHITECTURE.md §5 instead of all of core/model.ts.

Process
Read CLAUDE.md + the ≤6 files actually needed for the task. Never load the whole codebase into a
single session.
Bug reports: diagnose root cause before fixing when the cause is ambiguous between two plausible
sites (e.g. core/ math vs pdf/ adapter vs ui/ event handling).
After any fix: re-verify all §22 invariants (spec doc), not just the one related to the bug.
Spec violations and correctness issues flagged directly — no softening or hedging.
State confidence explicitly on non-obvious diagnoses: [high]/[med]/[low].
Do not rewrite spec or ARCHITECTURE.md prose unrelated to the change, except the status table when
its claim is verified false. Never edit SmartCrop_PDF_Specification.md (frozen).
New behaviour → unit test for the pure part first (tests/core/); e2e test in tests/e2e/ if it
spans DOM/canvas/worker boundaries.
Commit after every gate-passing step, from a native filesystem session (see Environment
constraints above) — paste the gate output in the commit body.

Coherence checks — run at phase boundaries only
After the build is deployable and the gate is green, and before any public release. Feed the
review loop these questions across the full codebase:
Every function over 30 lines in core/ and ui/: is it doing one thing?
Every pair of functions across files doing the same thing differently.
Every public method on AppModel the UI never calls.
Every place core/ and ui/ share a concept under different names.
Every test asserting on private fields instead of AppModel's public interface.
Every ImageBitmap/canvas resource not released (LRU eviction, export streaming, §17).

Style
Senior-level, compact. No explanatory preamble. No bullet lists unless the content is genuinely
enumerable. Numbers over adjectives. Confidence calibrated explicitly.