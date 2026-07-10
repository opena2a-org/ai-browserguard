# Enforcement-Scope Review — AI Browser Guard v0.4.2

**Date:** 2026-07-09
**Trigger:** An external CDP agent (Claude Cowork / Playwright) operated under a
Read-Only session and its actions were not blocked or recorded. Reported as "the
tool isn't working."
**Method:** Live reproduction (headed Playwright loading the built extension) plus
a review of every user-facing capability statement.
**Outcome:** Confirmed a scope gap between the stated capability and the
implementation for external CDP drivers. Addressed under ADR-008.

## Live reproduction

Headed Playwright (`launchPersistentContext` + `--load-extension=dist`) drove a
form with native input while ABG detected the agent as **"Playwright / confirmed
/ cdp-connection"**:

- Form submitted: `TRANSFER SUBMITTED -> attacker-acct-9931 / $5000`.
- Session report: `actionSummary {total:0, allowed:0, blocked:0}`,
  `violationsByCapability {}`, `endReason page-unload`, `totalEvents 1`.

The `0/0/0` is the expected output for an external CDP driver (see Finding B), not
a data-plumbing defect.

## Finding A — Action enforcement is scoped to in-page automation (P0 scope gap)

External drivers act via native CDP input (`isTrusted:true`) and own the tab's
debugger slot. Coverage by capability (does native CDP input bypass it?):

| Capability | Enforcement point | Native CDP input bypasses? |
|---|---|---|
| navigate | `interceptor.ts` history wrap + Navigation-API listener (`isTrusted` gate) | Yes |
| read-dom | none | Yes (no hook) |
| click | `monitor.ts:169` `isTrusted` gate | Yes |
| type-text | `monitor.ts:169` | Yes |
| submit-form | `interceptor.ts` `form.submit` wrap (stack-gated) | Yes (reproduced) |
| download-file | `background/index.ts` `downloads.onCreated`→`cancel` | Partial (background-layer; racy) |
| open-tab | `interceptor.ts` `window.open` wrap | Yes |
| close-tab | none | Yes |
| screenshot | none | Yes (out of page realm) |
| execute-script | none | Yes |
| modify-dom | `interceptor.ts` DOM-write sink wraps | Yes (native field edit) |
| network-request | `network-interceptor.ts` (stack-gated) | Yes (native POST/WS/etc.) |

Capabilities with no page-realm enforcement point: `read-dom`, `screenshot`,
`execute-script`, `close-tab` — offered as delegation presets but not enforceable
from the page realm.

### Kill switch — scoped to the page realm (P0)
`src/killswitch/index.ts` + `src/background/index.ts:840`. On activation it flipped
a page-realm flag, cleared in-page automation markers, and detached the ADR-007
CDP layer; it did not close a tab or interdict at the browser layer, and it set
`cdpTerminated:true` unconditionally (a status value that did not reflect an actual
outcome). The README described it as "terminates CDP sessions" / "the hard stop".

## Finding B — Session report did not state its observation scope (P1)

`src/session/timeline.ts` + `src/session/report.ts`. Counters increment only for
untrusted DOM events (`monitor.ts:169`), page-realm interceptor blocks, or download
cancels. Native CDP input contributes nothing, and there was no field indicating
the counts are page-realm-only. The metrics panel rendered `None / violations
detected`, so a session that could not be observed read as an all-clear.

## Finding C — Popup badge did not reflect enforceability (P1)

`src/popup/popup.ts`. "Managed" was shown whenever a rule existed and the agent was
a known framework — i.e. external drivers, which the page realm cannot enforce
against. `cdp-generic` received the least-specific badge. The DevTools
false-positive confidence caveat is computed (`cdp-debugger.ts`) but not surfaced
in the popup.

## Finding D — Public copy stated a broader scope than the implementation (P0)

- `README.md` — "blocks their scripted navigations … Playwright, Puppeteer,
  Selenium, Computer Use, Operator"; "terminates CDP sessions".
- `manifest.json` description (shown in `chrome://extensions`) — "block their
  scripted navigations…".
- `docs/store-listing.md` / `docs/chrome-web-store-description.md` — "block
  scripted AI-agent actions", without stating that external frameworks are out of
  scope for per-action blocking.

## Accurately scoped already (preserved)

- ADR-007 CDP layer is labeled "advanced / your site block rules", default-off, and
  its code header states it does not apply to external frameworks.
- `inferFrameworkFromTargets` does not guess a vendor from topology.
- DevTools confidence capping is correct (only its surfacing was missing).
- `topUrls`/`networkSummary` reduce to hostnames (privacy).

## Capability-research sources (for ADR-008)

- `RemoteDebuggingAllowed`: https://chromeenterprise.google/policies/remote-debugging-allowed/
- Chrome 136 default-profile restriction: https://developer.chrome.com/blog/remote-debugging-port
- `chrome.tabs`: https://developer.chrome.com/docs/extensions/reference/api/tabs
- `chrome.debugger` (one client per target): https://developer.chrome.com/docs/extensions/reference/api/debugger
- declarativeNetRequest: https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest
- native messaging: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

## Resolution

Under ADR-008: `enforceability.ts` single source of truth; badges/caveats that
reflect enforceability; report `coverage` field + page-level metric labels; a real
kill switch (closes agent tabs, records the actual outcome); copy aligned across
README, store listings, manifest, presets; scope-contract tests + an
extension-loaded scope smoke (`scripts/smoke-scope.mjs`) that drives an external
CDP agent and asserts the report states its observation scope.
