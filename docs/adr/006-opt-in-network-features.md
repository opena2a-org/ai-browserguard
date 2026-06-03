# ADR-006: Opt-In Community Intelligence Network Features

**Status:** Accepted
**Date:** 2026-06-02
**Supersedes:** ADR-003 (the absolute "zero network requests" stance)

## Context

ADR-003 (2026-02-27) committed the extension to "zero network requests" and
described any future cloud features as a hypothetical Pro/Enterprise tier
requiring a separate ADR and explicit consent. That separate tier did not
materialize. Instead, three optional, consent-gated network features were
added directly to the free extension:

1. **AIM identity lookup** -- when an agent is detected, optionally query
   `aim.opena2a.org` for a published identity and trust score for that agent
   type, to enrich the detection display.
2. **Registry trust lookup** -- optionally query `api.oa2a.org` for a registry
   trust score for the detected agent type.
3. **Anonymized contribution** -- optionally share anonymized detection and
   behavior summaries with `api.oa2a.org` to improve community threat
   intelligence.

Each feature is gated and ships **default OFF**. A fresh install makes zero
network requests. But ADR-003, the privacy policy, and the Chrome Web Store
listing all stated the "zero network requests" claim **absolutely** ("makes
zero network requests", "no data transmission of any kind"). Because the
opt-in capability now exists in the shipped code, those absolute claims are
inaccurate as written, even though the default behavior matches them.

The v0.3.0 Web Store rejection ("Purple Potassium", unused `identity`
permission) is a separate issue and is already fixed (ADR/commit removing the
dead `chrome.identity` login code). This ADR addresses disclosure accuracy so
the resubmitted listing, privacy policy, README, and code tell one consistent
story.

## Decision

The extension's network posture is **off by default, optional opt-in**. We
replace the absolute "zero network" claim with an accurate, specific
disclosure across every surface (privacy policy, README, store listing,
in-product settings).

Binding constraints on the opt-in features:

- **Default OFF.** `DEFAULT_SETTINGS.aimLookupEnabled = false`,
  `registryLookupEnabled = false`; contribution consent defaults `enabled: false`.
  A fresh profile makes no request to `aim.opena2a.org` or `api.oa2a.org`
  before the user opts in.
- **Threat-intelligence only, no telemetry.** We do not add usage analytics,
  behavioral telemetry, crash reporting, or any tracking. The only outbound
  data is the trust-lookup query (the detected agent/framework type) and, if
  the user opts into contribution, anonymized detection/behavior summaries.
- **What may be transmitted, and only on opt-in:**
  - Trust lookups: the **detected agent type** string (for example
    `playwright`) in the request path/query. Nothing else. The page origin is
    used only as a local cache key and is never sent.
  - Contribution: an **anonymous contributor token** (`bg-<extensionId>`, for
    dedup only, not user-identifying), the detected **framework name**,
    detection summaries (agents found, framework types), behavior summaries
    (interaction count, success rate, anomaly count), tool version, and
    timestamps.
- **Never transmitted:** full URLs, page content, form data, keystrokes,
  cookies, authentication tokens, personal identity, or browsing history.
- **One-click opt out.** Disabling the setting or revoking contribution
  consent stops all outbound requests immediately; queued contribution events
  are cleared.

## Consequences

### Positive
- Disclosure is accurate and verifiable: a reviewer can confirm both the
  default-off behavior (DevTools Network tab on a fresh profile shows no
  requests) and the exact opt-in payloads (in source).
- Preserves the genuinely private default while allowing users who want
  community threat intelligence to opt in with informed consent.
- Removes the contradiction that would surface during Web Store review or an
  adversarial audit ("the listing says zero network, but the code can POST to
  api.oa2a.org").

### Negative
- The listing and policy are longer and more nuanced than a flat "zero
  network" claim. We accept the extra words as the cost of accuracy.
- We must keep all four surfaces (policy, README, listing, settings UI) in
  sync whenever a network path changes. A drift here is a disclosure bug, not
  a cosmetic one.

### Neutral
- ADR-003's local-only engineering measures (self-hosted fonts, no external
  scripts, no analytics SDKs, `chrome.storage.local` only) remain in force.
  This ADR narrows only ADR-003's absolute network claim; it does not loosen
  any of those measures.
