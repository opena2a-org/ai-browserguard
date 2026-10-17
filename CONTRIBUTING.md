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
