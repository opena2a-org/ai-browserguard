# ADR-007: Move Repatch-Immune Enforcement to the CDP/Debugger Layer

**Status:** Accepted
**Date:** 2026-06-04
**Relates to:** audit #29 (enforcement scope), audit #32 (MAIN-world trust boundary),
ADR-001 (MV3), ADR-005 (fail-closed delegation)

## Context

Capability enforcement today runs in two realms (architecture §7, §8):

1. The **ISOLATED** content-script world — Chrome-protected, the page cannot
   tamper with it. This is where detection, message validation, and the kill
   switch live. Trusted.
2. A **MAIN**-world interceptor (`src/content/interceptor.ts`) that wraps page
   globals (`window.open`, `HTMLFormElement.prototype.submit`, `history.*`, the
   `modify-dom` DOM-write sinks, `fetch`/`XHR`) to block agent-attributed
   actions under an active delegation.

The MAIN world shares the page's JS realm. Audit #32 established that this is
**not a trust boundary against a hostile first-party page**: after the bootstrap
handshake, a page can re-patch the same globals the interceptor wrapped and
neutralize enforcement, because both live in the page realm. Architecture §8
therefore classifies all MAIN-world action blocking as **best-effort** and lists
as recommended hardening: "migrate action enforcement to the CDP/debugger layer
so it no longer depends on page-realm globals."

The enforcement gap this leaves, after PRs #47–#50:

- **Page-realm re-patch bypass (the #32 hole).** Every capability enforced in
  the MAIN world — scripted navigation, form submit, `modify-dom`, the
  `network-request` deny path (#50) — can be defeated by a page that restores
  the wrapped global after our `document_start` interceptor runs.
- **Unwrapped egress vectors.** #50 deny covers `fetch`/`XHR`/`sendBeacon`. It
  explicitly left **WebSocket, EventSource, element-`src` injection
  (`new Image().src`, `<script>`/`<link>`), and Worker/iframe fetch** unwrapped.
  These all transit the browser network stack regardless of how page JS spawned
  them, so a network-layer mediator catches them where page-realm wrapping
  cannot practically reach.
- **Capabilities the page realm cannot guarantee at all** — `read-dom`,
  `execute-script`, `screenshot` — have no page-realm enforcement and never can.

The extension **already declares the `debugger` permission** and uses it
read-only (`chrome.debugger.getTargets()` in `src/detection/cdp-debugger.ts`)
for browser-level CDP-client detection. It has **never called
`chrome.debugger.attach()`**. So the high-trust install warning is already paid,
but the runtime "AI Browser Guard started debugging this browser" banner is not
currently shown.

### Adversarial framing — what CDP enforcement can and cannot do

A single tab admits **only one debugger client at a time**. This bounds the
threat model precisely, and the decision below is built on it:

- **In-page / injected agents** (malicious or compromised first-party page
  script, an injected content-script agent, a same-realm automation shim) —
  these are exactly the actors that defeat MAIN-world enforcement by re-patching
  globals (#32). They do **not** hold a CDP session. We can attach and mediate
  their network/DOM operations at a layer they cannot re-patch. **This is the
  population CDP enforcement is for, and it directly closes the #32 hole.**
- **External CDP frameworks** (Playwright, Puppeteer, Selenium 4+, Computer-Use
  drivers) hold the tab's sole debugger session themselves. Our `attach()` will
  **fail** against them — and that is acceptable, because for this population the
  trusted defenses are detection (`getTargets`, already shipping) plus the
  ISOLATED-world `isTrusted`/CDP gates, not page-action interception. CDP
  enforcement is **not** claimed to stop an external framework that owns the
  debugger slot.

Stating this plainly prevents the overclaim the #29 narrowing (PR #44) was
written to avoid: "browser-layer enforcement" must not be read as "we can stop
Playwright." We cannot, by construction, and we will not say we can.

> **Correction 2 (post-validation, 2026-08-03).** The one-client-per-tab premise
> above is stale on current Chrome: multi-client DevTools protocol support means
> `chrome.debugger.attach()` **succeeds** alongside an external CDP client, and
> with DevTools open (measured on Chrome 145: attach + `Fetch.enable` +
> `Fetch.requestPaused` all function while a puppeteer client drives the tab).
> Two consequences, neither of which widens the claim: (1) blocked-domain egress
> enforcement usually applies on externally-driven tabs too — a strengthening,
> not a promise, because a browser-level adversary can detach us, relaunch, or
> drive another profile, so the external-framework population's defense remains
> detection + the ISOLATED gates + posture guidance (ADR-008 R1) + the kill
> switch; (2) the "attach fails -> fall back to page realm" path below remains
> the designed behavior for the attach failures that do still occur (restricted
> targets, races with tab teardown) and is unit-covered, but DevTools-open is no
> longer a reliable way to produce one.

> **Correction 3 (post-validation, 2026-08-03) — WebSocket is NOT closed by
> this increment.** Section 1 and the Consequences below assert the CDP layer
> closes the WebSocket vector #50 left unwrapped. Live validation
> (`npm run smoke:cdp`, and a focus-free mechanism harness) showed this is false:
> the CDP `Fetch` domain does not emit `Fetch.requestPaused` for `ws://`/`wss://`
> handshakes (measured — `pausedFetch` is always empty for ws), so
> `decideFetchRequest` never sees them. `Network.setBlockedURLs` *can* block ws in
> a clean debugger session with scheme-anchored patterns, but on the live
> extension's session (Fetch + Network + detection sharing one client) it raced
> the handshake and leaked intermittently — unreliable enough that shipping it
> behind a "closed" claim would be an overclaim. So this increment does **not**
> attempt WebSocket blocking. The vectors it DOES close, reliably and validated
> end-to-end, are: `fetch`/XHR, EventSource, element-`src`, Worker and iframe
> fetch, and navigation, for blocked domains. WebSocket to a blocked domain
> remains open and is disclosed as such in every user-facing surface. The clean
> fix is `declarativeNetRequest` (`resourceTypes: ['websocket']`, per-tab session
> rules block ws deterministically), which needs a new permission and belongs to
> ADR-008 R2 (DNR complement), not this increment. Wherever this document below
> lists "WebSocket" among the closed vectors, read it as superseded here.

## Decision

Add an **opt-in, delegation-scoped, per-tab CDP enforcement layer** that mediates
the capabilities the page realm cannot guarantee, while keeping the page-realm
interceptor as the **no-attach default**. The first increment enforces **network
egress** via the CDP `Fetch` domain. `read-dom` / `execute-script` /
`screenshot` enforcement is deferred to follow-up ADRs (each needs its own
design; see "Deferred").

### 1. Mechanism: `chrome.debugger` (CDP `Fetch` domain), not declarativeNetRequest

`chrome.debugger` is the only mechanism that mediates page operations at a layer
the page cannot re-patch, with **per-request, agent-attributable** decisions.

- **`Fetch.enable` → `Fetch.requestPaused` → `continueRequest` / `failRequest`.**
  Mediates the full network stack (including the WebSocket/EventSource/element-src/
  Worker vectors #50 left open) below the page realm.

  **Correction (post-implementation, supersedes the original attribution claim
  in this section):** the CDP `Fetch` domain pauses EVERY request on the tab and
  carries NO agent-vs-user attribution — that signal exists only in the page
  realm (call-stack heuristics). So the CDP layer **cannot** honor the
  `network-request` *capability* withhold: doing so would fail the page's own
  resources and the human's navigation, bricking the tab (the very DNR failure
  mode rejected below). The capability-level network block therefore stays in
  the page realm (best-effort, but attributed). What the CDP layer enforces
  repatch-immune is an explicit **site `block` pattern** — a coarse, tab-wide
  domain block the user deliberately set, applied regardless of initiator (the
  tab-wide scope is intended and documented). The decision reuses
  `matchUrlPattern` over the rule's block patterns only; everything else
  continues. This narrows the first increment to off-realm enforcement of site
  block patterns (effectively the coarse-domain blocklist the "Deferred"
  section anticipated, delivered via CDP rather than DNR), which still closes the
  #32 re-patch bypass and the #50 unwrapped vectors for blocked domains.

**`declarativeNetRequest` rejected as the primary mechanism:**
- DNR rules apply to *all* requests on a host by URL/resource-type. They cannot
  distinguish agent-initiated from user-initiated requests — that attribution is
  the entire basis of the delegation model. A DNR rule that blocks a domain
  blocks it for the human too.
- DNR cannot enforce `read-dom`, `execute-script`, or `screenshot`.
- DNR may have a role later as a coarse, zero-banner *domain* blocklist
  complement (no yellow bar), but it cannot carry the per-agent contract.

**Hybrid stance:** CDP for attributed, capability-level, repatch-immune
enforcement under active delegation; page-realm interceptor remains the default
when CDP is off or attach is unavailable. DNR left open as a future complement.

### 2. Permission cost

- **Install warning: already paid.** `debugger` is declared and shipping. This
  ADR adds **no new install-time permission** and no new CWS permission warning.
- **Runtime banner: new, and gated.** `attach()` triggers the "started debugging
  this browser" info bar. We accept this cost **only** while a user has actively
  delegated a tab to an agent, and we make the whole layer **opt-in** so the
  zero-runtime-banner posture is preserved by default.

### 3. Opt-in, attach lifecycle, and UX (empower-never-shame)

- **New setting `cdpEnforcementEnabled`, default `false`** (joins the ADR-006
  opt-in family; fresh install attaches no debugger and shows no banner).
- **Attach only when ALL hold:** the setting is on; an agent is detected on the
  tab; and an **active delegation rule** applies to that tab (the user has
  explicitly handed the session to an agent). Never attach during normal
  browsing.
- **Per-tab and time-bounded.** Detach on: delegation expiry (reuse
  `FULL_ACCESS_MAX_MINUTES` / `isTimeBoundExpired`), delegation revoke, kill
  switch, tab close, agent-session end, and setting toggled off.
- **Honest surfacing.** The banner is *truthful* here — the user delegated this
  tab to an agent and we are enforcing their rules at the browser layer. The
  popup explains *why* the banner is showing ("Enforcing your delegation rules
  for `<agent>` at the browser layer — removed when the session ends") and
  enforcement is torn down promptly on every end path. No shaming, no FUD: the
  banner means protection is active, and we say so.

### 4. Failure modes

- **SW death mid-session (MV3).** The debugger session drops when the service
  worker is evicted. Reuse the existing `cdp-monitor` alarm self-wake (0.5 min):
  on wake, **reconcile** — for each tab, if delegation is active but no debuggee
  is attached, re-attach; if attached with no active delegation, detach. No new
  lifecycle primitive.
- **One-client-per-tab conflict** (DevTools open, an external CDP framework, or
  another extension holds the slot). `attach()` fails. We **fail-safe to the
  page-realm interceptor** (the current shipping default — so this is *not* a
  regression) and surface a clear, non-alarming notice ("Browser-layer
  enforcement unavailable — likely DevTools is open; using page-layer
  enforcement"). We do **not** hard-block all agent actions on attach failure:
  that would punish legitimate delegated workflows for having DevTools open. The
  **kill switch remains absolute** regardless of attach state (it does not
  depend on the debugger session). `chrome.debugger.onDetach` triggers the same
  fail-safe fallback + notice.
- **Restricted targets** (`chrome://`, Web Store, `devtools://`) — not
  attachable and not agent-navigable content; skipped, consistent with
  `isInternalUrl` in detection.
- **Stale-attach window.** If a delegation lapses between reconciles, a tab can
  stay attached (banner showing) until the next `cdp-monitor` alarm reconcile
  (≤~30s). No traffic is wrongly blocked during the window — `decideFetchRequest`
  fail-opens for the lapsed rule — so the only effect is a briefly stale banner.

This is **fail-safe (degrade to today's behavior)**, deliberately distinct from
ADR-005's fail-*closed* *delegation* default. The delegation engine still denies
by default; what degrades on attach failure is only the *enforcement layer*,
back to the page-realm best-effort that ships today.

### 5. Scope of the first PR

**Off-realm enforcement of site `block` patterns for network egress**, via the
CDP `Fetch` domain, opt-in, and attached only when an active delegation governs
the tab AND that rule carries at least one block pattern (no block pattern =
nothing to enforce off-realm = no attach, no banner). Per the Correction in
section 1, the first increment enforces site block patterns — not the
`network-request` capability withhold, which the CDP layer cannot attribute and
which stays page-realm. Chosen because it (a) closes the #32 page-realm re-patch
bypass for explicitly-blocked domains, (b) closes the concrete
WebSocket/EventSource/element-src/Worker vectors #50 left open *for those
domains*, and (c) reuses the site patterns and `matchUrlPattern` shipped in #50 —
no new policy surface. The page-realm interceptor remains the enforcement point
for the `network-request` capability.

### Deferred (separate ADRs, not this line of work)

- `read-dom` / `screenshot` / `execute-script` CDP enforcement. `read-dom` in
  particular has an unresolved design question: an external framework reads DOM
  through **its own** CDP session, which our session cannot intercept — so CDP
  `read-dom` enforcement helps only against in-page readers and needs its own
  threat-model write-up before any code.
- DNR coarse-domain blocklist complement (zero-banner).

## Consequences

### Positive
- Closes the #32 page-realm re-patch bypass for network egress against the
  in-page/injected-agent population it actually applies to, at a layer the page
  cannot restore.
- Closes the WebSocket/EventSource/element-src/Worker egress vectors #50 left
  open, via one network-layer mediator instead of wrapping each global.
- No new install-time permission or CWS warning (already paid).
- Default behavior unchanged: opt-in, fresh install attaches nothing, shows no
  banner.

### Negative
- A runtime "is debugging this browser" banner appears while enforcement is
  active for a delegated tab. Mitigated by opt-in + honest popup explanation +
  prompt teardown, but it is a visible change from today's zero-banner runtime.
- Reconciliation logic (attach/detach across SW death, tab lifecycle, delegation
  changes) is genuinely stateful and must be covered by tests, including the
  detach-race and SW-restart paths.
- A fourth enforcement surface to keep honest in docs/listing alongside the
  ADR-006 disclosure family.

### Neutral
- Against external CDP frameworks that own the debugger slot, this layer adds no
  enforcement (attach fails) — detection + the ISOLATED `isTrusted`/CDP gates
  remain their line of defense, exactly as today. This is a documented boundary,
  not a regression.
- The page-realm interceptor stays in place as the default and the fail-safe
  fallback; nothing shipped in #47–#50 is removed.
