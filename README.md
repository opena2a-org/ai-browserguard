> **[OpenA2A](https://github.com/opena2a-org/opena2a)**: [CLI](https://github.com/opena2a-org/opena2a) · [HackMyAgent](https://github.com/opena2a-org/hackmyagent) · [Secretless](https://github.com/opena2a-org/secretless-ai) · [AIM](https://github.com/opena2a-org/agent-identity-management) · [Browser Guard](https://github.com/opena2a-org/AI-BrowserGuard) · [DVAA](https://github.com/opena2a-org/damn-vulnerable-ai-agent)

[![Status: beta](https://img.shields.io/badge/status-beta-yellow)](./STATUS.md)
[![Build](https://github.com/opena2a-org/AI-BrowserGuard/actions/workflows/ci.yml/badge.svg)](https://github.com/opena2a-org/AI-BrowserGuard/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-516%20passing-brightgreen)](https://github.com/opena2a-org/AI-BrowserGuard)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4)](https://developer.chrome.com/docs/extensions/mv3/)

Chrome extension that detects, monitors, and controls AI agents operating in your browser. Identifies Playwright, Puppeteer, Selenium, Anthropic Computer Use, and OpenAI Operator -- without requiring the agent to identify itself.

**v0.4.2** -- Privacy disclosure rewritten to accurately describe the network posture: zero network requests by default, with three optional community-intelligence features (trust lookups and anonymized contribution) that are off by default and opt-in. Removed the dead `chrome.identity` login code so the bundle declares no `identity` permission.

**v0.4.1** -- Report export download now works reliably from the popup (hardened anchor plus a service-worker `chrome.downloads` fallback that survives the popup closing). Replaced the toast and settings-button emoji with inline SVG icons. Adds the `downloads` permission.

**v0.4.0** -- User actions no longer blocked when an agent is detected. Inline toast notifications for blocked agent actions with one-click domain whitelisting. Improved trust display for known tools.

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Install-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/ojphpdmabflmcjhglfogmkdgchkncikf)

[Install from Chrome Web Store](https://chromewebstore.google.com/detail/ojphpdmabflmcjhglfogmkdgchkncikf) | [Website](https://opena2a.org/aibrowserguard) | [Privacy Policy](https://opena2a.org/aibrowserguard/privacy)

![An AI agent takes over a banking tab. AI Browser Guard detects it, blocks the transfer it tries to submit with an in-page notice, and the kill switch ends every connection.](docs/browserguard-demo.gif)

An AI agent takes over a tab. AI Browser Guard detects it without the agent identifying itself, blocks the transfer it tries to submit, and the kill switch (Ctrl+Shift+K) ends every connection.

---

## What It Protects Against

- **Agent takeover without notice** -- Browser-based AI agents can control your session via CDP, WebDriver, or behavioral automation. AI Browser Guard detects their presence using three independent detection layers: CDP debugger monitoring, V8 stack trace analysis, and environment fingerprinting.
- **Unauthorized actions** -- Delegation rules define what an agent can and cannot do. Actions outside the boundary are blocked before execution, with a notification for each violation.
- **Unmonitored sessions** -- Every agent action is logged to a session timeline with timestamps, target URLs, elements, and outcomes (allowed/blocked). The last 5 sessions are retained.
- **No kill switch** -- One-click termination of all agent connections. Revokes permissions, clears automation flags, and terminates CDP sessions. Keyboard shortcut: Ctrl+Shift+K / Cmd+Shift+K.

[See demos](https://opena2a.org/demos) (select More Tools tab)

## Detected Frameworks

Every method below has been verified against the real framework.

| Framework | Detection Method |
|-----------|-----------------|
| Playwright | CDP debugger attachment, `UtilityScript.evaluate` in V8 stack traces |
| Puppeteer | CDP debugger, `pptr:evaluate` stack traces, `navigator.webdriver`, dimension inversion |
| Selenium | CDP debugger, `callFunction`/`executeScript` stack traces, dimension equality |
| Anthropic Computer Use | Software WebGL renderer (llvmpipe/Mesa), Xvfb screen resolution, Linux fingerprint |
| OpenAI Operator | Same as Playwright (Operator uses Playwright internally) + cloud environment signals |
| Generic CDP/WebDriver | `chrome.debugger.getTargets()`, `navigator.webdriver` flag |

## Install

**Chrome Web Store (recommended):**

[Install AI Browser Guard](https://chromewebstore.google.com/detail/ojphpdmabflmcjhglfogmkdgchkncikf) -- one click, automatic updates.

**From source:**

```bash
git clone https://github.com/opena2a-org/AI-BrowserGuard.git
cd AI-BrowserGuard
npm install && npm run build
```

Then open `chrome://extensions`, enable Developer mode, click Load unpacked, and select `dist/`.

## Delegation Presets

| Preset | What the Agent Can Do |
|--------|----------------------|
| Read-Only | Navigate and read pages. No clicking, typing, or form submission. |
| Limited | Interact with specific sites (user-defined allowlist), time-bounded (15min/1hr/4hr). |
| Full Access | Unrestricted, but all actions are logged and boundary alerts remain active. |

Site allowlists and blocklists support glob patterns (e.g., `*.bank.com`).

## Privacy

By default the extension makes zero network requests. All detection, delegation, and session tracking runs locally in the browser, and there is no analytics or telemetry.

Three optional community-intelligence features are **off by default** and only send data after you explicitly enable them:

- **AIM identity lookup** (`aim.opena2a.org`) and **registry trust lookup** (`api.oa2a.org`): when an agent is detected, look up a trust score for that agent type. Only the detected agent type (for example `playwright`) is sent; never your URLs or page content.
- **Anonymized contribution** (`api.oa2a.org`): share anonymized detection and behavior summaries to improve community threat intelligence. Prompted once after 5 detections; dismissible. Sends an anonymous token plus framework name and summary counts -- never URLs, page content, keystrokes, or identity.

One-click opt out for each. See [ADR-006](docs/adr/006-opt-in-network-features.md) and the full policy: [opena2a.org/aibrowserguard/privacy](https://opena2a.org/aibrowserguard/privacy).

## Development

```bash
npm install          # Install dependencies
npm run build        # Build to dist/
npm run dev          # Watch mode
npm run test         # 516 tests
npm run lint         # TypeScript strict checking
```

## Contributing

Contributions are welcome. Open an issue to discuss proposed changes before submitting a pull request. All PRs require passing CI and code review.

## License

[Apache-2.0](LICENSE)

---

Part of the [OpenA2A](https://opena2a.org) ecosystem. See also: [HackMyAgent](https://github.com/opena2a-org/hackmyagent), [Secretless AI](https://github.com/opena2a-org/secretless-ai), [DVAA](https://github.com/opena2a-org/damn-vulnerable-ai-agent), [AIM](https://github.com/opena2a-org/agent-identity-management).
