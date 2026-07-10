# ADR-008: Enforcement Scope — In-Page Automation vs External CDP Drivers

**Status:** Accepted
**Date:** 2026-07-09
**Relates to:** ADR-007 (CDP-layer enforcement), architecture §7/§8, audit #29/#32
**Refines the scope stated in:** README "What It Does", store listing, the popup
agent badge, and the kill-switch description.

## Context

AI Browser Guard's action enforcement runs in the page realm (the MAIN-world
interceptor wraps page-JS globals; the monitor observes untrusted DOM events).
A review (`docs/audit/2026-07-09-enforcement-scope-review.md`) confirmed that this
scope covers **in-page / injected automation** but does **not** extend to
**external CDP/WebDriver drivers** (Playwright, Puppeteer, Selenium, Anthropic
Computer Use, OpenAI Operator). The prior UI, reports, and documentation stated a
broader scope than the implementation delivers for that population. This ADR sets
the correct scope and aligns every surface with it.

Why the boundary is structural:

1. **Native CDP input is trusted.** External drivers act via
   `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`, which the
   browser dispatches as `isTrusted:true` events and native form submission. The
   MAIN-world interceptor only wraps page-JS globals, and the monitor processes
   untrusted events only (`src/content/monitor.ts:169`), so page-realm rules do
   not apply to native input.
2. **The debugger slot is owned.** A tab admits one debugger client; the driver
   holds it, so `chrome.debugger.attach()` fails and there is no evict/steal API.
   ADR-007's CDP layer therefore cannot attach against this population.

Because of (1), a session driven by an external driver produces few or no
observed actions, and the report did not previously state that this reflects an
observation limit rather than an absence of activity.

## The capability boundary

An installed browser extension cannot apply per-action policy to, or categorically
stop, an external CDP/WebDriver driver — this is the extension security model.
Verified capability survey (sources in the review doc):

| Mechanism | Layer | Stops external CDP? | Cost |
|---|---|---|---|
| `RemoteDebuggingAllowed=false` | managed policy | **Fully** — removes the `--remote-debugging-port`/`-pipe` transport | Managed Chrome / MDM / GPO; admin rights |
| Chrome ≥136 default | built-in | **Partially** — blocks remote debugging of the *default* profile by default; a throwaway profile is still drivable | Zero (already shipping) |
| Native-messaging host kills the CDP port/process | native host | **Reactive** — can terminate the port/driver; it can relaunch | User installs a signed binary + host manifest |
| CDP MITM proxy filters commands | launch-control | **Only if *you* launch the browser**; not extension-reachable | Must own browser launch |
| `chrome.tabs.remove` / `discard` | extension | **Partially** — destroys the page target (interrupts the current action); a browser-level driver can reopen | Trivial |
| declarativeNetRequest blocklist | extension | **Partially** — coarse domain blocklist; no per-initiator attribution | Trivial |
| `chrome.debugger.attach` contention | extension | **No** — one client per target; cannot steal/evict | Trivial |

The only categorical prevention is `RemoteDebuggingAllowed=false` (admin-only);
Chrome 136+ already covers the highest-value case (the default profile) by
default; a plain extension can detect, disrupt (close the tab), and blocklist
domains, but not guarantee prevention.

## Decision

AI Browser Guard's scope is **detection + alerting + a tab-close stop + accurate
reporting + posture guidance**, and every surface reflects the enforceability of
the specific detected agent.

1. **Single source of truth for enforceability.** `src/delegation/enforceability.ts`
   (pure, tested) decides, per detected agent, whether ABG can enforce
   (`page-realm-best-effort`) or only observe (`none`, for external drivers), and
   produces the badge/label/caveat. The popup, session report, and copy consume
   it; the decision is not re-derived elsewhere.

2. **Reflect enforceability on every surface.**
   - Popup: external drivers show **"Monitor only"**, not **"Managed"**. A policy
     set on an unenforceable agent renders a scope caveat.
   - Session report: carries a `coverage` field; when native input is not
     observable the report states so, and a `0` is labeled "page-level" rather
     than presented as an all-clear.
   - README / store listing / manifest: state that per-action blocking applies to
     in-page automation (best-effort) and does not extend to external CDP drivers.

3. **Make the kill switch a real stop.** It closes the tabs an agent controls
   (`chrome.tabs.remove`), which interrupts the in-progress action, and records
   the actual outcome (`closedTabIds`, `pageRealmCleanupDispatched`). The prior
   `cdpTerminated`/`automationFlagsCleared` status booleans were set
   unconditionally and did not reflect an actual outcome; they are removed. The
   scope is stated: a persistent external driver can reopen a tab; the categorical
   stop is a managed-Chrome policy.

4. **Report only outcomes that occurred.** A control records what it did, not a
   fixed status value.

## Roadmap (real enforcement, beyond this scoping change)

Ordered by value/cost. None shipped; each gets its own ADR before code.

- **R1 — Posture guidance (cheap, high value).** Detect Chrome version and, when
  ≥136, tell the user their default profile is already protected from remote
  debugging; for managed environments, surface a `RemoteDebuggingAllowed=false`
  explainer. Extension-only; ships next.
- **R2 — declarativeNetRequest domain blocklist (opt-in).** Coarse, zero-banner
  egress blocklist, scoped honestly (no per-initiator attribution).
- **R3 — Native-messaging companion (opt-in).** A signed host that can detect a
  listening CDP port and offer to terminate the driver process. Reactive; high
  distribution cost — gauge demand first.
- **R4 — Managed-deployment mode.** Ship an ADMX/plist template and docs pairing
  ABG (detection/audit) with `RemoteDebuggingAllowed=false` (prevention). The only
  path to categorical prevention, and where ABG is most useful in an enterprise.

Not reachable for a consumer extension: CDP MITM proxy (launch-control only),
forcing `chrome.debugger` detach (no API).

## Consequences

### Positive
- The stated scope matches the implementation on every surface.
- The kill switch performs a real action (tab close) for the first time.
- A clear roadmap toward categorical prevention (posture + managed policy).

### Negative
- The headline scope narrows from "blocks AI agents" to "detects AI agents,
  closes their tabs, and helps you prevent them" — a real reduction in stated
  capability, and the accurate one.
- Closing tabs is disruptive; the kill switch states that it closes agent tabs.

### Neutral
- Detection, the ADR-007 CDP site-block layer, and the in-page best-effort
  interceptor are unchanged in behavior; their framing and the kill switch change.
