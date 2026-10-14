# Scope of enforcement

AI Browser Guard detects agents driven by Playwright, Puppeteer, Selenium, Anthropic Computer Use and OpenAI Operator; [detected-frameworks.md](detected-frameworks.md) lists how each one is detected. This page states where its blocking stops. The README keeps a short form of it.

Detection and monitoring work against every framework above; per-action blocking does not. External frameworks drive the browser over CDP with native input the page realm cannot intercept, so against them AI Browser Guard detects, alerts, and closes the tab, but cannot enforce per-action policy.

Downloads are the exception, for every kind of agent: under Read-Only or Limited, a download that Chrome reports starting in an agent's tab is cancelled through Chrome's downloads API, which does not depend on intercepting the agent's input. The report comes from the debugger session Browser-layer blocking (Settings) attaches to that tab, so downloads are cancelled only while that setting is on; a download you start in the agent's tab is cancelled too.

An open DevTools window makes the page it inspects look attached to a debugger, so an agent first seen through an attachment while DevTools is open in any tab is treated as most likely you inspecting a page: a download in its tab is recorded, not cancelled.

A download from any other tab is recorded in the session log and not cancelled, including one from the same site as the agent's page: Chrome's downloads API does not say which tab a download came from. For the same reason, when a download of the same URL started in another tab in the 5 seconds before Chrome reports the one in the agent's tab, the report does not say which of the two is the agent's, so neither is cancelled; both are recorded. Nor is it paused for you to keep or discard: in Chrome, a paused download from a short-lived link without range support is lost when the server closes the connection while it waits (`node scripts/measure-download-hold.mjs` measures this). When such a download comes from the site of the agent's page, you get a notification that it was not stopped.

The only categorical prevention is a managed-Chrome policy, `RemoteDebuggingAllowed=false`; Chrome 136+ already blocks remote debugging of your default profile by default.

The per-action blocking below applies only to in-page / injected automation, is best-effort (a hostile page can re-patch the wrapped globals), and does not yet cover every in-page sink. See [ADR-008](adr/008-enforcement-scope.md) for the rationale and boundary.

## In-page automation

**Constrains in-page automation**: delegation rules define what an in-page/injected agent can do. Scripted navigations, form submissions, synthetic clicks and typing, and new-tab opens are blocked best-effort in the page realm, with a notification for each block. **This does not apply to external CDP frameworks**, which act via native input the page realm cannot intercept. Downloads are handled outside the page, for every kind of agent (see Scope of enforcement).

What each delegation preset permits, and how to end a delegation or pause the guard: [delegation.md](delegation.md).

## Tabs with no detected agent

A session delegation is the rule in a tab where no agent was detected too, and in-page blocking does not wait for a detection. While a rule is in effect in a tab, it blocks an untrusted `click`, `keydown`, `input` or `submit` event that the rule does not permit, whether an agent or the page's own script dispatched it: both arrive as events the browser marks untrusted. So under Read-Only, a page that dispatches such an event itself, from a timer for example, has it blocked in a tab where nothing was detected: you get the block notification, the toolbar badge shows `!` and the block is listed in the popup, while nothing is added to the detection log or to a session log. To let a site's own scripted events through, pause the guard on that site.
