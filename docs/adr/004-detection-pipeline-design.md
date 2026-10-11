# ADR-004: Multi-Signal Detection Pipeline

**Status:** Accepted
**Date:** 2026-02-27

## Context

AI Browser Guard must detect when automation frameworks (Playwright, Puppeteer,
Selenium, Anthropic Computer Use, OpenAI Operator) take control of a browser
tab. The core constraint is that agents are not required to self-identify.
Detection must work against uncooperative or unaware agents.

No single signal is reliable on its own. The `navigator.webdriver` flag can be
unset by sophisticated automation. CDP markers can be hidden. Behavioral
patterns can produce false positives on accessibility tools or macro recorders.
A single-signal approach is trivially defeated.

## Decision

Implement a four-layer detection pipeline, executed in order by the content
script on each page load:

1. **WebDriver flag check.** Inspect `navigator.webdriver` and related
   properties (`navigator.languages`, `navigator.plugins.length`). Fast,
   synchronous, catches unmodified automation setups.

2. **CDP marker detection.** Look for Chrome DevTools Protocol artifacts:
   injected `__playwright_*` or `__puppeteer_*` globals, CDP session markers
   on `window`, and runtime-injected binding functions.

3. **Behavioral heuristics.** Implemented in `src/detection/behavioral.ts`.
   Analyzes mouse movement timing (interval standard deviation < 15ms
   indicates uniformity), coordinate precision (>95% integer-only
   coordinates), keyboard cadence (standard deviation < 20ms, average
   interval < 30ms), synthetic event ratio (>50% untrusted events), and
   click-without-preceding-movement patterns. Requires a minimum of 20
   events before producing a verdict.

4. **Framework fingerprinting.** Match against known signatures for specific
   frameworks: Playwright page context injection, Puppeteer CDP command
   patterns, Selenium WebDriver protocol artifacts, Anthropic Computer Use
   screenshot-then-click sequences, and OpenAI Operator navigation patterns.

> **Correction (2026-10-11).** No sequence or navigation-pattern analysis
> exists for Computer Use or Operator. `detectAnthropicComputerUse` and
> `detectOpenAIOperator` in `src/detection/automation.ts` check the environment
> the browser runs in. For Computer Use they check the WebGL renderer string,
> the screen resolution and the platform. For Operator they check the platform,
> the user agent, the plugin count and the WebGL renderer string. Each detector
> needs two of its indicators and reports `medium` confidence at most. These
> two detections match the environment an agent typically runs in, not the
> actions it takes.

Detection results carry a confidence level (`low`, `medium`, `high`,
`confirmed`). The `aggregateBehavioralAnalysis` function in
`src/detection/behavioral.ts` escalates confidence when multiple signals
agree: one signal yields the individual detector's confidence, two signals
yield `high`, three or more yield `confirmed`.

Results flow from the content script to the background service worker via
`chrome.runtime.sendMessage`, where they update the popup badge and are
logged to the session timeline.

## Consequences

### Positive
- Resilient to individual signal spoofing. An agent that clears
  `navigator.webdriver` is still caught by behavioral analysis. An agent
  that randomizes timing is still caught by CDP markers.
- Confidence scoring reduces false positive impact. A single `low`
  confidence signal triggers logging but not blocking. Multiple corroborating
  signals escalate to actionable `high` or `confirmed` verdicts.
- Each layer is independently testable. Behavioral analysis functions are
  pure (no Chrome API dependencies), enabling unit tests with Vitest.

### Negative
- Behavioral analysis requires accumulating at least 20 events before
  producing a result. Short-lived agent sessions may complete before
  sufficient data is collected for behavioral detection.
- Four detection layers add CPU overhead on every page. The content script
  must be carefully profiled to avoid degrading page performance.
- New automation frameworks require adding fingerprint signatures manually.
  There is no automatic signature generation.

### Neutral
- The pipeline runs in the content script context, not the background
  service worker. This means detection survives service worker termination
  but cannot share state across tabs without messaging.
- Detection thresholds (defined as `BEHAVIORAL_THRESHOLDS` in
  `src/detection/behavioral.ts`) may need tuning as real-world data from
  various automation frameworks is collected.
