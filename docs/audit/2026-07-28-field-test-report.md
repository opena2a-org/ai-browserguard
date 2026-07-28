# AI Browser Guard v0.6.0 — Field Test Report

**Date:** 2026-07-28
**Scope:** Real-agent field test of the store-installed v0.6.0, against the
current store-listing / ADR-008 promises, with an independent check of what the
extension actually records and shows. Two agent classes:
- External / CDP driver — Claude driving Chrome over the Claude-in-Chrome MCP
  (equivalent to Cowork; CDP-class), ~60 actions over 19 minutes.
- In-page / injected — a self-driving fixture page firing synthetic events, run
  both by hand and via a controlled Chromium with the extension loaded.

**Headline:** On the **external-agent** promises, ABG delivers — detection,
honest reporting, and the kill switch all did what the listing says, confirmed
against the raw stored data. The problems are on the **control surfaces**: a P0
that bricks the extension, a trust-damaging attribution bug, and — most
important — the in-page per-action blocking, though mechanically sound, cannot be
turned on in practice.

---

## 1. Promise vs. observed — external / CDP class

Judged against `docs/chrome-web-store-description.md` (v0.6.0) and ADR-008.
Evidence: agent action log + `chrome.storage.local` read directly off disk.

| # | Promise | Observed | Verdict |
|---|---------|----------|---------|
| E1 | Detects takeover via multiple signals; shows method + confidence | 7 detections, `cdp-connection`, confidence high, type `cdp-generic`; out-of-band (agent's UA was clean, no `navigator.webdriver`) | **PASS** |
| E2 | Timeline logs only observable actions; `0` means "unseen", not "nothing" | Every report `0/0/0`; native CDP input not observable | **PASS** |
| E3 | Session report carries a coverage note stating native input isn't observable | Present verbatim on all 7 reports | **PASS** |
| E4 | Kill switch closes the tabs the agent controls; records the real outcome; does not terminate the driver; driver can reopen | Closed the tabs it controlled (`closedTabIds`, `trigger=keyboard-shortcut`); agent lost its tab group, hard-errored, then reopened a fresh group ~33s later | **PASS** |
| E5 | Last 5 sessions retained | `sessions[5]`, `reports` up to 20 | **PASS** |
| E6 | Site safety declarations (opt-in) shown on detection for a declaring site | **NOT DELIVERED this run** — no declaration fetched/cached; no detection logged on the opena2a.org navigation, so the fetch never fired | **GAP** |
| E7 | Downloads permission is export-only (per listing) | **FALSE** — code actively cancels agent downloads; the run's download wasn't blocked (no rule) and wasn't logged | **DISCREPANCY** |

## 2. In-page / injected class — the core gap

The population ABG promises per-action blocking for. Result: **the blocking
engine works, but it cannot be armed in practice.**

- **Engine verified.** With diagnostics compiled in and the extension driven in a
  real browser, the monitor runs, sees the fixture's synthetic events
  (`isTrusted:false`), clears the gesture-grace window, and evaluates each against
  the active rule. The block itself is unit-proven
  (`src/content/monitor.interception.test.ts`: a synthetic event under a blocking
  rule yields `defaultPrevented === true`).
- **Arming is unreachable.** Across two manual runs and six automated runs, no
  rule ever became active on the tab:
  - The CDP agent is detected on the initial `about:blank` and **de-registers on
    navigation**, so by the time the popup opens it shows "No agents detected" —
    there is no agent card to grant Read-Only from.
  - The only fallback is the manual session-wide "Configure" wizard, a multi-step
    flow. (Its persistence could not be confirmed via automation because the
    extension correctly rejects delegation messages from a tab-hosted popup; a
    real toolbar-popup run is needed to confirm/deny a wizard bug.)

**Net:** for the agents in-page blocking is meant to stop, the agent disappears
from the UI before you can delegate to it, and the toast + per-action block
(release-smoke step 3) has still never been exercised end to end. A protection
that can't be armed protects nothing.

---

## 3. Findings, ranked

| ID | Sev | Finding | Status |
|----|-----|---------|--------|
| F-O | **P0** | Kill switch can't be released — a reset that races the MV3 state-load is clobbered, latching the extension in KILLED (no protection) with no in-product recovery. Escape required uninstall/reinstall. | **FIXED** — `fix/kill-switch-reset-race`, regression test |
| F-L | P1 | Page network failures (e.g. a site's own CSP-blocked analytics) are attributed to ABG in `chrome://extensions` — a no-telemetry tool looks like it's phoning out. Root cause: fetch/sendBeacon wrappers installed on every page unconditionally. | **FIXED** — `fix/network-interceptor-arming`, regression test |
| F-P | P1 | In-page enforcement unreachable: detected agents de-register before you can delegate; manual delegation is buried. | Found |
| F-M | P1 | Kill switch mislabels its own session-ends as `page-unload`; no report ever says `kill-switch`; `closedTabIds` never shown. The most disruptive action is unattributed in every surface a user checks. | Found |
| F-A | P1 | Agent download block is **badge-only** — no notification, no toast, no "recently blocked" entry. This is the user's canonical "blocked download, no idea why". | Found |
| F-B | P1 | "Allow once" on the block toast is inert for the commonest in-page block (Read-Only click/type): the monitor never consults the allow-once set. | Found |
| F-E | P2 | "Managed"/enforceable classification is effectively unreachable; in-page agents always display "Monitor only / Not enforced" even while the monitor does block them. | Found |
| F-F | P2 | Store listing / permission justification calls the downloads permission "export-only"; it is not (see E7). | Found |
| F-I | P2 | Popup doesn't live-refresh on block events, so it understates activity during a session. | Found |
| F-D | P2 | After a kill switch the user can't see which/how many tabs were closed. | Found |
| F-G | P3 | `detectionLog`, detection signals, observed capabilities are stored but never surfaced anywhere. | Found |
| F-H | P3 | `delegation-expired` never records a session end-reason; the rule silently deactivates. | Found |

## 4. The two fixes (ready for release)

**F-O — `fix/kill-switch-reset-race`.** State-dependent handlers now await a
memoized state load (`ensureReady`) before touching the kill switch; the reset
replaces the latch object wholesale and persists the cleared value before
responding, so it always wins the race. Regression test
`src/background/kill-switch-reset-race.test.ts` reproduces the interleaving and
fails on the pre-fix code. Full suite 965 pass; lint + build clean.

**F-L — `fix/network-interceptor-arming`.** fetch/sendBeacon wrappers install only
while an active rule or the kill switch is present (mirroring the modify-dom
guard), matching the invariant the XHR path already documented; cleanup restores
the exact native impls. Regression test
`src/content/interceptor.network-arming.test.ts` fails on the pre-fix code. Full
suite 971 pass; lint + build clean.

Both held for a single batched release (one `/release-test`, one publish).

## 5. Recommended backlog (proposed roadmap units)

1. **P0 release:** ship F-O + F-L (batched).
2. **F-P:** keep detected agents grant-able after navigation (or support
   pre-arming a session rule); add a live E2E smoke that arms a rule via the real
   popup and asserts the block toast; confirm the Configure wizard persists a rule.
3. **F-M / F-D:** record `endReason=kill-switch` on the sessions the kill switch
   ends; surface `closedTabIds` ("closed N tabs") in the popup.
4. **F-A:** give the download block the same attribution chain as other blocks
   (notification + recent-blocked entry + plain-language why).
5. **F-B:** make the toast's "Allow once" honor monitor-path blocks.
6. **F-F:** correct the "export-only" downloads wording on every surface.

## 6. Method / evidence

Storage read from `Local Extension Settings/<id>/` (LevelDB, copied then read
read-only). In-page runs used a self-driving fixture
(`scripts/inpage-agent-fixture.html`) plus a controlled Chromium with `dist/`
loaded and temporary diagnostics (reverted). No estimated data; every verdict
maps to a stored value or a diagnostic log line. Where a promise could not be
tested (E6 needed a declaring-site detection that didn't fire; the in-page block
toast needs a real toolbar-popup grant), it is marked as such rather than passed.
