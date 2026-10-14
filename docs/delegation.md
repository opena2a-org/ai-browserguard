# Delegation

A delegation sets what an agent may do: Read-Only, Limited or Full Access. The presets are listed in the [README](../README.md#delegation-presets).

## What a preset enforces

> **These presets are enforced best-effort against in-page / injected automation, except downloads, which Read-Only and Limited can cancel in an agent's tab for every kind of agent.** External CDP frameworks bypass the rest; for those agents a preset is otherwise a recorded intent, not an enforced boundary, and the kill switch (close tab) is the hard stop. Which downloads are cancelled, including ones you start yourself, is described in [Scope of enforcement](enforcement-scope.md).

Site allowlists and blocklists support glob patterns (e.g., `*.bank.com`).

## Ending a delegation

**End** next to the session delegation in the popup turns it off without putting another preset in its place, and **Revoke** on an agent's card removes that agent's own grant. A grant on an agent's card takes precedence over the session delegation in that agent's tab, so the delegation panel names the agents that hold one.

## Pausing the guard

To let an agent work on one site without blocks, open the popup on that site and choose **Pause on this site** for 15 minutes, 60 minutes, or until you resume. **Pause everywhere** covers every site for 15 or 60 minutes. While a pause is on, agent actions there are not blocked; detection, the timeline and the kill switch keep working. The popup shows a countdown and a Resume button for each pause and a history of recent pauses. Blocking returns on its own when a pause ends, and the kill switch ends every pause.

## Browser-layer blocking (opt-in, off by default)

For the sites you explicitly *block*, an optional setting enforces the block below the page at the browser's network layer (`chrome.debugger`/CDP `Fetch`, [ADR-007](adr/007-cdp-layer-enforcement.md)), for tabs under an active delegation. It closes the egress paths to a blocked domain that the page realm cannot: `fetch`/XHR, EventSource, element-`src`, worker and iframe fetches, and navigation. A page that re-patches the in-page wrappers cannot undo it. (`WebSocket` is the one vector it does **not** close: the CDP `Fetch` domain cannot pause ws handshakes, so a WebSocket to a blocked domain still connects. Deterministic ws blocking needs `declarativeNetRequest` and is deferred to [ADR-008](adr/008-enforcement-scope.md) R2.)

Under a delegation that does not permit downloads (Read-Only, Limited) the setting attaches a session to the agent's tab even when the delegation blocks no site, to report the downloads started there (see [Scope of enforcement](enforcement-scope.md)); such a session pauses none of the tab's requests.

Chrome shows its standard "started debugging this browser" bar while a delegated tab holds a session; the session and the bar are torn down on delegation expiry or revoke, kill switch, tab close, or turning the setting off, and on any attach failure it falls back to the page-realm interceptor rather than ever blocking your own browsing. The agent's card in the popup says when the session is attached to its tab, what it is attached for (the sites the delegation blocks, the downloads it cancels there, or both), and that this is why the bar is showing; it also says when Chrome refused or ended the session, with the reason Chrome gave. It makes no network requests of its own. Validated end-to-end against a real Chrome by `npm run smoke:cdp`.
