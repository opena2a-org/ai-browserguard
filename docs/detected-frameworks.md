# Detected Frameworks

Not every method below has been run against the real framework. Puppeteer and Selenium have harnesses that drive the real framework in Chrome and record the signals a page sees (`scripts/test-puppeteer-detection.js`, `scripts/test-selenium-detection.js`), and the smoke tests (`npm run smoke:scope`, `npm run smoke:scenarios`) drive pages with Puppeteer while the built extension is loaded and check that it detects the agent. No harness here drives Playwright or OpenAI Operator; the Playwright stack-trace pattern is covered by unit tests on sample stack traces. The Anthropic Computer Use harness (`scripts/test-computer-use-detection.py`) drives Firefox to a probe page (`scripts/detection-probe.html`) in the reference container, not Chrome with the extension loaded.

| Framework | Detection Method |
|-----------|-----------------|
| Playwright | CDP debugger attachment, `UtilityScript.evaluate` in V8 stack traces |
| Puppeteer | CDP debugger, `pptr:evaluate` stack traces, `navigator.webdriver`, dimension inversion |
| Selenium | CDP debugger, `callFunction`/`executeScript` stack traces, dimension equality |
| Anthropic Computer Use | Software WebGL renderer (llvmpipe/Mesa), Xvfb screen resolution, Linux fingerprint |
| OpenAI Operator | Environment signals only, separate from Playwright detection: any two of a Linux platform, `Operator` or `OpenAI` in the user agent, zero browser plugins, and a WebGL renderer naming SwiftShader, llvmpipe, or ANGLE with Google. The signals come from published third-party research, not from a run against Operator. |
| Generic CDP/WebDriver | `chrome.debugger.getTargets()`, `navigator.webdriver` flag |

What the extension can block once it detects one of these, and what it can only detect: [enforcement-scope.md](enforcement-scope.md).
