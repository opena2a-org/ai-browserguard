# Release smoke test (manual, before every Web Store publish)

This is the new-user walkthrough that unit tests do not cover. Run it against
the freshly built `dist/` (run `npm run build` first), loaded as an unpacked
extension in Chrome (`chrome://extensions` -> Developer mode -> Load unpacked ->
select `dist/`).

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
npm run smoke:arming     # real-popup wizard -> Read-Only rule -> block + toast
npm run smoke:downloads  # real-extension: user downloads beside a CDP agent
npm run smoke:devtools   # real-extension: user download in a tab with DevTools open
npm run smoke:playwright # real-extension: Playwright drives a page, detection recorded
npm run smoke:notices    # real-extension: block notices for a click, typing and a form submission
```

`npm run smoke:playwright` loads the built extension in the Chromium build
Playwright installs (`npx playwright install chromium`) and drives a local page
with Playwright. It asserts that the stack seen inside `page.evaluate()`
carries `UtilityScript` frames, that the extension's session for the page
records an "Agent detected: Playwright" entry, and that
`chrome.debugger.getTargets()` lists the page as attached. It prints the agent
type the session names without asserting it. It must report 0 failed.

`npm run smoke:export` and `npm run smoke:playwright` run in Playwright's
Chromium, which `npm ci` does not download: install it once with
`npx playwright install chromium`. `npm run smoke:arming`,
`npm run smoke:downloads`, `npm run smoke:devtools` and
`npm run smoke:notices` use the browser Puppeteer installs.

`npm run smoke:downloads` loads the built extension with a session delegation
set to Read-Only, built as the wizard builds it (no site patterns), and one
external CDP client attached to one tab, the setup in #69. With Browser-layer blocking off and then on, it asserts that the user's
own downloads in other tabs complete (one from another site, one from the
agent's site), are recorded as uncertain and as a host match, and are not
counted as blocked actions. It also asserts that a download the client starts
in its own tab completes with Browser-layer blocking off, and with it on is
cancelled, recorded as started in the agent's tab and counted once. It opens a
browser window and needs no OS focus. It must report 0 failed.

`npm run smoke:devtools` loads the built extension with a session delegation
set to Read-Only as the wizard builds it (no site patterns), Browser-layer
blocking on, and DevTools open on every tab
(`--auto-open-devtools-for-tabs`, the same front end F12 opens). No automation
client touches a page. It first records what an open DevTools window looks
like to the extension: the inspected page reports `attached: true` in
`chrome.debugger.getTargets` and a `devtools://` front end is listed, and the
tab is registered from that attachment at `medium` confidence. It then asserts
that the user's download in that tab completes, is recorded as a host match
and is not counted as a blocked action. It opens a browser window and needs
no OS focus. It must report 0 failed.

`npm run smoke:downloads` and `npm run smoke:devtools` write their settings to
storage and reload the extension so the background loads them. Chrome 154
leaves an unpacked extension disabled after a reload in a profile where
Developer mode is off, so each of the two first turns Developer mode on in its
temporary profile (`scripts/smoke-profile.mjs`). Both pass on Chrome for
Testing 145, the browser Puppeteer installs, and on Google Chrome 154. To run
them on an installed browser, set `CHROME_PATH` to its binary.

`npm run smoke:notices` loads the built extension with a session delegation
set to Read-Only as the wizard builds it (no site patterns) and opens
`scripts/inpage-agent-fixture.html` over http. With the fixture's spray of
synthetic mouse moves and clicks running, it dispatches the fixture's
synthetic click, keydown, input and submit events from page script, and reads
the block notices on the page through the debugging protocol, since page
script cannot open the closed shadow root that holds them. It asserts that the
four events are blocked and that the notices then read, oldest first,
`Blocked click. ×7` (the spray's six clicks and the fixture's click),
`Blocked text input. ×2` (the keydown and the input),
`Blocked form submission.`: at most three are shown, the oldest is dropped
first, and a block identical to the newest notice counts on it. The form
submission notice offers no Allow once and is still shown after the other two
are dismissed at 8 seconds. Ten more blocked clicks count on one new notice
below it, `Blocked click. ×10`. It stops the spray after the submit event, so
that the spray's next burst does not change the notices it reads. It also
asserts that the content script threw no exception, and prints the text of
every notice. It loads the extension over the debugging pipe like the two
downloads smokes, turns Developer mode on in its temporary profile the same
way, and runs headless, so it needs no display and no OS focus. It passes on
Chrome for Testing 145, the browser Puppeteer installs, and on Google Chrome
155 with `CHROME_PATH` set to its binary. It must report 0 failed.

`npm run smoke:arming` closes manual step 3 below: it opens the REAL toolbar
popup (`chrome.action.openPopup`), walks the Configure wizard to activate a
Read-Only rule, asserts the rule persisted, then drives the in-page agent
fixture and asserts the monitor block fires and the toast renders. It needs an
OS-focused Chrome window, which a background-spawned Chrome cannot obtain
while you are actively using the machine. On `SKIP-ENV` (exit 3), keep hands
off the keyboard/mouse for ~60 seconds and re-run. It must report ALL GREEN at
least once per release.

`npm run smoke:export` loads the actual extension and asserts the settings icon
is an inline SVG (not an emoji), no emoji text nodes render, and the popup loads
with no uncaught errors. It attempts the real action-popup export+download but
will SKIP that one check when run head-less (chrome.action.openPopup needs a
focused OS window); the export logic itself is locked in by
`src/popup/download.test.ts` and `src/background/report-download.test.ts`.

### Browser each smoke needs

| Script | Browser it needs |
|---|---|
| `npm run smoke:load` | Chrome for Testing, the browser Puppeteer installs (`npx puppeteer browsers install chrome`) |
| `npm run smoke:scenarios` | Chrome for Testing |
| `npm run smoke:scope` | Chrome for Testing |
| `npm run smoke:arming` | Chrome for Testing, in a window with OS focus |
| `npm run smoke:cdp` | Chrome for Testing, in a window with OS focus |
| `npm run smoke:export` | Playwright's Chromium (`npx playwright install chromium`) |
| `npm run smoke:playwright` | Playwright's Chromium (`npx playwright install chromium`) |
| `npm run smoke:downloads` | Chrome for Testing, or the installed browser that `CHROME_PATH` names |
| `npm run smoke:devtools` | Chrome for Testing, or the installed browser that `CHROME_PATH` names |
| `npm run smoke:notices` | Chrome for Testing, or the installed browser that `CHROME_PATH` names |
| `npm run smoke:popup-layout` | Playwright's headless Chromium (`npx playwright install chromium`); it loads no extension |

The first seven load the extension with `--load-extension` and do not read
`CHROME_PATH`; Google Chrome 155 ignores that flag, and on it the five that use
Puppeteer stop once no service worker of the extension appears and print what
to run instead.

## Manual portion (do this part by hand at least once per release)

1. Load `dist/` unpacked. Open the popup from the toolbar.
2. Settings button: confirm it shows a cog icon (SVG), not a gear emoji.
   Hover: tooltip "Settings". Click: settings panel toggles.
3. Trigger a block (e.g. run an automation tool against a page, or use a
   detection fixture) and confirm the inline toast renders a monochrome shield
   icon, not an emoji, with WHAT / WHY / Settings. Allow once appears only for
   a medium or low severity block (for example a text input or a new tab on an
   ordinary site). A click or a form submission shows no Allow once, and on a
   sensitive site (an address containing `.bank.`, for example) neither does a
   text input; a new tab there still offers it.
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
     warning. That site publishes injection payloads deliberately, and the UI
     must not shame it for saying so.
   - **A site with no declaration** (any other HTTPS site) shows "No declaration
     published" in muted text, never a warning or a lowered score.
   - **The request carries nothing.** In the Network panel, inspect the
     `ai-safety.txt` request: no `Cookie` header, no referrer, and no redirect
     followed. If a `Cookie` header is present, stop: that contradicts the
     privacy policy and is a release blocker.
   - **Opt-out clears state.** Turn the setting back off; declarations disappear
     from the popup and `chrome.storage.local` no longer holds
     `aiSafetyDeclarationCache`.
7. Pause the guard (#71). With a Read-Only delegation active and an agent on two
   sites in two tabs:
   - **Pause on this site** from the first tab's popup for 15 minutes. The agent
     can click and type on that site with no toast and no recent-block entry; the
     second tab still blocks. The popup shows the countdown and a Resume button.
   - Navigate the paused tab to another site: actions there are blocked again.
   - **Resume**: blocking returns on the paused site without reloading the tab.
   - **Pause everywhere** for 15 minutes: the header reads "Paused everywhere" and
     neither tab blocks. Press the kill switch: the pause ends, and the panel
     offers no pause until monitoring is resumed.
   - The Recent pauses list shows each pause with its start, end, and how it
     ended.

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
| Store listing | `docs/chrome-web-store-description.md`, `docs/store-listing.md` | rewritten in 0.6.0; confirm it matches the build at each submission |
| **Live privacy policy** | `opena2a-website/app/aibrowserguard/privacy/page.tsx` (**different repo**) | still says "only servers it can contact" |
| Product page | `opena2a-website/app/aibrowserguard/page.tsx` | check its network claims |
| Store-launch blog post | `opena2a-website/app/blogs/ai-browser-guard-chrome-web-store/page.tsx` | check its network claims |

All four were deliberately NOT edited when the feature was built: they correctly
describe the build that is live, and editing them early would claim a feature
users do not have, which is drift in the other direction. Write the new text at release
from `docs/privacy-policy.html` §2a, §5 and §7, which are current.

> **Correction (2026-10-11).** Site safety declarations first shipped in 0.6.0,
> and that release rewrote `docs/chrome-web-store-description.md` and
> `docs/store-listing.md` to disclose them, so the store listing no longer
> carries the v0.5.0 claim. The Store listing row above now says so. The three
> opena2a-website rows are in another repository, are not checked here, and
> keep their status until someone confirms them there.

Note that ADR-006 speaks of "all four surfaces (policy, README, listing, settings
UI)". That enumeration is incomplete, and this is where it bites: the policy a
user actually reads is `opena2a.org/aibrowserguard/privacy`, served from the
**opena2a-website repo**, not the `docs/privacy-policy.html` in this one. That
copy is the disclosure of record. `network-disclosure-consistency.test.ts` holds
this repo's policy and README automatically; the store listing and everything in
opena2a-website are outside its reach, so they are manual gates here.
