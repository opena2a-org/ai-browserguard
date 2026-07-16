# Release smoke test (manual, before every Web Store publish)

This is the new-user walkthrough that unit tests do not cover. Run it against
the freshly built `dist/` (run `npm run build` first), loaded as an unpacked
extension in Chrome (`chrome://extensions` -> Developer mode -> Load unpacked ->
select the repo root).

It exists because v0.4.0 shipped two regressions that every unit test passed
over: a shield emoji in the block toast and a gear emoji on the settings button
(house style bans emoji in product UI), and a report export download that
silently did nothing from the action popup (the object URL was revoked
synchronously before the browser could read the blob). Neither was caught
because nothing exercised the rendered popup or the real download.

## Automated portion

```
npm run build
npm test                 # unit + lock-in suites (incl. no-emoji + download)
npm run smoke:export     # real-extension: popup chrome + export download
```

`npm run smoke:export` loads the actual extension and asserts the settings icon
is an inline SVG (not an emoji), no emoji text nodes render, and the popup loads
with no uncaught errors. It attempts the real action-popup export+download but
will SKIP that one check when run head-less (chrome.action.openPopup needs a
focused OS window); the export logic itself is locked in by
`src/popup/download.test.ts` and `src/background/report-download.test.ts`.

## Manual portion (do this part by hand at least once per release)

1. Load `dist/` unpacked. Open the popup from the toolbar.
2. Settings button: confirm it shows a cog icon (SVG), not a gear emoji.
   Hover -- tooltip "Settings". Click -- settings panel toggles.
3. Trigger a block (e.g. run an automation tool against a page, or use a
   detection fixture) and confirm the inline toast renders a monochrome shield
   icon, not an emoji, with WHAT / WHY / Allow once / Whitelist / Settings.
4. Report export download (the regression that prompted this doc):
   - Generate at least one session report (let a detected session end, or seed
     `chrome.storage.local` with a `reports` array).
   - Open the popup, go to Session Reports, open a report, click **Export JSON**.
   - Confirm a `report-XXXXXXXX.json` file actually lands in Downloads and its
     contents are the report (not empty, not truncated).
   - Repeat with the popup losing focus mid-click to exercise the service-worker
     fallback (chrome.downloads). The file must still land.
5. Emoji sweep: no emoji anywhere in the rendered popup, toast, or notifications.
   `npm test` enforces this at the source level (`no-emoji.test.ts`), but eyeball
   the running UI too.
6. Site safety declarations (ADR-009), the only feature that contacts a site we
   do not operate. The unit suite proves the gate and the parser; this proves the
   wire.
   - **Default off, verified on the wire.** On a fresh profile, open DevTools ->
     Network on the service worker, run an agent against any HTTPS page, and
     confirm **no** request to `/.well-known/ai-safety.txt`. This is the store
     listing's "zero network requests by default" claim; `npm test` asserts it in
     code, but confirm it on a real profile at least once per release.
   - **On, against the one real declaration.** Enable "Read site safety
     declarations" in Settings. Point an agent at `https://opena2a.org` (the only
     published declaration known to exist). The agent card must show: Site-authored
     content = Claimed, Injection-hardened = **Not claimed**, Consistent rendering
     = Claimed, Contact, Last verified, no Attestation row, plus the self-asserted
     caveat. Confirm "Not claimed" reads as neutral information and not as a
     warning -- that site publishes injection payloads deliberately, and the UI
     must not shame it for saying so.
   - **A site with no declaration** (any other HTTPS site) shows "No declaration
     published" in muted text, never a warning or a lowered score.
   - **The request carries nothing.** In the Network panel, inspect the
     `ai-safety.txt` request: no `Cookie` header, no referrer, and no redirect
     followed. If a `Cookie` header is present, stop -- that contradicts the
     privacy policy and is a release blocker.
   - **Opt-out clears state.** Turn the setting back off; declarations disappear
     from the popup and `chrome.storage.local` no longer holds
     `aiSafetyDeclarationCache`.

## Sign-off

Do not publish to the Web Store unless every manual step above passes on the
exact `dist/` being uploaded. Note: adding the `downloads` permission (0.4.1)
triggers a fresh Web Store permission review.

**Disclosure gate (ADR-006, ADR-009). Blocking.** The release that first ships
site safety declarations MUST update these surfaces in the same release, because
each still carries v0.5.0's claim that OpenA2A's own servers are the only ones
the extension can contact. That claim is false once `aiSafetyTxtEnabled` exists
in the build, whatever its default.

| Surface | Where | Status |
|---|---|---|
| Store listing | `docs/chrome-web-store-description.md`, `docs/store-listing.md` | pinned to v0.5.0 — rewrite at release |
| **Live privacy policy** | `opena2a-website/app/aibrowserguard/privacy/page.tsx` (**different repo**) | still says "only servers it can contact" |
| Product page | `opena2a-website/app/aibrowserguard/page.tsx` | check its network claims |
| Store-launch blog post | `opena2a-website/app/blogs/ai-browser-guard-chrome-web-store/page.tsx` | check its network claims |

All four were deliberately NOT edited when the feature was built: they correctly
describe the build that is live, and editing them early would claim a feature
users do not have -- drift in the other direction. Write the new text at release
from `docs/privacy-policy.html` §2a, §5 and §7, which are current.

Note that ADR-006 speaks of "all four surfaces (policy, README, listing, settings
UI)". That enumeration is incomplete, and this is where it bites: the policy a
user actually reads is `opena2a.org/aibrowserguard/privacy`, served from the
**opena2a-website repo**, not the `docs/privacy-policy.html` in this one. That
copy is the disclosure of record. `network-disclosure-consistency.test.ts` holds
this repo's policy and README automatically; the store listing and everything in
opena2a-website are outside its reach, so they are manual gates here.
