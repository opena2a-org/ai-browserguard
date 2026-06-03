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

## Sign-off

Do not publish to the Web Store unless every manual step above passes on the
exact `dist/` being uploaded. Note: adding the `downloads` permission (0.4.1)
triggers a fresh Web Store permission review.
