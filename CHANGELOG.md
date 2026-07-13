# Changelog

All notable changes to AI Browser Guard are documented here.

## 0.5.0 - 2026-07-13

### Changed
- **Enforcement scope corrected to match the extension security model (ADR-008).**
  Per-action blocking is now stated and implemented as best-effort against
  in-page / injected automation only. External automation frameworks (Playwright,
  Puppeteer, Selenium, Anthropic Computer Use, OpenAI Operator) drive the browser
  with native CDP input the page realm cannot intercept, so AI Browser Guard
  detects, alerts, and can close their tabs, but cannot apply per-action policy to
  them. Every surface (popup, session report, README, Chrome Web Store listing,
  manifest) now reflects the enforceability of the specific detected agent.
- **Popup shows "Monitor only" for external CDP drivers** instead of "Managed". A
  policy set on an unenforceable agent renders a scope caveat. Enforceability is
  decided by a single source of truth (`src/delegation/enforceability.ts`),
  consumed by the popup, session report, and copy rather than re-derived.
- **The kill switch performs a real stop: it closes the tabs an agent controls**
  (`chrome.tabs.remove`), interrupting the in-progress action, and records the
  actual outcome (`closedTabIds`, `pageRealmCleanupDispatched`). The previous
  `cdpTerminated` / `automationFlagsCleared` status booleans were set
  unconditionally and did not reflect any real outcome; they have been removed. A
  persistent external driver can reopen a tab; the categorical stop is a
  managed-Chrome policy (`RemoteDebuggingAllowed=false`), and Chrome 136+ already
  blocks remote debugging of the default profile by default.
- **Session reports carry a `coverage` field.** When native input is not
  observable, the report states so, and a `0` is labeled page-level rather than
  presented as an all-clear.

### Added
- ADR-008 documenting the enforcement scope and the roadmap toward categorical
  prevention (posture guidance, declarativeNetRequest blocklist, native-messaging
  companion, managed-deployment mode).
- `src/delegation/enforceability.ts` (pure, tested): decides per detected agent
  whether AI Browser Guard can enforce (page-realm best-effort) or only observe
  (external drivers), and produces the badge/label/caveat.

## 0.4.2 - 2026-06-02

### Changed
- Privacy disclosure rewritten to accurately describe the network posture as
  "off by default, optional opt-in" across every surface (privacy policy,
  README, Chrome Web Store listing). The extension still makes zero network
  requests on a fresh install; the three opt-in community-intelligence features
  (AIM identity lookup, registry trust lookup, anonymized contribution) are
  documented as default-off with one-click opt out. Supersedes the previous
  absolute "zero network requests" claim.
- Privacy policy permission list corrected to the manifest's actual permissions
  (storage, alarms, notifications, debugger, downloads) and added justifications
  for `debugger` (CDP-attachment detection) and `downloads` (user-initiated
  report export).

### Added
- ADR-006 documenting the opt-in network posture; ADR-003 marked superseded.
- `docs/chrome-web-store-description.md`: copy/paste resubmission text for the
  Web Store Developer Dashboard (description, permission justifications, support
  URL, data-use disclosures).
- Fresh-install zero-network regression test asserting the default settings and
  consent gates keep all three network paths off until the user opts in, plus
  both-directions gate tests (sends when opted in; clears the queue and sends
  nothing on opt-out) and a release-metadata test pinning the manifest/package/
  changelog version match and the homepage_url domain.

### Security
- `scripts/build.js` now invokes `zip` via `spawnSync` with array arguments
  instead of `execSync` with an interpolated shell string, so build paths can
  never be interpreted as shell tokens.

### Fixed
- Resolves the v0.3.0 Web Store rejection follow-through: removed the dead
  `chrome.identity` login code so the shipped bundle references no `identity`
  permission, and added `homepage_url` to the manifest. (Carried from the
  release-readiness work merged ahead of this release.)
