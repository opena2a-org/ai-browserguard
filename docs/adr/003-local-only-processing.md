# ADR-003: Local-Only Processing With Zero Network Requests

**Status:** Superseded by [ADR-006](006-opt-in-network-features.md) (2026-06-02)
**Date:** 2026-02-27

> **Note (2026-06-02):** The absolute "zero network requests" claim in this ADR
> is superseded by ADR-006. The extension still makes **zero network requests by
> default**, but three optional, consent-gated community-intelligence features
> (AIM lookup, registry lookup, anonymized contribution) can be enabled by the
> user. The local-only engineering measures below (self-hosted fonts, no external
> scripts, no analytics SDKs) remain in force. See ADR-006 for the accurate
> network posture.

## Context

AI Browser Guard is a security tool that monitors all browser activity to
detect automation frameworks. This privileged position -- content scripts on
every page, access to DOM events, visibility into navigation patterns --
means any data exfiltration, even accidental, would be a severe privacy
violation.

Users installing a security extension expect it to protect them, not to
report their browsing behavior to a remote server. Extensions that phone
home erode user trust and face scrutiny during Chrome Web Store review.

AI Browser Guard has no server-side component. There is no account
system, no subscription validation, and no cloud features.

## Decision

The extension makes zero network requests. All detection logic, delegation
rule evaluation, and session logging runs locally in the browser. Specific
measures:

- **No analytics or telemetry.** No Google Analytics, no Mixpanel, no
  custom event tracking.
- **No crash reporting.** Errors are logged to `console.error` and the
  session timeline only. No Sentry, no Bugsnag.
- **Self-hosted fonts.** The Inter font is bundled as `fonts/inter-latin.woff2`
  and copied into `dist/fonts/` by `scripts/build.js`. No Google Fonts CDN.
- **No external scripts.** Content Security Policy in the popup HTML does not
  permit external script sources.
- **No update check endpoint.** Chrome handles extension updates via the
  Web Store; no custom update mechanism.

Storage uses `chrome.storage.local` exclusively, which is sandboxed to the
extension and not accessible to web pages or other extensions.

## Consequences

### Positive
- Full compliance with GDPR, CCPA, and similar privacy regulations without
  requiring a privacy policy server or data processing agreements.
- Passes Chrome Web Store review with no network permission justification
  needed. The manifest declares no `webRequest` or host permissions for
  external APIs.
- Eliminates an entire class of vulnerabilities: no SSRF, no data
  exfiltration channels, no man-in-the-middle risk on telemetry endpoints.
- Users can verify the claim by inspecting the Network tab in DevTools
  while the extension runs.

### Negative
- No visibility into crash rates, feature adoption, or user friction
  points. Product decisions must rely on Chrome Web Store reviews, GitHub
  issues, and manual testing.
- Cannot push configuration updates (e.g., new framework detection
  signatures) without shipping a full extension update through the
  Chrome Web Store.
- Debugging production issues requires users to manually export session
  logs or reproduce problems locally.

### Neutral
- Future Pro/Enterprise tiers may introduce opt-in cloud features (AIM
  delegation token verification, registry trust queries). Those tiers
  will require a separate ADR and explicit user consent before any
  network communication is enabled.
