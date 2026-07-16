CLAUDE.md — SmartCrop PDF Web

## Source of truth
docs/SmartCrop_PDF_Specification_Web.md is the behaviour contract. Any behavior change requires
updating the relevant spec FIRST, then tests, then code — in that order.
ARCHITECTURE.md is mechanism only (module layout, build/test/deploy) — if a fact describes what
the user experiences, it belongs in a spec doc, not there.
docs/app_design_screenshots/ is the UI reference — it does not replace spec-web, it constrains
how spec-web's described controls are laid out and styled.

## Gates — must pass before any step is marked done
`tsc --noEmit && eslint src && vitest run --coverage --reporter=verbose && playwright test`,
all in one line, plus `vite build` succeeding and producing a working dist/. If any fails, the
step is not done — do not update the ARCHITECTURE.md status table to "Implemented" until it
passes. See "Verify, don't trust" under Process — it governs every claim of gate-green status too.

## Hard rules (mechanical — not principles)
- core/ never imports window, document, Worker, pdfjs-dist, or pdf-lib — enforced by
  tests/architecture.test.ts (exists, wired into `vitest run`, negative-tested — confirmed).
- Dependency direction is one-way: core/ → pdf/ + workers/ → ui/ → main.ts. core/ never imports ui/.
- Every AppModel public method has ≥1 test that uses only the public interface. No assertions on
  private fields (model._document, model._drag, etc.).
- No function over 30 lines without a why-comment explaining why it cannot be split.
- No magic numbers inline — domain tunables in src/core/constants.ts, presentation tunables in
  src/ui/constants.ts.
- No god-like objects or files more than 600 lines of code.
- render_output_image() in pdf/loader.ts is the ONE raster image path for preview (both modes) and
  for export whenever export rasterizes: SCANNED mode always, NORMAL mode for JPG/PNG/TIFF. It is
  NOT used for NORMAL-mode PDF export, which produces no raster at all — see export_pdf_vector
  below. Never add a second raster path; a second non-raster output path (vector PDF assembly) is
  the one documented exception.
- Only export.worker.ts is a real Web Worker. PDF.js (loader.ts), OpenCV.js (imaging.ts), and
  pdf-lib's vector PDF assembly (loader.ts::export_pdf_vector) run on the main thread — the source
  PDFDocumentProxy objects export_pdf_vector needs cannot cross to a Worker, and none of the three
  involve image-codec work of the kind export.worker.ts exists to offload. PDF.js/OpenCV.js were a
  deliberate reversal after both proved incompatible with dedicated Worker context; see
  ARCHITECTURE.md §7a before "fixing" any of this back to a worker.
- ONNX execution providers: ['webgpu','wasm'], gated on navigator.gpu, ort.env.wasm.numThreads = 1.
  No SharedArrayBuffer dependency — required because GitHub Pages cannot set COOP/COEP headers.
  Do not reintroduce threaded WASM without solving the Pages header constraint first.
- TIFF export IS supported via a hand-rolled baseline encoder (src/workers/tiff.ts, uncompressed
  8-bit RGB single strip). Image exports (JPG/PNG/TIFF) deliver ONE .zip (fflate, in
  export.worker.ts), not N loose files — never reintroduce per-page loose downloads or a
  "TIFF excluded" claim.
- DocumentState's undoable field set is exactly 8 fields (document_state.ts) — applied, crop_rects,
  rotation, processed, offsets, dewarp_on, filter_mode, filter_strength. detect_cache/union/
  auto_active/drawn are non-undoable AppModel fields, not DocumentState fields — do not add them
  back to DocumentState, and do not assume Undo reverts them.
- GitHub Pages deploy risk: Vite `base` path misconfiguration and WASM asset MIME/header
  requirements (OpenCV.js, ONNX Runtime, §18) are known failure modes on GH Pages. A local build
  succeeding is not sufficient evidence the deploy will work — verify against the actual Pages
  output, not just dist/.

## Architecture
See ARCHITECTURE.md for the dependency graph, worker/build/deploy mechanism, and state split;
docs/smartcrop_web_function_map.md for the per-file function/line-number map — that file is the
canonical function reference, do not duplicate its tables here or in ARCHITECTURE.md.
Target layout: src/core (pure TS), src/pdf (PDF.js + pdf-lib adapters, main thread), src/workers
(export.worker.ts only), src/ui (DOM/canvas/panels), tests/{core,ui,e2e,fixtures}.

AppModel public interface, ViewSnapshot fields, BatchJob protocol: full signatures live in
ARCHITECTURE.md — §5 (AppModel), §5a (ViewSnapshot, incl. crop_origin/is_loading), §6 (BatchJob) —
kept current there, not duplicated here. Read ARCHITECTURE.md §5 instead of loading all of
core/model.ts into a session.

## Process
- Read CLAUDE.md + the ≤6 files actually needed for the task. Never load the whole codebase into
  a single session. Prefer reading parts of files if possible. Never rewrite whole files, just the
  necessary parts.
- Root-cause fixes only. No monkeypatching, no papering over a symptom to make a test/gate pass.
  Prefer the smallest correct change over rewriting large parts of the code.
- Reuse, don't duplicate: a bug fixed in NORMAL mode but left broken in SCANNED, or three
  near-copies of a split-count-conditional path, is a defect even if each copy individually works.
  Unify shared logic behind one code path; if a real special-case is unavoidable, say why in a
  comment. If you spot a monkeypatch, duplication, over-complication, or non-senior solution while
  in a file for an unrelated reason, flag it to the user rather than silently fixing it outside the
  current task's scope (or silently leaving it).
- Ask before guessing on any real ambiguity or spec conflict — a wrong guess compounds across
  everything built on top of it; a clarifying question costs one turn.
- Bug reports: diagnose root cause before fixing when the cause is ambiguous between two plausible
  sites (e.g. core/ math vs pdf/ adapter vs ui/ event handling).
- After any fix: re-verify all §21 acceptance invariants (spec-web.md), not just the one related
  to the bug.
- Spec violations and correctness issues flagged directly — no softening or hedging. State
  confidence explicitly on non-obvious diagnoses: [high]/[med]/[low]. Every confidence claim needs
  a source: a test, a citation, or an explicit "unverified."
- **Verify, don't trust** (the one rule behind every status/number in this project): a "gate green"
  claim in a commit message or doc, an ARCHITECTURE.md/spec-web "Implemented"/"verified" claim, a
  tracker's DONE/open entry, or any line-count/coverage number is not evidence on its own — re-run
  the check yourself in the same session before relying on or propagating it, and correct the doc
  as part of the work, not as a followup. Do not rewrite spec or ARCHITECTURE.md prose unrelated to
  the change, except a status claim verified false.
- New behaviour → unit test for the pure part first (tests/core/); e2e test in tests/e2e/ if it
  spans DOM/canvas/worker boundaries.
- Before writing a helper: grep for an existing one, then check for a native/platform op, then
  write it. Make both directions of a symmetric operation (encode/decode, get/set) agree.
- Run a cleanup pass ("what can be deleted") separately from the feature pass.
- Don't chain unrelated tasks in one long session — clear context between them.
- After two failed correction attempts on the same bug, stop correcting — restart with what was
  learned instead of patching again.
- For a one-sentence change, skip planning overhead and edit directly; plan explicitly only for
  multi-file or unfamiliar-area changes.
- Commit after every gate-passing step, from a native filesystem session (see Environment
  constraints above) — paste the gate output in the commit body.

## Coherence checks — run at phase boundaries only
After the build is deployable and the gate is green, and before any public release. Feed the
review loop these questions across the full codebase:
- Every function over 30 lines in core/ and ui/: is it doing one thing?
- Every pair of functions across files doing the same thing differently.
- Every public method on AppModel the UI never calls.
- Every place core/ and ui/ share a concept under different names.
- Every test asserting on private fields instead of AppModel's public interface.
- Every ImageBitmap/canvas resource not released (LRU eviction, export streaming, §17).

## Anti-patterns to catch (smell → fix)
- Legacy-driven decisions not tied to current need.
- Over-complication: abstraction or config with no real requirement behind it.
- Repetitive code, or a defensive check duplicated more than twice → extract one helper.
- Reimplementing a native/stdlib/already-installed-dependency feature.
- Dead variables, useless double-checks, obvious inefficiencies.
- Code following a stale spec line or a misread requirement.
- Assumptions about platform/library support or behavior stated as fact with no check.
- Low-effort filler with no value.
- Defensive code for states the type system or environment already rules out.
- Backward-compatibility paths nobody requires.
- Tracker/doc status that doesn't match the code, in either direction — see "Verify, don't trust".
- Comments narrating fix history instead of documenting current behavior → a comment citing an
  external fact (line number, bug ID, spec section) is state, not narration: update or delete it
  in the same edit as the code it describes; prefer citing stable content over a row/section
  number that can be renumbered.
- Invented APIs, facts, or citations.
- Hot paths using the slow approach when a fast one was available.
- Per-element allocation inside a loop over a large array → check whether one allocation outside
  the loop, or one view over the existing buffer, replaces it.
- Full-cost refresh triggered by a high-frequency event (pointermove, scroll, resize) with no
  throttle → throttle/debounce it, or scope the refresh to only what that event can change.
- A yield/cooperative-scheduling point gated on item count instead of elapsed time → gate it on
  elapsed time.
- God objects: files/classes over the size limit, or a decomposition that moves logic out but
  leaves the state and the line count behind.
- A UI element repainting a static component (e.g. a full image) just to move a small overlay →
  separate the static and dynamic parts onto separate layers/canvases.

## Before marking a step done
- `wc -l` every touched file — flag anything over the project limit, or >15% larger than before
  with no proportional new feature.
- Grep the diff's new function/helper names against the rest of the repo for an existing
  equivalent.
- Re-derive every checkable number/claim in every touched doc from the current code, same session
  (line counts, coverage, Implemented/verified, tracker DONE/open — see "Verify, don't trust").
- Grep new code for: magic numbers outside `constants.ts`, comments citing another codebase's
  file/line, new `TODO`/`FIXME`, duplicated error-message strings, per-element allocation in a hot
  loop, un-throttled high-frequency-event handlers, full-cost repaint of static content.
- Ask explicitly what in the diff can be deleted without changing behavior, before considering it
  done.

## Style
Senior-level, compact. Less code is better. No explanatory preamble. No bullet lists unless the content is genuinely
enumerable. Numbers over adjectives. Confidence calibrated explicitly.
