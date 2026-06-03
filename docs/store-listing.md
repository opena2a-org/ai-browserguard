# Chrome Web Store Listing

## Short Name
AI Browser Guard

## Short Description (132 chars max)
[BETA] Detect, monitor, and block scripted AI-agent actions in your browser. Kill switch, delegation rules, alerts. Local-first.

## Detailed Description

BETA — AI Browser Guard is in active development. We are building the security infrastructure that the AI agent ecosystem needs, and we want your feedback to get it right. Report issues or suggest features: https://github.com/opena2a-org/AI-BrowserGuard/issues

AI Browser Guard detects when AI automation frameworks take control of your browser and gives you tools to manage what they can do.

WHAT IT DOES

When an AI agent (Playwright, Puppeteer, Selenium, Anthropic Computer Use, OpenAI Operator, or any WebDriver-based tool) starts controlling your browser, AI Browser Guard:

- Detects the takeover using multiple signals: WebDriver flags, Chrome DevTools Protocol markers, behavioral analysis of mouse/keyboard patterns, and framework-specific fingerprints
- Shows detection status in the popup with confidence level and detection method
- Logs all agent activity in a session timeline

FIVE CORE FEATURES

1. Agent Takeover Detection
   Identifies automation frameworks without requiring agents to self-identify. Uses WebDriver flag detection, CDP connection scanning, behavioral heuristics (click precision, typing cadence, synthetic events), and framework fingerprinting.

2. Emergency Kill Switch
   One-click termination of all agent access. Clears automation flags, revokes delegated permissions, and broadcasts stop commands to all tabs. Keyboard shortcut: Ctrl+Shift+K (Cmd+Shift+K on Mac).

3. Delegation Wizard
   Define what agents can and cannot do before they connect:
   - Read-Only: Navigate and read, no clicking or typing
   - Limited: Interact with specific sites you choose, with time limits (15min / 1hr / 4hr)
   - Full Access: Everything allowed, with logging and alerts

4. Boundary Violation Alerts
   When an agent attempts a scripted navigation, form submission, click, keystroke, new-tab open, or download outside its delegation scope, the action is blocked and you receive a notification showing what was attempted, which rule blocked it, and the option to allow it once. (DOM reads, injected scripts, screenshots, and network requests are currently logged but not blocked; use the kill switch to fully cut off an agent.)

5. Session Timeline
   Chronological log of all agent actions: timestamps, action types, target URLs, element selectors, and whether each action was allowed or blocked. Last 5 sessions retained.

PRIVACY

By default, all processing happens locally on your device and the extension makes zero network requests. No analytics, no telemetry, no tracking. Session logs and settings are stored in chrome.storage.local and deleted when you uninstall.

Three optional community-intelligence features are off by default and only send data after you explicitly enable them: AIM identity lookup and registry trust lookup (which send only the detected agent type, such as "playwright", to look up a trust score), and anonymized contribution (which shares anonymized detection summaries to improve community threat intelligence). None of these transmit your URLs, page content, keystrokes, or identity, and each can be turned off with one click.

See full privacy policy: https://opena2a.org/aibrowserguard/privacy

PERMISSIONS EXPLAINED

This extension requires host access to all URLs because AI agents can operate on any website. Detection content scripts must run on every page to provide coverage. By default the extension makes no network requests; the only outbound requests are the optional, off-by-default community-intelligence features described under PRIVACY.

ABOUT OPENA2A

AI Browser Guard is built by OpenA2A, an open-source security platform building infrastructure for the AI agent ecosystem. AI agents are already making decisions, calling APIs, and accessing production data — without identity, visibility, or accountability. One compromised or misaligned agent can silently exfiltrate data, escalate privileges, or delete critical systems, and most organizations won't notice until damage is done.

OpenA2A builds the tools to close that gap. 4 npm packages published, 6 security PRs accepted into OpenClaw (205K+ stars), and 2,500+ lines of security code merged into projects used by millions. Our ecosystem includes:

- AIM (Agent Identity Management) — Cryptographic identity, trust scoring, capability-based access control
- HackMyAgent — 147+ security checks, 75 adversarial attack payloads, OASB compliance scoring
- Secretless AI — Keeps secrets out of AI context windows across Claude Code, Cursor, Copilot, Windsurf
- ARP (Agent Runtime Protection) — Multi-layer runtime security monitoring and enforcement
- OASB (Open Agent Security Benchmark) — 222 attack scenarios across 10 MITRE ATLAS techniques
- DVAA (Damn Vulnerable AI Agent) — Intentionally vulnerable agents for learning and red-teaming

AI agents should be powerful — but never unaccountable.

Learn more: https://opena2a.org
Source code: https://github.com/opena2a-org/AI-BrowserGuard

FEEDBACK

This is a beta release. We are actively improving detection accuracy, adding new framework signatures, and expanding delegation controls. If you encounter issues, have feature requests, or want to contribute, open an issue on GitHub:
https://github.com/opena2a-org/AI-BrowserGuard/issues

---

## Category
Developer Tools

## Language
English

## Tags (up to 5)
- AI security
- browser automation
- agent detection
- privacy
- developer tools

## Permission Justifications

### storage
Required to persist session logs, delegation rules, and user settings locally on the device.

### alarms
Required to schedule periodic checks for delegation rule expiration and detection sweeps.

### notifications
Required to alert the user when an AI agent attempts an action that violates the active delegation rules.

### debugger
Required to detect when an automation framework (Playwright, Puppeteer) attaches a Chrome DevTools Protocol (CDP) debugger to the browser. CDP attachment is one of the core, hard-to-spoof signals that an AI agent has taken control. The extension uses this permission only to observe debugger attachment for detection; it does not read page content or inject code through the debugger.

### downloads
Required to save a session report as a JSON file when the user chooses to export it from the popup. Used only for user-initiated exports.

### host_permissions (<all_urls>)
AI agents can operate on any website. The detection content script must run on all pages to identify automation frameworks (WebDriver flags, CDP markers, behavioral patterns). Limiting to specific domains would leave users unprotected on unlisted sites. No page content is read or transmitted; only automation indicators are analyzed locally.
