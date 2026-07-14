CLAUDE.md — SmartCrop PDF Web


Source of truth
docs/SmartCrop_PDF_Specification_Web.md is the behaviour contract.
Any behavior change requires updating the relevant spec FIRST, then tests, then code — in that order.
ARCHITECTURE.md is mechanism only (module layout, build/
test/deploy) — if a fact describes what the user experiences, it belongs in a spec doc, not there.
docs/app_design_screenshots/ is the UI reference — it does not replace spec-web,
it constrains how spec-web's described controls are laid out and styled.

Gates — must pass before any step is marked done
tsc --noEmit && eslint src && vitest run --coverage --reporter=verbose && playwright test
All four in one line, plus `vite build` succeeding and producing a working dist/. If any fails,
the step is not done — do not update the ARCHITECTURE.md status table to "Implemented" until it
passes. A "gate green" claim in a commit message or doc is not evidence — re-run the gate yourself
before trusting a done status; do not propagate a pass/fail count you have not personally run.

Hard rules (mechanical — not principles)
core/ never imports window, document, Worker, pdfjs-dist, or pdf-lib — enforced by
tests/architecture.test.ts (exists, wired into `vitest run`, negative-tested — confirmed).
Dependency direction is one-way: core/ → pdf/ + workers/ → ui/ → main.ts. core/ never imports ui/.
Every AppModel public method has ≥1 test that uses only the public interface. No assertions on
private fields (model._document, model._drag, etc.).
No function over 30 lines without a why-comment explaining why it cannot be split.
No magic numbers inline — domain tunables in src/core/constants.ts, presentation tunables in
src/ui/constants.ts.
No god-like objects or files more then 600 lines of code.
render_output_image() in pdf/loader.ts is the ONE raster image path for preview (both modes) and
for export whenever export rasterizes: SCANNED mode always, NORMAL mode for JPG/PNG/TIFF. It is
NOT used for NORMAL-mode PDF export, which produces no raster at all — see export_pdf_vector below.
Never add a second raster path; a second non-raster output path (vector PDF assembly) is the one
documented exception.
Only export.worker.ts is a real Web Worker. PDF.js (loader.ts), OpenCV.js (imaging.ts), and
pdf-lib's vector PDF assembly (loader.ts::export_pdf_vector) run on the main thread — the source
PDFDocumentProxy objects export_pdf_vector needs cannot cross to a Worker, and none of the three
involve image-codec work of the kind export.worker.ts exists to offload. PDF.js/OpenCV.js were a
deliberate reversal after both proved incompatible with dedicated Worker context; see
ARCHITECTURE.md §7a before "fixing" any of this back to a worker.
ONNX execution providers: ['webgpu','wasm'], gated on navigator.gpu, ort.env.wasm.numThreads = 1.
No SharedArrayBuffer dependency — required because GitHub Pages cannot set COOP/COEP headers.
Do not reintroduce threaded WASM without solving the Pages header constraint first.
TIFF export IS supported via a hand-rolled baseline encoder
(src/workers/tiff.ts, uncompressed 8-bit RGB single strip). Image exports (JPG/PNG/TIFF) deliver
ONE .zip (fflate, in export.worker.ts), not N loose files — never reintroduce per-page loose
downloads or a "TIFF excluded" claim.
DocumentState's undoable field set is exactly 8 fields (document_state.ts) — applied, crop_rects,
rotation, processed, offsets, dewarp_on, filter_mode, filter_strength. detect_cache/union/
auto_active/drawn are non-undoable AppModel fields, not DocumentState fields — do not add them
back to DocumentState, and do not assume Undo reverts them.
GitHub Pages deploy risk: Vite `base` path misconfiguration and WASM asset MIME/header
requirements (OpenCV.js, ONNX Runtime, §18) are known failure modes on GH Pages. A local build
succeeding is not sufficient evidence the deploy will work — verify against the actual Pages
output, not just dist/.

Architecture
See ARCHITECTURE.md for the dependency graph, worker/build/deploy mechanism, and state split;
docs/smartcrop_web_function_map.md for the per-file function/line-number map — that file is the
canonical function reference, do not duplicate its tables here or in ARCHITECTURE.md.
Target layout is src/core (pure TS), src/pdf (PDF.js + pdf-lib adapters, main thread), src/workers (export.worker.ts
only), src/ui (DOM/canvas/panels), tests/{core,ui,e2e,fixtures}.

AppModel public interface, ViewSnapshot fields, BatchJob protocol
Full signatures live in ARCHITECTURE.md — §5 (AppModel), §5a (ViewSnapshot, incl. crop_origin/
is_loading), §6 (BatchJob) — kept current there, not duplicated here. Read ARCHITECTURE.md §5
instead of loading all of core/model.ts into a session.

Process
Read CLAUDE.md + the ≤6 files actually needed for the task. Never load the whole codebase into a
single session. Prefer even read parts of files if possible. Never rewrite whole files, just necessary parts.
Root-cause fixes only. No monkeypatching, no papering over a symptom to make a test/gate pass.
Prefer the smallest correct change over rewriting large parts of the code.
Reuse, don't duplicate: a bug fixed in NORMAL mode but left broken in SCANNED, or three near-copies
of a split-count-conditional path, is a defect even if each copy individually works. Unify shared
logic behind one code path; if a real special-case is unavoidable, say why in a comment. If you spot
a monkeypatch, duplication, over-complication, or non-senior solution while in a file for an
unrelated reason, flag it to the user rather than silently fixing it outside the current task's scope
(or silently leaving it).
Ask before guessing on any real ambiguity or spec conflict — a wrong guess compounds across
everything built on top of it; a clarifying question costs one turn.
Bug reports: diagnose root cause before fixing when the cause is ambiguous between two plausible
sites (e.g. core/ math vs pdf/ adapter vs ui/ event handling).
After any fix: re-verify all §21 acceptance invariants (spec-web.md), not just the one related to
the bug.
Spec violations and correctness issues flagged directly — no softening or hedging.
State confidence explicitly on non-obvious diagnoses: [high]/[med]/[low].
Do not rewrite spec or ARCHITECTURE.md prose unrelated to the change, except a status claim verified
false. Verify ARCHITECTURE.md/spec-web "Implemented"/"verified" claims against the actual code
before relying on them; correct the doc as part of the work, not as a followup.
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
