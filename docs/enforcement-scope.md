# Scope of enforcement

This page states where the blocking of AI Browser Guard stops. The README keeps a short form of it. AI Browser Guard detects agents driven by Playwright, Puppeteer, Selenium, Anthropic Computer Use and OpenAI Operator; [detected-frameworks.md](detected-frameworks.md) lists how each one is detected.

For in-page and injected automation it can also block scripted navigations, form submissions, and new-tab opens (best-effort, in the page realm). Under a delegation that does not permit downloads, it can cancel a download that Chrome reports starting in an agent's tab, for every kind of agent, including one you start there. Beyond that it **cannot** block external automation frameworks that drive the browser over CDP; against those, AI Browser Guard provides detection, alerting, and a kill switch that closes the tab, not per-action enforcement.

AI Browser Guard has a detection method for every framework above, but not every method has been run against the real framework ([detected-frameworks.md](detected-frameworks.md)), and per-action blocking does not extend to them. External frameworks drive the browser over CDP with native input the page realm cannot intercept, so against them AI Browser Guard detects, alerts, and closes the tab, but cannot enforce per-action policy.

Downloads are the exception, for every kind of agent: under Read-Only or Limited Access, a download that Chrome reports starting in an agent's tab is cancelled through Chrome's downloads API, which does not depend on intercepting the agent's input. The report comes from the debugger session Browser-layer blocking (Settings) attaches to that tab, so downloads are cancelled only while that setting is on; a download you start in the agent's tab is cancelled too.

An open DevTools window makes the page it inspects look attached to a debugger, so an agent first seen through an attachment while DevTools is open in any tab is treated as most likely you inspecting a page: a download in its tab is recorded, not cancelled.

A download from any other tab is recorded in the session log and not cancelled, including one from the same site as the agent's page: Chrome's downloads API does not say which tab a download came from. For the same reason, when a download of the same URL started in another tab up to 1 second before Chrome reports the one in the agent's tab, the report does not say which of the two is the agent's, so neither is cancelled; both are recorded. One started earlier than that is not taken for the reported download: measured in Chrome 145 and 155, the report reached an extension 0 to 8 ms after the download was created (`node scripts/measure-download-start-gap.mjs` measures this). Nor is it paused for you to keep or discard: in Chrome, a paused download from a short-lived link without range support is lost when the server closes the connection while it waits (`node scripts/measure-download-hold.mjs` measures this). When such a download comes from the site of the agent's page, you get a notification that it was not stopped.

The only categorical prevention is a managed-Chrome policy, `RemoteDebuggingAllowed=false`; Chrome 136+ already blocks remote debugging of your default profile by default.

The per-action blocking below applies only to in-page / injected automation, is best-effort (a hostile page can re-patch the wrapped globals), and does not yet cover every in-page sink. See [ADR-008](adr/008-enforcement-scope.md) for the rationale and boundary.

## In-page automation

**Constrains in-page automation**: delegation rules define what an in-page/injected agent can do. Scripted navigations, form submissions, synthetic clicks and typing, and new-tab opens are blocked best-effort in the page realm, with a notification for each block. **This does not apply to external CDP frameworks**, which act via native input the page realm cannot intercept. Downloads are handled outside the page, for every kind of agent (see Scope of enforcement).

What each delegation preset permits, and how to end a delegation or pause the guard: [delegation.md](delegation.md).

### Which denials come from AI Browser Guard

A denial that an agent driving the browser over CDP receives for a click, a keystroke or a typed value (an agent such as Claude in Chrome, for example) is not one this extension made: it cannot intercept that native input. Treat such a denial as a decision of the agent's host, not of the guard. A denial the guard does make says so. The toast in the page carries the AI Browser Guard name and the reason, and a `fetch` that the guard rejects fails with `Network request blocked by AI Browser Guard (rule: <matched rule>)`, where the rule is, for example, `Kill switch active`, `Site blocked by pattern: <pattern>` or `'network-request' blocked by delegation rule`.

### A submit after a denied input

When the guard blocks an in-page agent's text input (an untrusted `input` event, or a `keydown` that types or deletes a character, as a scripted paste or typing into a form field or an editor dispatches), the text did not reach the page. An agent that goes on to submit would send what the field held before. So, for the rest of that sequence, the guard also holds the agent's next submit, even where the rule permits submitting: a `submit` event, Enter or Cmd/Ctrl+Return (not Shift+Enter, which adds a line), and a click on a form's submit button or on a button outside any form, such as a chat editor's send button. The held event is cancelled (`dispatchEvent` returns `false`), and the notice on the page gives the reason "Held: the text input just before it was blocked, so it did not reach the page." The sequence ends when a text input is let through, when you act in the page yourself, when the delegation changes, or 10 seconds after the last denied input.

This covers only input the guard blocked itself. When an agent driving the browser over CDP has a paste or keystroke denied, that is a decision of the agent's host (see above): the guard never saw the input, so it cannot hold the submit that follows, and the agent's host is what has to report that the input did not land.

## Tabs with no detected agent

A session delegation is the rule in a tab where no agent was detected too, and in-page blocking does not wait for a detection. While a rule is in effect in a tab, it blocks an untrusted `click`, `keydown`, `input` or `submit` event that the rule does not permit, whether an agent or the page's own script dispatched it: both arrive as events the browser marks untrusted. So under Read-Only, a page that dispatches such an event itself, from a timer for example, has it blocked in a tab where nothing was detected: you get the block notification, the toolbar badge shows `!` and the block is listed in the popup, while nothing is added to the detection log or to a session log. To let a site's own scripted events through, pause the guard on that site.
