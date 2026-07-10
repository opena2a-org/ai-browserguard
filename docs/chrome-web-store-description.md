# Chrome Web Store resubmission — copy/paste fields (v0.4.2)

This file is the exact text to paste into the Chrome Web Store Developer
Dashboard for the v0.4.2 resubmission. It supersedes the live listing's
"Zero network requests. No analytics, no tracking, no data collection."
claim, which is inaccurate now that opt-in community features exist (they are
off by default). Everything below tells the same "off by default, optional
opt-in" story as the privacy policy, README, and ADR-006.

---

## Item name
AI Browser Guard

## Short description (132 chars max)
[BETA] Detects AI agents (Playwright, Puppeteer, Computer Use) driving your browser. Alerts, kill switch, delegation. Local-first.

## Category
Developer Tools

## Language
English

---

## Detailed description (paste into "Description")

BETA — AI Browser Guard is in active development. We are building security infrastructure for the AI agent ecosystem and want your feedback. Report issues or suggest features: https://github.com/opena2a-org/AI-BrowserGuard/issues

AI Browser Guard detects when AI automation frameworks take control of your browser and gives you tools to manage what they can do.

WHAT IT DOES

When an AI agent (Playwright, Puppeteer, Selenium, Anthropic Computer Use, OpenAI Operator, or any WebDriver-based tool) starts controlling your browser, AI Browser Guard:

- Detects the takeover using multiple signals: WebDriver flags, Chrome DevTools Protocol markers, behavioral analysis of mouse/keyboard patterns, and framework-specific fingerprints
- Shows detection status in the popup with confidence level and detection method
- Logs the agent activity it can observe in a session timeline

SCOPE AND LIMITATIONS

External automation frameworks (Playwright, Puppeteer, Selenium, Anthropic Computer Use, OpenAI Operator) drive the browser over the Chrome DevTools Protocol with native input. AI Browser Guard detects and alerts on these agents, and its kill switch closes the tab they control, but it does not block their individual actions and cannot see their clicks, typing, or screenshots in the timeline. A browser extension cannot enforce per-action policy against a framework that owns the tab's debugger slot; the only categorical block is a managed-Chrome policy (RemoteDebuggingAllowed=false), and modern Chrome already blocks remote debugging of your default profile by default. The delegation presets and per-action blocking below apply to IN-PAGE / injected automation only, best-effort. If a session report shows few or no actions for an external agent, that means its actions were not observable, not that nothing happened.

FIVE CORE FEATURES

1. Agent Takeover Detection — identifies automation frameworks without requiring agents to self-identify. WebDriver flag detection, CDP connection scanning, behavioral heuristics (click precision, typing cadence, synthetic events), and framework fingerprinting.

2. Emergency Kill Switch — one-click stop. Revokes delegated permissions, dispatches a page-realm stop to in-page automation, and closes the tabs an agent controls (the real interruption of an in-progress action). It does not terminate an external CDP session -- an extension cannot -- and a persistent external driver can reopen a tab. Keyboard shortcut: Ctrl+Shift+K (Cmd+Shift+K on Mac).

3. Delegation Wizard — define what agents can and cannot do before they connect: Read-Only (navigate and read, no clicking or typing), Limited (specific sites you choose, with time limits 15min / 1hr / 4hr), or Full Access (everything allowed, with logging and alerts).

4. Boundary Violation Alerts — when an IN-PAGE agent attempts a scripted navigation, form submission, click, keystroke, new-tab open, or download outside its delegation scope, the action is blocked (best-effort) and you receive a notification showing what was attempted, which rule blocked it, and the option to allow it once. External CDP frameworks drive via native input these alerts cannot see -- for those, rely on detection and the kill switch. (DOM reads, injected scripts, and screenshots are not blocked; use the kill switch to close the agent's tab.)

5. Session Timeline — chronological log of all agent actions: timestamps, action types, target URLs, element selectors, and whether each action was allowed or blocked. Last 5 sessions retained.

PRIVACY

By default, AI Browser Guard makes zero network requests. All detection, delegation, and session tracking runs locally on your device. There is no analytics, no telemetry, and no tracking. Session logs and settings are stored in chrome.storage.local and are deleted when you uninstall.

The extension also offers three optional community-intelligence features that are OFF BY DEFAULT. They only send data after you explicitly enable them, and each can be turned off again with one click:

- AIM identity lookup and registry trust lookup — when an agent is detected, look up a trust score for that agent type. Only the detected agent type (for example "playwright") is sent. Your URLs and page content are never sent.
- Anonymized contribution — share anonymized detection and behavior summaries (an anonymous token, the detected framework name, and summary counts) to improve community threat intelligence. Prompted once after 5 detections; dismissible.

None of these features transmit your URLs, page content, form data, keystrokes, cookies, authentication tokens, or identity.

Full privacy policy: https://opena2a.org/aibrowserguard/privacy

PERMISSIONS

AI Browser Guard requests host access to all URLs because AI agents can operate on any website, so the detection content script must run on every page. By default the extension makes no network requests; the only outbound requests are the optional, off-by-default features described under PRIVACY.

ABOUT OPENA2A

AI Browser Guard is built by OpenA2A, an open-source security platform building infrastructure for the AI agent ecosystem. Learn more: https://opena2a.org — Source code: https://github.com/opena2a-org/AI-BrowserGuard

This is a beta release. We are actively improving detection accuracy, adding framework signatures, and expanding delegation controls. Open an issue on GitHub with feedback: https://github.com/opena2a-org/AI-BrowserGuard/issues

---

## Support URL (paste into "Support URL" field)
https://github.com/opena2a-org/AI-BrowserGuard/issues

## Homepage URL (paste into "Homepage URL" field, optional)
https://opena2a.org/aibrowserguard

---

## Permission justifications (paste each into its "Justification" box)

storage:
Persists session logs, delegation rules, and user settings locally on the device.

alarms:
Schedules periodic checks for delegation rule expiration and detection sweeps.

notifications:
Alerts the user when an AI agent attempts an action that violates the active delegation rules.

debugger:
Detects when an automation framework (Playwright, Puppeteer) attaches a Chrome DevTools Protocol debugger to the browser. CDP attachment is a core, hard-to-spoof signal that an AI agent has taken control. The extension only observes debugger attachment for detection; it does not read page content or inject code through the debugger.

downloads:
Saves a session report as a JSON file when the user chooses to export it from the popup. Used only for user-initiated exports.

host_permissions (<all_urls>):
AI agents can operate on any website, so the detection content script must run on all pages to identify automation frameworks (WebDriver flags, CDP markers, behavioral patterns). Limiting to specific domains would leave users unprotected on unlisted sites. Page content is analyzed locally and is never transmitted.

---

## Data-use / privacy disclosures (Chrome Web Store "Privacy practices" tab)

Set the data-collection disclosures to reflect the OPTIONAL, opt-in features
(the dashboard asks what the extension *can* collect, not just the default):

- Does this item collect or use user data? YES (because the opt-in features can).
- Data collected (only when the user opts in):
  - "Website content" — NO. (We never send page content or URLs.)
  - "User activity" — YES, limited: anonymized detection/behavior summaries
    (framework name, counts) are sent only if the user opts into contribution.
  - "Personally identifiable information" — NO.
  - "Authentication information" — NO.
  - "Location", "Financial", "Health", "Personal communications", "Web history" — NO.
- Certifications:
  - I do not sell or transfer user data to third parties (outside approved use cases). TRUE.
  - I do not use or transfer user data for purposes unrelated to the item's core functionality. TRUE.
  - I do not use or transfer user data to determine creditworthiness or for lending. TRUE.
- Privacy policy URL: https://opena2a.org/aibrowserguard/privacy

Note: if you prefer the simplest possible review, you can leave all three
opt-in features off in the default build and still declare them here — the
declaration must cover what the code is capable of, which is why we disclose
the contribution path even though it is off by default.
