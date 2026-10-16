# Changelog

All notable changes to AI Browser Guard are documented here.

## [Unreleased]

### Added
- **A notification tells you when an agent is detected (#103).** When an agent is first detected in a tab, the extension shows a notification naming the agent type (for example "Agent detected: Playwright") and the site, and saying how to use the kill switch: the key currently assigned to it, or Kill Switch in the popup when no key is assigned. It is shown whether or not the agent triggers a block, so an external CDP agent, which triggers no in-page block, is no longer announced only by the agent count on the toolbar icon, which Chrome keeps in the Extensions menu until the icon is pinned. The same agent type detected again in its tab, as after a navigation, shows no second notification; a different agent type in that tab does. An agent of one type opening several tabs shows one notification per 10 seconds; every tab is still listed in the popup. A debugger attachment first seen while DevTools is open is listed but not announced, since it is most likely you inspecting the page. Nothing is shown when notifications are turned off, including for a detection that arrives while the extension's background worker is starting.
- **End a session delegation without granting Full Access (#69).** The popup's delegation panel now has an End button next to Change while a session delegation is active. It turns the session delegation off without putting another preset in its place, so a download it blocked in an agent's tab completes when started again. Before this change the panel offered only Change, and every preset it offered except Full Access still blocks downloads, so the only ways to let a download through under a session delegation were granting Full Access or the kill switch. A grant on an agent's card is not affected by End: it takes precedence over the session delegation in that agent's tab, and the delegation panel now names the detected agents that hold one. The recovery text shown with a blocked download names End among the other controls.
- **Pause the guard on one site, or everywhere for a set time, without disabling the extension (#71).** The popup has a new Pause the guard panel. Pause on this site covers the host name of the active tab only (not its subdomains) for 15 minutes, 60 minutes or until you resume it. Pause everywhere covers every site for 15 or 60 minutes and has no open-ended option. While a pause covers a tab, the guard does not block agent actions there: the in-page interceptor, browser-layer blocking and download cancellation all stand down, so an agent working on that site gets no guard denials. Detection, the session timeline and the kill switch keep working. Each live pause shows a countdown and a Resume button, and blocking returns on its own when the time runs out. The kill switch ends every pause, and no pause can start while it is on. Pauses are listed in a pause history in the popup and on the timeline of each affected agent session, so you can see afterwards what was unguarded and when. Only the popup can start or end a pause; a web page cannot.
- **Each detected agent's card in the popup shows the detection confidence (#104).** A line under the agent's name reads `Confidence: Low`, `Confidence: Medium`, `Confidence: High` or `Confidence: Confirmed`, above the detection time and the detection methods, and its tooltip lists the four levels from lowest to highest. Before this change the card showed the time and the methods only, although the store listing says the popup shows the confidence level. An agent stored without one of these four levels shows no confidence line.
- **An agent's card says what Browser-layer blocking is doing in its tab (#110).** While Browser-layer blocking holds its debugger session on a delegated agent's tab, that agent's card in the popup says so, says what the session is there for, says that this is why Chrome shows its "debugging this browser" banner, and says when the session is removed. What it is there for follows the delegation in force: enforcing the sites it blocks, cancelling downloads started in the tab, or both. Under Read-Only, or Limited without a blocked site, the card names downloads only and no site. When Chrome refuses the session, or ends one the extension held (for example when the banner is cancelled), the card says that instead, with the error or reason Chrome reported. It states what is not done on that tab until the session attaches (the sites the delegation blocks are not enforced at the browser layer, downloads started there are not cancelled, or both, by the same rule), and that the extension retries on its own. For an in-page agent the card adds that page-level enforcement still applies on a best-effort basis; for an agent that drives the browser directly it says that page-level policy does not stop that agent. Before this change a refused or ended session fell back with no notice, and nothing in the popup said which tab the banner was showing for.
- **`npm run smoke:notices` checks the in-page block notices in a real browser.** It loads the built extension under a session delegation set to Read-Only as the wizard builds it, opens `scripts/inpage-agent-fixture.html` with the fixture's spray of synthetic clicks running, and dispatches the fixture's synthetic click, keydown, input and submit events. All four are blocked, and the notices on the page then read, oldest first, "Blocked click. ×7" (the spray's six clicks and the fixture's click), "Blocked text input. ×2" (the keydown and the input), "Blocked form submission.": at most three are shown, the oldest is dropped first, and a block identical to the newest notice counts on it. The form submission notice offers no Allow once and is still shown after the other two are dismissed at 8 seconds, and ten more blocked clicks count on one new notice below it, "Blocked click. ×10". It passes on Chrome for Testing 145 and on Google Chrome 155. The smoke stops the spray after the submit event, so that the spray's next burst does not change the notices it reads. The extension's behaviour is unchanged.

### Removed
- **Detecting an agent no longer sends its type to the OpenA2A AIM (Agent Identity Management) server.** The opt-in AIM identity lookup and its `aimLookupEnabled` and `aimBaseUrl` settings are removed. The lookup sent the detected agent type, for example `playwright`, to `aim.opena2a.org` with no credential. The registry trust lookup (`api.oa2a.org`, setting `registryLookupEnabled`) still asks about the agent type when it is on, and an agent's trust score is now the registry's score; before, it was the average of the two lookups' scores when both returned one. On a profile where an earlier version turned the AIM lookup on, the stored setting is ignored and detection makes no request to `aim.opena2a.org`. The privacy policy, README, `docs/privacy.md` and the store copy now list three optional network features instead of four. The badge on an agent's card in the popup, which read `AIM: N/A` when no trust score was known, now reads `No trust score`.

### Fixed
- **Read-Only, and Limited without a blocked site, now cancel a download started in an agent's tab (#100).** A download is cancelled only when Chrome reports it starting in the agent's tab, on the debugger session Browser-layer blocking attaches there, and that session attached only under a delegation that blocks a site. A Read-Only delegation never blocks one (the wizard has no sites step for it), so with Browser-layer blocking on, the agent's download in its own tab completed and was recorded as a host match. The session now attaches to an agent's tab whenever Browser-layer blocking is on and the tab's delegation does not permit downloads. A session attached only for this reports the downloads started in the tab and pauses none of its requests; Chrome's "started debugging this browser" bar shows while it is attached, as for a blocked site. `npm run smoke:downloads` and `npm run smoke:devtools` now use the Read-Only rule the wizard creates.
- **The in-page block notice no longer offers "Allow once" for a high or critical severity block (#109).** The notice shown on the page when an action is blocked now offers Allow once only for a medium or low severity block, the same rule the Chrome notification already applied. Severity is classified the same way for both: a form submission or script execution is critical; a click, download, page modification or network request is high; and each level rises by one when the page address contains `.bank.`, `.gov.`, `.mil.`, `.financial`, `paypal`, `stripe` or `healthcare`. An address that contains none of these, such as `https://www.irs.gov/` or `https://www.chase.com/`, is not raised. Before this change the notice on the page offered Allow once for every block, so a form submission blocked on a banking site, which the Chrome notification offered no override for, could be let through once from the page. Settings is still offered on every notice.
- **The pause history no longer shows "undefined" for a stored entry it cannot describe, and keeps that entry (#77, #80).** An entry whose end reason is not one of ended on time, resumed by you, replaced by a new pause or ended by the kill switch, such as one written by a later version, is now listed under Recent pauses with the end reason "ended" and stays in storage. Before this change such an entry was listed with the text "undefined" where the end reason belongs. An entry with an ended time but no end reason, or an end reason but no ended time, is dropped when the history is loaded, the same way an entry with a damaged pause or end time already was; before, it was listed as still paused with an end time, or as ended at "now".
- **Pause history rows from another day show the date (#78).** A row in the popup's Recent pauses list now shows the month and day at both ends when the pause started or ended on a day other than today, for example `Oct 4, 09:10 AM to Oct 4, 10:10 AM`. Before this change every row showed only the time, so a pause from a previous day read the same as one from today. Rows that fall entirely within today still show only the time.
- **Pause history rows from another year show the year (#80).** A row in the popup's Recent pauses list now includes the year, for example `Oct 4, 2025, 09:10 AM`, when the pause started or ended in a year other than the current one. Before this change a row from last year showed the same month and day as a row from this year, with no way to tell them apart.
- **A tab the browser replaces with another one no longer keeps its agent and session (#80).** When the browser swaps a tab for a new one (prerendering or instant navigation), the old tab's session now ends and its agent is removed, as when the tab is closed, and the host name recorded for the tab moves to the new tab, so a tab that left a paused site stays guarded. Before this change downloads could still be attributed to the old tab and judged by the records of a tab that no longer existed.
- **A download is cancelled only when it starts in an agent's tab (#69).** Under a delegation that does not permit downloads, a download is now cancelled only when Chrome reports it starting in an agent's tab, on the debugger session Browser-layer blocking attaches to that tab. Before this change, a download was cancelled when its URL, final URL or referrer had the same host name as the page where an agent was detected (and before that, whenever any agent was detected), so the user's own downloads were cancelled with no way back: from another tab of that site, from a link to that host on another site, from another port of that host, and on a site that an open DevTools window had registered as an agent. Those downloads are now recorded in the session log, as a host match when their origin (scheme, host and port) equals the agent page's, and are neither cancelled nor counted as blocked actions. With Browser-layer blocking off, or under a delegation that blocks no site, no download is cancelled.
- **An agent seen only through a debugger attachment leaves when the attachment ends, and an open DevTools window no longer registers one when a download starts.** An agent registered because a debugger was attached to its tab is now removed, and its session ended as disconnected, once that tab has had no debugger attached for 5 seconds. This covers a driver that disconnected and a DevTools window that was closed. A rule granted to that agent stops applying to the tab. The exception is a tab that holds the extension's own Browser-layer blocking session, because that session makes the tab look attached either way. Before this change such an agent stayed registered until its tab closed, even across a restart of the extension's background worker, and every download made in the meantime was recorded against it. When no agent is registered and a download starts, a debugger attachment seen while DevTools is open no longer registers an agent, so that download is not recorded as agent activity. A download's host match now compares against the page open in the agent's tab, not the page where the agent was first seen, so after the agent's tab moves to another site, downloads from the first site are no longer host matches. An agent its own page reported is not affected.
- **A download in a tab where you have DevTools open is no longer cancelled (#69).** An open DevTools window makes the page it inspects look attached to a debugger, as an automation client would, so the extension registered that tab as an agent at medium confidence. Under a delegation that does not permit downloads, with Browser-layer blocking on and a blocked site in the delegation, its session then attached to that tab and your own download there was cancelled as started in the agent's tab, and counted as a blocked action. Such a tab no longer counts as an agent's tab for downloads: a download there is recorded as a host match, or as uncertain, and is left to finish. The tab's card says "Monitor only" rather than "Partly enforced". An agent registered before DevTools was opened in another tab is not affected, and a download started in its tab is still cancelled. An attachment first seen while DevTools is open in any tab is treated the same way, because the target list does not say which page a DevTools window inspects. `npm run smoke:devtools` checks this in a real browser.
- **Your download of the same file as the agent's is no longer cancelled in its place (#92, #98).** Chrome's report that a download started in an agent's tab names the URL but not the download, so when you and the agent downloaded the same URL within 5 seconds of each other, the report went to whichever download the extension handled first: your copy could be cancelled and the agent's left to finish. A report is now matched only to a download created at most 1 second before Chrome reported it, and only when the downloads of that URL that could be the one reported, and have not been matched to a report, are no more than the reports of that URL not yet matched to a download. When they are more, such as yours started in another tab up to 1 second before the agent's while Chrome reports only the agent's, neither is cancelled and both are recorded in the session log. When the agent downloads the same URL twice in its tab, Chrome reports both and both are still cancelled. Your download of that URL started more than 1 second before the report is not one it could be: over 340 downloads on Chrome for Testing 145 and Google Chrome 155, the report reached an extension holding a debugger session on the tab 0 to 8 ms after the download was created (`node scripts/measure-download-start-gap.mjs`). Such a download of yours no longer leaves the agent's uncancelled; before this change, one started up to 5 seconds before the report did.
- **Full Access is described as lasting 60 minutes wherever it is described (#105).** Every Full Access grant expires after 60 minutes, from the wizard and from an agent's card alike. The wizard's preset description, the README's delegation presets table and the store listing copy now say so. Before this change they described Full Access as unrestricted or "everything allowed", with "boundary alerts" that cannot fire because no action is outside the grant, and only the agent card's Confirm Full Access (60m) button named the limit. The README also says what applies once the grant expires: for a grant on an agent's card, the session delegation; for a session delegation, none.
- **The popup's severity badges meet WCAG AA text contrast.** The DETECTED badge on an agent card and the severity label on each blocked action use darker text colours. Every severity level now measures at least 5:1 against the background it is shown on; the DETECTED badge measured 2.9:1 before, below the 4.5:1 minimum for its 11 px text. The popup layout smoke (`npm run smoke:popup-layout`) measures this in each panel that shows a badge.
- **A download no Browser-layer blocking session reports is recorded, and its notice shown, without waiting 5 seconds (#91).** While Browser-layer blocking held a session on any agent's tab, a download that no session reported starting, such as your own download in another tab, waited out the full 5-second matching window before it was recorded on the timeline and before its "Download not stopped" notice appeared. The extension now asks each of its sessions whether a download start is left to report, and goes ahead a quarter of a second after the last one answers. A session that does not answer still holds the download for at most 5 seconds, as before. A download Chrome reports starting in an agent's tab is matched, and cancelled under a delegation that blocks downloads, as before.
- **The privacy policy, README and store description state three limits as the extension applies them (#108).** The policy said violation records were kept up to the 100 most recent entries; no such store exists. A violation in a tab during a detected agent's session is recorded in that session's log, kept with the last 5 sessions; a violation in a tab with no session, such as a tab where no agent was detected, is recorded in no session log. The 20 most recent violations from any tab are held in memory, not saved, for the popup; 100 is the cap on the detection log, which the policy now states. The policy said an unreachable site's safety declaration result is cached for 5 minutes; since 0.7.0 that time doubles after each further failed attempt in a row, up to 4 hours. The policy, README and store description said the contribution tip appears once after 5 detections; it also appears 3 days after the first detection, and stays in the popup until you dismiss it or turn contribution on. The extension's behaviour is unchanged.
- **`npm run smoke:downloads` and `npm run smoke:devtools` run on Chrome 154 (#120).** On Google Chrome 154 both stopped with "Timed out after waiting 20000ms" and checked nothing. Each smoke writes its settings to storage and reloads the extension so the background loads them. Chrome 154 leaves an unpacked extension disabled after a reload in a profile where Developer mode is off, so the extension's worker never started again; Chrome 145 reloaded it either way. Each smoke now turns Developer mode on in its temporary profile before it starts its browser, by starting the browser once on that profile without the extension (`scripts/smoke-profile.mjs`). The debugging pipe, the debugging port and the target filter the smokes use were not the cause. Both smokes pass on Chrome for Testing 145 and on Google Chrome 154.
- **A further detection in a tab is added to that tab's session, not stored as a new one (#122).** Each detection reported for a tab was stored as a new session, including a second and later one from the same tab. Only the last 5 sessions are kept, so six detections in one tab were enough to push another tab's session out of the store. A detection now starts a session only when its tab has no open session in the store. A further detection in the tab is added to the open session's timeline as an "Agent detected" entry, and the session names the agent most recently detected there. A detection that repeats the session's last "Agent detected" entry, the same kind of agent on the same page, adds no entry, and a session keeps its 20 most recent "Agent detected" entries. The count the popup shows as "sessions monitored" now rises once per session started; it rose once per detection before.
- **The in-page block notice fits a narrow viewport (#122).** In a 375 px wide viewport the notice was 363.5 px wide and its left edge sat at x = -4.5, off the screen. Its width now counts its padding and border and is capped at the viewport width less 32 px. Measured in Chrome, it spans x = 16 to 359 in a 375 px viewport and x = 16 to 304 in a 320 px one, and is 366 px wide in a 1280 px viewport, the width it had there before.
- **The in-page block notice fits a narrow viewport beside a page's scrollbar (#126).** The notice was capped at the viewport width less 32 px, a width that includes a classic scrollbar, while its container is placed inside the scrollbar, so in a 375 px viewport with a 17 px scrollbar the notice spanned x = -1 to 342. The container now spans the page's content area less 16 px on each side, and the notice is capped at the container's width. Measured in headless Chromium with a 17 px scrollbar, it spans x = 16 to 342 in a 375 px viewport and x = 16 to 287 in a 320 px one; without a scrollbar it spans x = 16 to 359 in a 375 px viewport, as before.
- **A tab's session keeps its 200 most recent events besides its "Agent detected" entries (#126).** Since a further detection is added to the tab's open session (#122), a session stays open for as long as its tab does, and each allowed action and violation in it was kept, so a page an agent clicked once a second added an entry each second for as long as the tab stayed open. Past 200 such events, the oldest are now dropped. The session's counts of actions, allowed and blocked actions and violations still include the dropped events.
- **A grant on an agent's card keeps applying after the agent's page reports it again (#126).** Each report from the agent's page names the agent by a new id, and a grant on the agent's card is bound to the agent's id, so from the agent's next report on, its tab fell back to the session delegation or to no rule, and a Read-Only grant no longer blocked the agent's input. An agent of the same type reported again in its tab now keeps the id it was registered under, and its session and the detection log name it by that id. A different type of agent in the tab is still a new agent, which the grant does not cover.
- **A page reports its agent once, not again every few seconds (#126).** The content script's check for a repeated report compared each check's agent id with the last one, and each check draws a new id, so it never matched; the WebDriver and CDP monitors reported with no check. A page whose root element is `<html webdriver>` added a report to the 100-entry detection log every few seconds while it stayed open, pushing other pages' detections out. The same type of agent on the same page address is now reported once, and reported again when its page moves to another address.
- **A page can no longer fill the extension's storage with a long element id or page address (#126).** Each stored action kept its target element's full id as its selector, and the page's full address, with no length limit, in the storage quota the extension's settings, delegation rules and kill-switch state share. A stored event's address is now cut to 1,024 characters and its selector to 256, the last character of each an ellipsis, and the page address stored with a detection is cut to 1,024 characters the same way.
- **The block notice names the delegation by the title the wizard shows (#133).** A blocked action read `Action "click" is not permitted under readOnly delegation.`, the preset's storage identifier. It now reads `Not permitted under the Read-Only delegation.`, and `Not permitted under the Limited Access delegation.` under Limited Access.
- **A block notice identical to the newest one counts on it instead of stacking (#133).** A burst of six synthetic clicks under Read-Only filled the three-notice stack with copies of `Blocked click.` and pushed out an earlier notice that differed. A notice with the same action, page and reason as the newest one on screen now shows a count on that notice (`Blocked click. ×6`) and restarts its dismiss timer.
- **The popup header shows the kill switch key Chrome has assigned (#133).** The header showed `Ctrl+Shift+K` on every platform, including macOS, where the suggested key is `Command+Shift+K`. It now shows the key `chrome.commands.getAll()` reports for the kill switch, and when no key is assigned it reads `No shortcut: set one`, a button that opens `chrome://extensions/shortcuts`.
- **`npm run smoke:export` names the browser to install when Playwright's Chromium is missing (#133).** It stopped with Playwright's generic install banner. It now checks the executable before it launches, prints the missing path and `Install it with: npx playwright install chromium`, and exits 1. `CONTRIBUTING.md` and `docs/testing/release-smoke.md` say that this smoke runs in Playwright's Chromium.
- **The storage schema version is saved when the extension first reads an empty store (#134).** Before, it was saved only by a read that found stored data with the version missing or older, and that read logged it under `__corrupted_state` in the extension's storage. On a fresh profile nothing is stored at the first read, so the first data the extension saved, such as a session, went in without a version, and the next read logged a `storageSchemaVersion` entry that stayed in storage. With the version saved first, a later read finds it and logs nothing: in a test that reads an empty store, saves a session and a detection-log entry, and reads again, `__corrupted_state` stays empty. Entries already in `__corrupted_state` are kept.
- **`npm run bump` names the failed tests when it puts the version back (#134).** When the test suite failed, the script printed `Tests failed. Fix tests before bumping.` and named no test, so a bump run before the changelog heading was renamed did not say that `manifest, package, and changelog declare the same version` was the test failing. It now lists the failed tests vitest reports, by file and test name, then says it put `manifest.json`, `package.json` and `STATUS.md` back to the previous version. `CONTRIBUTING.md` has a Releasing section that gives the order: rename the `## [Unreleased]` heading in `CHANGELOG.md` to the new version, then run `npm run bump`.
- **`npm run smoke:export` opens the report with its View Report button (#134).** To reach Export JSON in the action popup, the smoke clicked the report's row in the Session Reports list. The row has no click handler, so the list stayed in place and the check `Export JSON button reachable in action popup` found no button. The smoke now clicks View Report, which opens the report's detail view with Export JSON.
- **The smokes that load the extension with `--load-extension` say why they stop on a browser that ignores the flag.** Google Chrome 155 ignores `--load-extension` and starts with no extension. With `PUPPETEER_EXECUTABLE_PATH` set to it, `npm run smoke:load` and `npm run smoke:scope` reported `FAIL  service worker registers`, and `npm run smoke:scenarios`, `npm run smoke:arming` and `npm run smoke:cdp` stopped on a timeout error; none of them said why. When no service worker of the extension appears, these five now print the version and executable of the browser that ran, that it ignored `--load-extension`, and two things to run instead: the smoke on Chrome for Testing, the browser Puppeteer installs, or `npm run smoke:downloads` and `npm run smoke:devtools`, which load the extension over the debugging pipe, on that browser through `CHROME_PATH`. They then exit with code 1 before their other checks. When `dist/` has no `manifest.json` they say to run `npm run build` instead, and when the browser lists the extension they say that the service worker they wait for did not appear and give the errors the browser lists for the extension. `docs/testing/release-smoke.md` lists the browser each `npm run smoke:*` script needs. On Chrome for Testing the five run as before.
- **`npm run bump` puts the version back when a test file fails to load (#140).** A test file that failed to load, in a run whose other tests passed, made vitest exit 1 while its summary still read `Tests  N passed (N)`. When that summary was not coloured, as in a run with neither `CI` nor `FORCE_COLOR` set, the script took the line as a pass: it kept the new version in `manifest.json`, `package.json` and `STATUS.md` and built. A non-zero exit from vitest now fails the bump: the script names the file that failed to load, puts the three files back to the previous version, exits 1 and does not build.
- **The smokes that load the extension with `--load-extension` say the browser ignored the flag only when its log says so (#142).** On Chrome for Testing 145, with a `dist/` holding only a `manifest.json` that names a missing `background/index.js`, `npm run smoke:load` printed `This browser ignored --load-extension`, and its first remedy was to run the smoke on Chrome for Testing, the browser that had just run. That browser had refused the extension, which also leaves `chrome://extensions` listing no extension from `dist/`. `npm run smoke:load`, `npm run smoke:scope`, `npm run smoke:scenarios`, `npm run smoke:arming` and `npm run smoke:cdp` now start the browser with `--enable-logging`, and when no service worker of the extension appears and `chrome://extensions` lists no extension from `dist/`, they read the browser's log, `chrome_debug.log` in its profile. When the log has a `Failed to load extension from` line for `dist/`, they say the browser refused the extension, print the error it logged (`Could not load background script ''.` on the run above) and say to run `npm run build`. When the log has the line Google Chrome 155 writes, `--disable-extensions-except is not allowed in Google Chrome, ignoring.` (or the same for `--load-extension`), they say the browser ignored `--load-extension`, quote the line and give the two things to run instead, as before. When it has neither, they name both causes and say to check the manifest by loading `dist/` with Load unpacked on `chrome://extensions`.

### Changed
- **`STATUS.md` states the review it gets (#133).** The maintenance horizon said the status was reviewed quarterly, and no review was recorded after 2026-05-24. It now says that `npm run bump` updates the version in the stage rationale at each release and that the table records each stage change.
- **The in-page block notice no longer has a Whitelist button (#69).** In 0.7.0 the notice shown on the page when an action was blocked offered `Whitelist <site>` next to Allow once and Settings. The button asked the background to allow the site, a request the background accepts only from the popup, so a click on it added nothing. The notice now offers Allow once, for a medium or low severity block (#109), and Settings, which opens the popup. To allow a blocked site, use the popup: Allow beside the site under Recently Blocked Domains, or `Whitelist <site>` on the block under Recently blocked.
- **The in-page monitor's list of blocked events is removed (#122).** The content script pushed each event it blocked to a list of up to 50 that no code read. The list is gone, along with the line of `docs/architecture.md` that stated its cap. Counting a block and reporting it are not changed.
- The download notification, the session log labels, the popup's recovery hint, the delegation preset descriptions and the external-agent card now say that a cancellation is tied to the agent's tab. The external-agent card shows "Partly enforced" only while the agent's tab holds the Browser-layer blocking session. Download events in the session log carry a structured `attribution` field (`tab`, `host` or `none`).
- **A download from an agent's site that was not seen starting in the agent's tab is left to finish, and you are told (#69).** Under a delegation that does not permit downloads, such a download now shows a "Download not stopped" notification naming the file and the site, unless notifications are turned off; a burst shows one notification per 10 seconds. It is not listed under Recently blocked or counted as a blocked action. It is not paused for you to keep or discard either: in Chrome 145, a paused download from a short-lived link without range support was lost when the server closed the connection during the wait, and a blob: download finished while reported paused (`node scripts/measure-download-hold.mjs` repeats the measurement).
- **The recovery text shown with a blocked download names the control for the rule that blocks it (#69).** When the blocked downloads in the popup come from one detected agent, the hint now says which rule blocks downloads in that agent's tab and what frees them: for a grant on the agent's card, Revoke on its card, and what governs the agent afterwards; for a session delegation, End on the session delegation; when both block downloads, Revoke together with End. Closing the agent's tab is still offered first. Once Revoke or End leaves no rule blocking downloads in that tab, the hint says to retry the download and the Other controls list is not shown. Blocks from more than one agent, or from an agent no longer detected, keep the general hint. Before this change the hint was the same for every block and left the user to work out which of the listed controls applied.
- **The recovery text shown with a blocked download says to retry while a pause covers the agent's tab (#69).** When a pause on the site now in the agent's tab, or a pause everywhere, is live, the hint shown with the blocked download says that no delegation blocks downloads there until the pause ends and to retry the download, and the Other controls list is not shown. A download started in a paused tab is not cancelled, so the retry completes. After the pause ends the hint names the control for the rule in force again. Before this change the hint named Revoke on the card or End on the session delegation during a pause, though neither was needed to get the file.
- **The package description, the privacy policy and the architecture overview state the enforcement scope the README states (#106).** They said the extension blocks an agent's scripted navigations, form submissions and downloads, and that the kill switch terminates agent access. They now say that navigation and form blocking applies to in-page automation only and is best-effort; that a download is cancelled only in an agent's tab, with the off-by-default Browser-layer blocking setting on and a delegation that does not permit downloads, whether or not it blocks a site (#100); and that the kill switch revokes delegations and closes the tabs an agent controls, without ending an external automation session, whose driver can reopen a tab. No behaviour changed.

### Docs
- **A smoke drives Playwright with the built extension loaded (#101).** `npm run smoke:playwright` loads the built extension in the Chromium build Playwright installs, drives a local page with Playwright, and checks that the stack seen inside `page.evaluate()` carries `UtilityScript` frames, that the extension's session for the page records a Playwright detection, and that `chrome.debugger.getTargets()` lists the page as attached. The Detected Frameworks page named no harness for Playwright; it now names this one. A session names the agent most recently detected in its tab, and in runs on Chromium 145.0.7632.6 a generic detection followed the Playwright one, so the session named the agent CDP Agent; the page says so. No harness drives OpenAI Operator, and the Anthropic Computer Use harness still drives Firefox, not Chrome with the extension loaded.
- **The README's Detected Frameworks section says which detections have been run against the real framework (#101).** It said every method had been verified against the real framework. It now names the harnesses that exist: Puppeteer and Selenium are driven in Chrome by scripts that record the signals a page sees, and the smoke tests drive pages with Puppeteer while the built extension is loaded. No harness drives Playwright or OpenAI Operator, and the Anthropic Computer Use harness drives Firefox to a probe page, not Chrome with the extension loaded. The OpenAI Operator row said Operator is detected the same way as Playwright plus cloud environment signals; it now describes what the code checks: environment signals only, separate from Playwright detection, reported when any two of a Linux platform, `Operator` or `OpenAI` in the user agent, zero browser plugins, and a SwiftShader, llvmpipe or Google ANGLE WebGL renderer are present. A test checks the section against the scripts it names and the signals the Operator check reads.
- **The store copy says when Allow once is offered (#122).** The Boundary Violation Alerts item in the store description and the store listing promised "the option to allow it once" for the blocked actions it lists, a click and a form submission among them. Neither the notice on the page nor the Chrome notification offers it for those two. The item now says Allow once is offered for a blocked text input, navigation or new tab on an ordinary site, and not for a click or a form submission.
- **The README's scope of enforcement covers a tab where no agent was detected (#122).** A session delegation is also the rule in such a tab, and in-page blocking stops an untrusted `click`, `keydown`, `input` or `submit` event the rule does not permit whether an agent or the page's own script dispatched it. The README now says so, says what you see when a page's own event is blocked there (the block notification, the `!` badge and the popup entry, with nothing added to the detection log or a session log), and names Pause the guard on that site as the way to let its events through.
- **A sensitive address is described by the patterns that make it one (#122).** A block below critical severity is raised one level when the page address contains `.bank.`, `.gov.`, `.mil.`, `.financial`, `paypal`, `stripe` or `healthcare`. `https://www.irs.gov/` and `https://www.chase.com/` contain none of these and are not raised. The entry for #109 described the rule as "a sensitive site such as a bank, payment or government site"; that entry and `docs/architecture.md` now name the patterns and these two addresses. The patterns are unchanged.
- **The v0.5.0 store text describes Full Access as lasting 60 minutes (#122).** `docs/store-description-v0.5.0.txt` read "Full Access (everything allowed, with logging and alerts)" and offered "the option to allow it once" for a blocked action without saying which kinds. It now carries the Full Access and Allow once wording of the current store description.
- **The README is shorter; its reference text moved to pages it links.** The full scope of enforcement, including which downloads are cancelled and what you see when a page's own scripted event is blocked in a tab with no detected agent, is in `docs/enforcement-scope.md`; the Detected Frameworks section in `docs/detected-frameworks.md`; ending a delegation, pausing the guard and browser-layer blocking in `docs/delegation.md`; each optional network feature in full in `docs/privacy.md`; building from source in `docs/install.md`; and the Development and Contributing sections in `CONTRIBUTING.md`. The README keeps the feature list, a short scope of enforcement with a short note on tabs with no detected agent, the install link, the delegation presets table, what each network feature sends and to where, and a Documentation section linking each page. The test count leaves the development commands, so the README states none, and `npm run bump` no longer writes to the README.
- **The README's opening paragraph is shorter.** It says what the extension detects, that it cannot block per-action input from external frameworks that drive the browser over CDP and what it does against those, and links `docs/enforcement-scope.md`. Its sentences on in-page blocking and on cancelling a download in an agent's tab moved, as written, to that page. The demo recording sits below the install link, above the first section, and the Scope of enforcement and Tabs with no detected agent notes are two quotes instead of one.
- **The release smoke doc says to load `dist/` (#134).** Its opening said to select the repo root under Load unpacked, while its step 1, `docs/install.md` and the build output say `dist/`. It now says `dist/`.
- **ADR-002 gives the popup stylesheet's size rounded (#134).** Its correction note gave `dist/popup/styles.css` as 28,557 bytes, the size when the note was written; a change to the popup's styles later that day made it 28,929 bytes. The note now gives about 29 KB, rounded as it rounds `popup.js`, since both change with the popup.
- **The release smoke doc names the browser `npm run smoke:playwright` runs in (#143).** It said `npm run smoke:export` runs in Playwright's Chromium and that the other smokes in its automated list use the browser Puppeteer installs, though `npm run smoke:playwright`, one of them, launches Playwright's Chromium. Its table of the browser each smoke needs had no row for `npm run smoke:playwright`. It now names `npm run smoke:export` and `npm run smoke:playwright` as the smokes in that list that run in Playwright's Chromium, and `npm run smoke:arming`, `npm run smoke:downloads` and `npm run smoke:devtools` as the ones that use the browser Puppeteer installs. The table has a row for `npm run smoke:playwright`, Playwright's Chromium installed with `npx playwright install chromium`, among the rows that load the extension with `--load-extension`.

## 0.7.0 - 2026-08-03

Browser-layer (CDP/debugger) enforcement of blocked domains (the repatch-immune
egress layer ADR-007 designed), taken from unit-tested to validated against a
real Chrome, plus the review-follow-up hardening batch, in one Web Store
submission.

### Added
- **Browser-layer blocking (opt-in, default off), ADR-007.** For the sites a
  user explicitly *blocks* in a delegation, egress is now enforced below the page
  on the `chrome.debugger` CDP `Fetch` domain, for tabs under an active
  delegation. A hostile page that re-patches the in-page interceptor cannot
  undo it, and it closes the vectors the page-realm deny left unwrapped:
  EventSource, element-`src` (`new Image().src`, `<script>`/`<link>`), Worker and
  iframe fetch, and navigation to the blocked domain. (WebSocket is the one
  vector this layer does NOT close: the CDP `Fetch` domain cannot pause ws
  handshakes and Network-level ws blocking proved unreliable on the live
  debugger session; a ws to a blocked domain still connects, disclosed in the
  docs and store listing; deterministic ws blocking is deferred to a future
  `declarativeNetRequest` complement, ADR-008 R2.) Enabled by the
  new `cdpEnforcementEnabled` setting; attaches only when an agent is detected in
  the tab under an active delegation carrying at least one block pattern; shows
  Chrome's standard "started debugging this browser" bar while active, torn down
  on delegation expiry/revoke, kill switch, tab close, or setting-off. On any
  attach failure it falls back to the page-realm interceptor and never
  hard-blocks the user's own browsing. It carries no agent-vs-user attribution,
  so the per-action `network-request` *capability* withhold stays in the page
  realm: the CDP layer enforces only the deliberate, tab-wide domain blocks.
- **Block patterns are authorable in the delegation wizard, and validated at
  input time.** The Limited-preset sites step now offers an Allow/Block choice
  per site (it previously created allow patterns only, so no rule a user could
  build ever carried a block pattern; the browser-layer enforcement above had
  nothing to act on). Block patterns are normalized and validated where they are
  entered (as the URL matcher's contract requires), so a user-typed block cannot
  be silently inert: a full URL is reduced to its host (a bare `https://evil.com`
  would otherwise match no real request), a plain host blocks the apex *and* its
  subdomains (`evil.com` also blocks `www.evil.com`), and empty / path / lone-`*`
  / over-broad inputs are refused with a plain-language reason instead of a false
  sense of safety. The host is canonicalized to exactly what the matcher compares
  against: lowercased and trailing-dot-stripped (so `Evil.Com` and `evil.com.`
  are not silently inert), with a backslash authority folded the way the browser
  folds it, and a wildcard on the registrable tail (`*.com`, `**.com`) refused so
  a block cannot swallow a whole public suffix. The confirm step shows each
  pattern's action.
- **A `block` site pattern is now a hard deny that wins over any `allow`,** in
  both enforcement layers. Previously the page-realm evaluator was first-match-
  wins, so a broad allow listed before a specific block shadowed it: the monitor
  and download paths permitted a host the CDP layer blocked, i.e. the two layers
  disagreed on the same rule. A matching block now denies regardless of order,
  matching the CDP layer (which is block-only).
- **`npm run smoke:cdp`: real-browser release gate.** A headful Chrome exercise
  on the built `dist/` that proves, against a receipt-logging fixture server,
  that each CDP-closable egress vector is blocked only while enforcement is armed
  and flows again on every teardown path (setting-off, tab close, delegation
  expiry across a restart, kill switch), that default-off attaches nothing, that
  a non-delegated tab is never affected, and that WebSocket stays open under
  enforcement (asserting the documented scope line rather than assuming it).
- **Browser-posture guidance on external-agent cards (ADR-008 R1, version
  half).** For a detect-only external driver, the popup now states the browser's
  own posture: Chrome 136+ already refuses remote debugging of the default
  profile (so an agent that reached the tab is in a separate profile or was
  granted debugging at launch); older Chrome gets the concrete fix (update).

### Changed
- **ai-safety.txt cache is format-versioned.** The on-disk cache is now
  `{ v, entries }`; a record written by a different format (including the 0.6.x
  flat shape) is dropped and refetched rather than half-parsed. The opt-out
  deleter still counts legacy bytes so nothing survives a consent revocation.
- **ai-safety.txt unreachable refetch backs off exponentially.** Consecutive
  `unreachable` results double the negative-cache TTL (5 min up to a 4 h cap)
  instead of re-hitting a broken origin every 5 minutes; any `ok`/`none` result
  resets it. Fewer requests to a third-party origin is the point (ADR-009).

### Docs
- architecture §7/§8, ADR-007, and ADR-008 updated to describe the shipped CDP
  layer and correct the stale one-client-per-tab premise: on current
  multi-client Chrome our attach usually succeeds alongside an external driver
  (a strengthening ABG does not rely on against a browser-level adversary).
- README and both store surfaces describe the opt-in Browser-layer blocking
  setting and the `debugger` permission's enforcement use.

## 0.6.2 - 2026-07-29

The remainder of the 2026-07-28 field-test findings
(`docs/audit/2026-07-28-field-test-report.md`), released as one batch so the
Web Store submission carries the full set.

### Fixed
- **In-page delegation is now reachable (F-P, the field test's core gap).** The
  per-action block engine worked but could not be armed: the in-memory agent
  maps die with every MV3 worker restart, and the load path force-ended every
  un-ended session as `agent-disconnected`, so the popup showed "No agents
  detected" mid-session and there was no agent card to grant Read-Only from. A
  persisted active-agent registry now rehydrates agents whose tab still exists
  **on the same origin** (tab identity is existence + origin: Chrome reuses
  tab ids across restarts, and the kill switch closes the tabs in this map, so
  a bare id match could aim it at an unrelated restored tab). Malformed
  entries are dropped and pruned; origin mismatches and dead tabs end their
  sessions honestly. The registry stores no new data class: it is a pointer
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
  vanished with no explanation anywhere. No "Allow once" button: the
  download is already cancelled and cannot be resumed.
- **"Allow once" works on the monitor path (F-B).** The toast's grant used to
  land only in the MAIN-world interceptor's set; the ISOLATED-world monitor
  issuing the commonest in-page blocks (Read-Only click/type/submit) never
  consulted it. Both grant entry points now feed a monitor-side one-shot set,
  consumed on first matching event; kill-switch activation purges pending
  grants, mirroring the MAIN world.
- **The downloads-permission wording is accurate (F-F).** The store listing no
  longer claims "user-initiated exports only": the extension detects and
  cancels agent downloads per delegation rules, and the listing now says so
  (the privacy policy was already accurate).

### Fixed (content-messaging repair, found by the new arming smoke)
- **The content -> background pipeline works again.** Three stacked bugs had
  silently disabled it in production, invisible to the unit suite:
  1. Sender validation's origin check required the extension's own origin on
     EVERY message, but Chrome sets a content script's `sender.origin` to the
     PAGE's origin, so every content-script message (in-page detections,
     action reports, boundary violations) was rejected. The suite stayed green
     because its content-sender fixtures omitted/faked the origin; fixtures
     now carry the production shape, and the origin requirement applies only
     to popup-class messages (where it correctly guards against a future
     `externally_connectable` misconfiguration).
  2. Any `chrome.runtime.lastError` on a sent message was treated as
     "extension context invalidated", permanently muting the content script,
     but `lastError` also fires for the routine "message port closed" produced
     by any declined message. One declined startup message and the tab dropped
     ALL background traffic (rules, kill-switch broadcasts, allow-once) for
     the life of the page. Invalidation is now only inferred from the actual
     invalidation error or a missing runtime id.
  3. The content script's startup state pull used the popup-only STATUS_QUERY,
     so it was (correctly) rejected: tabs opened after a delegation activated
     never received their rule, and a navigation during an active kill switch
     did not re-arm the MAIN-world sentinel. A new content-only
     TAB_STATE_QUERY returns exactly the tab's slice: its effective rule and
     the kill-switch latch, answered from loaded state.

### Hardened (adversarial-review follow-ups)
- Kill-switch ACTIVATE/RESET are serialized (arrival order wins; no
  interleaved re-latch); each tab close is bounded (1.5s) so a page's
  `beforeunload` prompt cannot wedge the emergency stop or a queued reset;
  ACTIVATE no longer depends on a successful state load; the popup renders
  "Killed"/"Monitoring" only on a confirmed response.
- `getKillSwitchState` fails loud on storage read errors instead of returning
  the inactive default: a storage blip must not silently lift a latched
  emergency stop (missing/malformed keys still return the fresh-install
  default).
- The content script's message handler mirrors the background's
  same-extension sender validation (defense-in-depth).
- The popup's Network Activity panel shows an honest empty state (network
  observation is delegation-scoped since 0.6.1) instead of hiding.

### Added
- `npm run smoke:arming`, release-smoke step 3, exercised end to end for the
  first time: drives the REAL toolbar popup wizard to activate a Read-Only
  rule, asserts the rule persists, then fires the in-page agent fixture's
  synthetic violations and asserts the monitor block and toast. Reports an
  explicit SKIP-ENV on a desktop without OS focus, never a false pass.
- `scripts/inpage-agent-fixture.html`: the field test's self-driving in-page
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
  `state.killSwitch`, so the latch never cleared, leaving the user stuck in a
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
  own request failed (e.g. a site's Content-Security-Policy refusing its own
  analytics beacon), Chrome attributed that failure to AI Browser Guard in
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
  captured while disarmed stays native, so arming later cannot reach it, one
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
