# Changelog

All notable changes to AI Browser Guard are documented here.

## 0.6.2 - 2026-07-29

The remainder of the 2026-07-28 field-test findings
(`docs/audit/2026-07-28-field-test-report.md`), released as one batch so the
Web Store submission carries the full set.

### Fixed
- **In-page delegation is now reachable (F-P, the field test's core gap).** The
  per-action block engine worked but could not be armed: the in-memory agent
  maps die with every MV3 worker restart, and the load path force-ended every
  un-ended session as `agent-disconnected` — so the popup showed "No agents
  detected" mid-session and there was no agent card to grant Read-Only from. A
  persisted active-agent registry now rehydrates agents whose tab still exists
  **on the same origin** (tab identity is existence + origin — Chrome reuses
  tab ids across restarts, and the kill switch closes the tabs in this map, so
  a bare id match could aim it at an unrelated restored tab). Malformed
  entries are dropped and pruned; origin mismatches and dead tabs end their
  sessions honestly. The registry stores no new data class — it is a pointer
  over the agent/session data the privacy policy already describes as stored
  locally.
- **The kill switch's own actions are attributed (F-M / F-D).** Sessions it
  ends are recorded `endReason: 'kill-switch'` (previously the tab-close
  handler relabeled every one `page-unload`), exactly once; the killed status
  badge reads "Killed · closed N tabs" with trigger and time in the tooltip.
- **Blocked agent downloads are attributed (F-A).** A cancelled download now
  produces a coalesced notification (max one per 10s burst; honoring the
  Notifications setting) and a recent-violations entry with a plain-language
  why and the honest recovery path. Previously badge-only: the download
  vanished with no explanation anywhere. No "Allow once" button — the
  download is already cancelled and cannot be resumed.
- **"Allow once" works on the monitor path (F-B).** The toast's grant used to
  land only in the MAIN-world interceptor's set; the ISOLATED-world monitor
  issuing the commonest in-page blocks (Read-Only click/type/submit) never
  consulted it. Both grant entry points now feed a monitor-side one-shot set,
  consumed on first matching event; kill-switch activation purges pending
  grants, mirroring the MAIN world.
- **The downloads-permission wording is accurate (F-F).** The store listing no
  longer claims "user-initiated exports only" — the extension detects and
  cancels agent downloads per delegation rules, and the listing now says so
  (the privacy policy was already accurate).

### Fixed (content-messaging repair — found by the new arming smoke)
- **The content -> background pipeline works again.** Three stacked bugs had
  silently disabled it in production, invisible to the unit suite:
  1. Sender validation's origin check required the extension's own origin on
     EVERY message, but Chrome sets a content script's `sender.origin` to the
     PAGE's origin — so every content-script message (in-page detections,
     action reports, boundary violations) was rejected. The suite stayed green
     because its content-sender fixtures omitted/faked the origin; fixtures
     now carry the production shape, and the origin requirement applies only
     to popup-class messages (where it correctly guards against a future
     `externally_connectable` misconfiguration).
  2. Any `chrome.runtime.lastError` on a sent message was treated as
     "extension context invalidated", permanently muting the content script —
     but `lastError` also fires for the routine "message port closed" produced
     by any declined message. One declined startup message and the tab dropped
     ALL background traffic (rules, kill-switch broadcasts, allow-once) for
     the life of the page. Invalidation is now only inferred from the actual
     invalidation error or a missing runtime id.
  3. The content script's startup state pull used the popup-only STATUS_QUERY,
     so it was (correctly) rejected: tabs opened after a delegation activated
     never received their rule, and a navigation during an active kill switch
     did not re-arm the MAIN-world sentinel. A new content-only
     TAB_STATE_QUERY returns exactly the tab's slice — its effective rule and
     the kill-switch latch, answered from loaded state.

### Hardened (adversarial-review follow-ups)
- Kill-switch ACTIVATE/RESET are serialized (arrival order wins; no
  interleaved re-latch); each tab close is bounded (1.5s) so a page's
  `beforeunload` prompt cannot wedge the emergency stop or a queued reset;
  ACTIVATE no longer depends on a successful state load; the popup renders
  "Killed"/"Monitoring" only on a confirmed response.
- `getKillSwitchState` fails loud on storage read errors instead of returning
  the inactive default — a storage blip must not silently lift a latched
  emergency stop (missing/malformed keys still return the fresh-install
  default).
- The content script's message handler mirrors the background's
  same-extension sender validation (defense-in-depth).
- The popup's Network Activity panel shows an honest empty state (network
  observation is delegation-scoped since 0.6.1) instead of hiding.

### Added
- `npm run smoke:arming` — release-smoke step 3, exercised end to end for the
  first time: drives the REAL toolbar popup wizard to activate a Read-Only
  rule, asserts the rule persists, then fires the in-page agent fixture's
  synthetic violations and asserts the monitor block and toast. Reports an
  explicit SKIP-ENV on a desktop without OS focus, never a false pass.
- `scripts/inpage-agent-fixture.html` — the field test's self-driving in-page
  agent fixture, now a repo asset.

## 0.6.1 - 2026-07-28

Two fixes from the 2026-07-28 field test of the store-installed 0.6.0
(`docs/audit/2026-07-28-field-test-report.md`).

### Fixed
- **The kill switch can now always be released.** The "killed" latch is
  re-armed from storage on every MV3 worker restart (so an idle timeout can't
  silently lift an emergency stop), but the message listener was registered
  before that state finished loading. A `Resume Monitoring` / `KILL_SWITCH_RESET`
  handled during the load window was overwritten when the load reassigned
  `state.killSwitch`, so the latch never cleared — leaving the user stuck in a
  KILLED state that stopped protecting them, with no in-product recovery (the
  only escape was uninstalling and reinstalling the extension). State-dependent
  handlers now await a memoized state load (`ensureReady`) before touching the
  kill switch, and the reset replaces the latch object wholesale and persists the
  cleared value before responding, so it always wins the race. Kill-switch
  activation is gated on the same guard. Regression test:
  `src/background/kill-switch-reset-race.test.ts` (fails on the pre-fix code).
- **Page network failures no longer attributed to the extension.** The MAIN-world
  `fetch`/`sendBeacon` wrappers were installed on every page unconditionally, so
  the extension's frame sat in the call chain of every page request. When a page's
  own request failed — e.g. a site's Content-Security-Policy refusing its own
  analytics beacon — Chrome attributed that failure to AI Browser Guard in
  `chrome://extensions`, making a local-first, no-telemetry tool look like the
  source of blocked or suspicious traffic. The wrappers are now installed only
  while there is something to enforce (an active delegation rule or the kill
  switch), matching the invariant the XHR path already documented ("we do NOT wrap
  `send()`… CSP violations get attributed to our extension"). In the default
  monitor-only state the page's network runs natively and the extension stays out
  of every site's network hot path. Cleanup now restores the exact native
  `fetch`/`sendBeacon` (no accreting `.bind()` layers across arm/disarm cycles).
  Two consequences of the narrower scope, stated plainly: network activity is
  now observed only under an active delegation or the kill switch, so in
  monitor-only mode the popup's Network Activity panel and the session report's
  network summary stay empty (they previously recorded agent `fetch`/`XHR`/
  beacon traffic on every page); and a `fetch`/`sendBeacon` reference a page
  captured while disarmed stays native, so arming later cannot reach it — one
  more route in the documented best-effort MAIN-world boundary (see
  "Enforcement scope" in `docs/architecture.md`; the class fix is CDP-layer
  enforcement, ADR-007). Regression test:
  `src/content/interceptor.network-arming.test.ts`, including a pinned
  known-limitation test for the pre-captured-reference route.

## 0.6.0 - 2026-07-22

### Added
- **Reads site safety declarations, `/.well-known/ai-safety.txt` (ADR-009).** When
  an AI agent is detected on a page, AI Browser Guard can read that site's
  declaration (`draft-fane-ai-safety-txt-00`) and show what the site claims about
  its own content: whether it is site-authored, injection-hardened, and rendered
  the same for agents as for people, plus a contact and a last-verified date.
  This is the first consumer of the format to exist anywhere.
  - **Off by default**, as a new "Read site safety declarations" setting. A fresh
    install still makes zero network requests, and the gate is enforced in the
    client itself so the fresh-install test proves it rather than asserting a
    default value.
  - **Display-only.** A declaration is self-asserted: any site can claim anything,
    including a hostile one. It is shown as claims, never as findings, and never
    changes what the extension detects, scores, or blocks (ADR-008 epistemics).
    A site with no declaration is reported as exactly that, never as a risk.
  - **The one feature that contacts a site instead of an OpenA2A server.** It
    sends no cookies, no page address, no referrer, and nothing about you;
    follows no redirects, so only the origin the agent already loaded is ever
    reached; reads only over HTTPS; and runs only while an agent is detected,
    never on pages you browse yourself. Results are cached locally for 24 hours,
    and turning the setting off deletes them.
  - No new permission: `host_permissions` already covers it, so no Web Store
    permission re-review.

### Changed
- **Privacy policy and README state the reachable-host set accurately (ADR-009,
  refining ADR-006).** The policy's claim that OpenA2A's own servers were the only
  ones the extension could contact is removed: it is false once site safety
  declarations exist, whatever their default. The store listing
  (`docs/chrome-web-store-description.md`, `docs/store-listing.md`) is rewritten
  in this release to disclose the new reachable-host set (the gate enumerated in
  `docs/testing/release-smoke.md`).
- ADR-006's "keep all four disclosure surfaces in sync" rule is now enforced by
  `network-disclosure-consistency.test.ts` instead of relying on memory: a new
  boolean setting fails CI until it is classified local-only or declared a network
  gate, and a network gate must default off and appear in the privacy policy.

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
