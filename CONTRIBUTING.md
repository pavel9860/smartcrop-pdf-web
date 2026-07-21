# Contributing to SmartCrop PDF Web

Thanks for your interest in contributing! This project is a browser-only, client-side PDF/scan
tool — no backend, no server component. This guide covers how to get set up and what's expected
of a change.

## Code of Conduct

This project follows a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you're expected to
uphold it.

## Getting started

```sh
npm install
npm run dev          # dev server (Vite)
```

The app is a static single-page app; open the printed local URL in a browser to try it.

## Before you open a PR

Run the full local gate — all of the following must pass:

```sh
npm run typecheck    # tsc --noEmit (app + worker tsconfig)
npm run lint          # eslint src tests
npm test              # vitest unit tests + coverage
npm run test:perf     # perf/correctness suite against real OpenCV.js (opt-in, machine-dependent)
npm run test:e2e      # Playwright, real browser
npm run build          # production build
```

If you're changing behavior a user can observe (not just internal refactoring), update
`docs/SmartCrop_PDF_Specification_Web.md` **first**, then tests, then code — that file is the
behavioral contract for this app, and PRs that change behavior without updating it will be asked
to add the doc update.

## Making changes

- Keep diffs focused — a bug fix shouldn't carry unrelated refactors or reformatting.
- Prefer fixing the root cause over adding a special case or a fallback that papers over the
  symptom.
- Add a test for new behavior: a unit test in `tests/core/` (or the relevant `tests/` subfolder)
  for pure logic, an e2e test in `tests/e2e/` if the change spans DOM/canvas/worker boundaries.
- No secrets, API keys, or personal data in commits — this is a public repo.
- No copyrighted book/document content in test fixtures — only public-domain or synthetic
  material.

See `CLAUDE.md` for the fuller set of working conventions this repo follows (architecture
boundaries, dependency direction, gates).

## Reporting bugs / requesting features

Please use the issue templates — they ask for the information needed to reproduce a bug (browser,
steps, expected vs. actual) or scope a feature request.

## Pull requests

1. Fork the repo and create a branch from `dev`.
2. Make your change, following the guidance above.
3. Make sure the full gate (see above) passes locally.
4. Open a PR against `dev` using the pull request template.
5. Be responsive to review feedback — small, focused PRs get reviewed and merged faster.

## License

By contributing, you agree that your contributions will be licensed under the project's
[Apache License 2.0](LICENSE).
