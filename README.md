# SmartCrop PDF Web

A browser app to combine, crop, straighten, clean and compress PDFs, scans and images for reading
on e-readers, phones and tablets. Everything runs client-side — no server, no upload. Load one or
many files (PDFs and/or images) into a single working document, crop/filter/compress them, and
export as PDF or a chosen image format.

![SmartCrop PDF Web demo](docs/demo.gif)

*Split (2-way and 4-way), auto-detect content borders, and the Dewarp & Deskew pipeline
(deskew, de-trapezoid, B/W and Sharpen filters) — before/after on each.*

## Features

- **Load & combine**: multiple PDFs/images into one document, in picker order.
- **Crop**: auto-detect content, draw/drag a window, split a page into 2 or 4 output windows,
  same-size sync, keep-ratio lock.
- **Scanned-document processing**: Dewarp & Deskew (page curl, tilt, and keystone/trapezoid
  distortion, each corrected only when actually present — see below), B/W and Sharpen filters.
- **Rotate, delete, undo/redo**, per-page or batch.
- **Export**: PDF (vector when the source is native PDF, rasterized for scans), or JPG/PNG/TIFF as
  a single `.zip`. Configurable output DPI, paper size, and colour mode.
- **Offline-capable**: works after one online load; an explicit "Enable offline mode" setting
  pre-caches every model so scanned-mode features work offline immediately, not just whichever
  were already used.

### Dewarp & Deskew pipeline

A per-page classifier decides what a scanned page actually needs, so a page that's already correct
is never needlessly reprocessed:

1. **Warp classifier** (classic CV, no ML) — a cheap projection-profile search decides whether the
   page has real curl/fold that needs the full mesh-unwarp model, or not.
2. **Warped** → a two-stage ONNX model (UVDoc) removes curl/fold and any incidental skew in one
   pass.
3. **Not warped** → a lightweight text-line detector (DBNet, ONNX) plus a robust vanishing-point
   estimator (PROSAC → MSAC → IRLS) finds the page's actual skew angle and any keystone/trapezoid
   distortion, and corrects both through one unified remap — or leaves the page untouched if
   neither is present.

See `docs/SmartCrop_PDF_Specification_Web.md` §7 for the full behavioral spec.

## Tech stack

TypeScript, Vite, [pdf.js](https://mozilla.github.io/pdf.js/) (PDF rendering/text), 
[pdf-lib](https://pdf-lib.js.org/) (PDF assembly), [OpenCV.js](https://github.com/TechStark/opencv-js)
(classic CV), [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) (dewarp + text
detection models), [fflate](https://github.com/101arrowz/fflate) (zip export).

## Development

```sh
npm install
npm run dev          # dev server
npm run build        # typecheck + production build
npm test             # unit tests + coverage
npm run test:perf    # perf/correctness suite against real OpenCV.js (opt-in, machine-dependent)
npm run test:e2e     # Playwright, real browser
npm run lint         # eslint
npm run ci           # everything typecheck/lint/unit/e2e runs in CI
```

## Documentation

- `docs/SmartCrop_PDF_Specification_Web.md` — the behavioral contract (what the user experiences).
  Any behavior change updates this file first, then tests, then code.
- `ARCHITECTURE.md` — mechanism: module layout, dependency graph, build/test/deploy.
- `docs/smartcrop_web_function_map.md` — per-file function/line-number reference.
- `CLAUDE.md` — working conventions for this repo (process, gates, anti-patterns).

## Deploy

GitHub Actions builds and publishes `dist/` to GitHub Pages on push to `main` (see
`.github/workflows/deploy.yml`). The site deploy depends only on typecheck + unit tests + build; the
Playwright e2e suite runs as a separate, parallel quality job.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the local test gate,
and PR expectations. This project follows a [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[Apache License 2.0](LICENSE).
