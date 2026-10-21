# Contributing

Contributions are welcome. Open an issue to discuss proposed changes before submitting a pull request. All PRs require passing CI and code review.

## Development

```bash
npm install          # Install dependencies
npm run build        # Build to dist/
npm run dev          # Watch mode
npm run test         # Run the test suite
npm run lint         # TypeScript strict checking and the docs prose check
```

The release smokes are listed in `docs/testing/release-smoke.md`. `npm run smoke:export` runs in Playwright's Chromium: install it once with `npx playwright install chromium`.

The `npm run smoke:*` scripts check the built `dist/` in a browser; [docs/testing/release-smoke.md](docs/testing/release-smoke.md) lists the browser each one needs.

## Releasing

1. In `CHANGELOG.md`, rename the `## [Unreleased]` heading to the new version and the date, for example `## 0.8.0 - 2026-10-18`.
2. In `docs/chrome-web-store-description.md`, change the version in the heading to the new one, for example `(v0.8.0)`.
3. Run `npm run bump -- <patch|minor|major|x.y.z>`. It sets the version in `manifest.json`, `package.json` and `STATUS.md`, runs the test suite, then builds.

The order matters. `npm run bump` edits neither `CHANGELOG.md` nor `docs/chrome-web-store-description.md`, and the release metadata test (`src/__tests__/release-metadata.test.ts`) requires the first version heading in `CHANGELOG.md`, and the version in the heading of `docs/chrome-web-store-description.md`, to match `manifest.json`. If you run the bump first, it fails that test, names it, and puts `manifest.json`, `package.json` and `STATUS.md` back to the previous version.
