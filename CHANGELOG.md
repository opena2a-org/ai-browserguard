# Changelog

All notable changes to AI Browser Guard are documented here.

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
  consent gates keep all three network paths off until the user opts in.

### Fixed
- Resolves the v0.3.0 Web Store rejection follow-through: removed the dead
  `chrome.identity` login code so the shipped bundle references no `identity`
  permission, and added `homepage_url` to the manifest. (Carried from the
  release-readiness work merged ahead of this release.)
