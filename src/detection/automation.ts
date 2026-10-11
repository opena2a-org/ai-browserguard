/**
 * Generic automation framework detection.
 *
 * Detects automation frameworks that may not leave WebDriver or CDP traces,
 * including browser-based AI agents and newer frameworks.
 */

import type { AgentType, DetectionMethod, DetectionConfidence } from '../types/agent';

/** Cached WebGL renderer string. Avoids creating new contexts on every sweep. */
let cachedWebGLRenderer: string | null | undefined;

function getCachedWebGLRenderer(): string | null {
  if (cachedWebGLRenderer !== undefined) return cachedWebGLRenderer;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        cachedWebGLRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string;
        // Explicitly lose context to free GPU resources
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return cachedWebGLRenderer;
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch {
    // Ignore WebGL errors
  }
  cachedWebGLRenderer = null;
  return null;
}

export interface FrameworkDetectionResult {
  detected: boolean;
  frameworkType: AgentType;
  method: DetectionMethod;
  confidence: DetectionConfidence;
  detail: string;
  signals: Record<string, unknown>;
}

/**
 * Detect Anthropic Computer Use agent environment.
 *
 * Anthropic Computer Use operates at the OS level via xdotool (X11 input
 * simulation) and gnome-screenshot. It does NOT use CDP, does NOT inject
 * JavaScript globals, and does NOT set navigator.webdriver.
 *
 * Detection relies on environment fingerprinting: the reference implementation
 * runs in a Docker container with Xvfb (virtual display), software-rendered
 * WebGL (llvmpipe/Mesa), and a characteristic screen resolution (1024x768 or
 * 1280x800). These are heuristic signals — they indicate a virtual environment
 * consistent with Computer Use, not a definitive detection.
 *
 * Verified via Anthropic's open-source reference implementation:
 * https://github.com/anthropics/claude-quickstarts/tree/main/computer-use-demo
 */
export function detectAnthropicComputerUse(): FrameworkDetectionResult {
  const signals: Record<string, unknown> = {};
  const indicators: string[] = [];

  // Computer Use runs in Xvfb with software rendering (llvmpipe or Mesa).
  // This is detectable via WebGL renderer string.
  const renderer = getCachedWebGLRenderer();
  if (renderer !== null) {
    signals.webglRenderer = renderer;
    if (renderer.includes('llvmpipe') || renderer.includes('Mesa')) {
      indicators.push('software renderer (llvmpipe/Mesa — virtual display indicator)');
    }
  }

  // Reference implementation uses XGA (1024x768) or WXGA (1280x800).
  // These are uncommon on modern hardware and characteristic of Xvfb.
  const screenW = window.screen?.width ?? 0;
  const screenH = window.screen?.height ?? 0;
  signals.screenWidth = screenW;
  signals.screenHeight = screenH;
  if ((screenW === 1024 && screenH === 768) || (screenW === 1280 && screenH === 800)) {
    indicators.push(`characteristic screen resolution (${screenW}x${screenH})`);
  }

  // Linux platform with non-headless browser is the reference environment.
  // (Xvfb + Mutter + Firefox/Chrome inside Docker on Linux)
  const platform = navigator.platform ?? '';
  signals.platform = platform;
  if (platform.startsWith('Linux')) {
    indicators.push('Linux platform');
  }

  // Require at least 2 indicators to reduce false positives
  // (a real Linux user with a 1024x768 monitor should not trigger this)
  const detected = indicators.length >= 2;

  return {
    detected,
    frameworkType: detected ? 'anthropic-computer-use' : 'unknown',
    method: 'automation-flag',
    confidence: detected ? 'medium' : 'low',
    detail: detected
      ? `Environment consistent with Anthropic Computer Use: ${indicators.join(', ')}.`
      : 'No Anthropic Computer Use environment indicators detected.',
    signals,
  };
}

/**
 * Detect OpenAI Operator agent environment.
 *
 * Environment signals only, separate from Playwright detection: this function
 * takes no input from the WebDriver, CDP or stack-trace checks. It reports
 * Operator when any two of these hold:
 * 1. navigator.platform starts with "Linux"
 * 2. the user agent contains "Operator" or "OpenAI" (as of 2025 Operator
 *    does not send a custom user agent string, unlike the ChatGPT-User bot)
 * 3. zero browser plugins
 * 4. a WebGL renderer naming SwiftShader, llvmpipe, or ANGLE with Google
 *
 * The signals come from published third-party research, not from a run
 * against Operator.
 *
 * Sources: OpenAI CUA sample app (github.com/openai/openai-cua-sample-app),
 * CHEQ research on Operator fingerprinting, Stytch bot detection analysis.
 */
export function detectOpenAIOperator(): FrameworkDetectionResult {
  const signals: Record<string, unknown> = {};
  const found: string[] = [];

  // The research cited above places Operator on Linux cloud VMs. A Linux
  // platform counts as one signal; Playwright detection is not consulted.
  const platform = navigator.platform ?? '';
  signals.platform = platform;
  if (platform.startsWith('Linux')) {
    found.push('Linux platform');
  }

  // Check user agent for any OpenAI/Operator identification.
  // As of 2025, Operator does NOT self-identify, but future versions might.
  const ua = navigator.userAgent;
  if (ua.includes('Operator') || ua.includes('OpenAI')) {
    found.push('userAgent');
    signals.userAgent = ua;
  }

  // Operator's Chromium has a homogeneous fingerprint: same browser version,
  // no variation in plugins. Low plugin count is a weak signal.
  try {
    const pluginCount = navigator.plugins?.length ?? -1;
    signals.pluginCount = pluginCount;
    if (pluginCount === 0) {
      found.push('zero browser plugins');
    }
  } catch {
    // Ignore
  }

  // Software-rendered WebGL in a cloud VM
  const renderer = getCachedWebGLRenderer();
  if (renderer !== null) {
    signals.webglRenderer = renderer;
    if (renderer.includes('SwiftShader') || renderer.includes('llvmpipe')
        || renderer.includes('ANGLE') && renderer.includes('Google')) {
      found.push('cloud/VM WebGL renderer');
    }
  }

  // Require at least 2 signals for detection to reduce false positives
  const detected = found.length >= 2;

  return {
    detected,
    frameworkType: detected ? 'openai-operator' : 'unknown',
    method: 'automation-flag',
    confidence: detected ? 'medium' : 'low',
    detail: detected
      ? `Environment consistent with OpenAI Operator: ${found.join(', ')}.`
      : 'No OpenAI Operator environment indicators detected.',
    signals,
  };
}

/**
 * Run all framework-specific detection checks.
 */
export function detectAllFrameworks(): FrameworkDetectionResult[] {
  const results: FrameworkDetectionResult[] = [];

  const computerUse = detectAnthropicComputerUse();
  if (computerUse.detected) results.push(computerUse);

  const operator = detectOpenAIOperator();
  if (operator.detected) results.push(operator);

  const generic = detectGenericAutomation();
  if (generic.detected) results.push(generic);

  return results;
}

/**
 * Check for generic automation indicators that are not framework-specific.
 */
export function detectGenericAutomation(): FrameworkDetectionResult {
  const signals: Record<string, unknown> = {};
  const indicators: string[] = [];

  // Headless Chrome indicators
  // chrome.loadTimes and chrome.csi are missing in headless mode
  const chromeObj = (window as unknown as Record<string, unknown>).chrome as Record<string, unknown> | undefined;
  if (chromeObj) {
    signals.hasLoadTimes = 'loadTimes' in chromeObj;
    signals.hasCsi = 'csi' in chromeObj;

    if (!('loadTimes' in chromeObj)) {
      indicators.push('missing chrome.loadTimes');
    }
    if (!('csi' in chromeObj)) {
      indicators.push('missing chrome.csi');
    }
  }

  // Check screen dimensions vs viewport for headless
  signals.outerWidth = window.outerWidth;
  signals.outerHeight = window.outerHeight;
  signals.innerWidth = window.innerWidth;
  signals.innerHeight = window.innerHeight;

  if (window.outerWidth === 0 && window.outerHeight === 0) {
    indicators.push('zero outer dimensions');
  }

  // Dimension inversion: outerWidth < innerWidth is physically impossible in a real
  // browser window (outer includes title bar + chrome). Headless Puppeteer/Chromium
  // exhibits this because it doesn't render window chrome.
  // Verified against real Puppeteer v24: outerWidth=756, innerWidth=800.
  if (window.outerWidth > 0 && window.outerWidth < window.innerWidth) {
    indicators.push('outer < inner dimension inversion (headless indicator)');
  }

  // Dimension equality: outerWidth === innerWidth with non-zero values indicates
  // no browser chrome (title bar, scrollbar). Selenium WebDriver exhibits this.
  // Verified against real Selenium 4.41 + Chrome 145: outerWidth=innerWidth=1200.
  if (window.outerWidth > 0 && window.outerWidth === window.innerWidth
      && window.outerHeight > 0 && window.outerHeight === window.innerHeight) {
    indicators.push('outer === inner dimensions (no browser chrome)');
  }

  // HeadlessChrome in user agent: Puppeteer and headless Chromium include this
  // by default. Easy to spoof but still a useful corroborating signal.
  // Verified against real Puppeteer v24: "HeadlessChrome/145.0.0.0".
  if (navigator.userAgent.includes('HeadlessChrome')) {
    indicators.push('HeadlessChrome in user agent');
    signals.userAgent = navigator.userAgent;
  }

  // Check for missing browser-specific APIs
  if (!window.chrome) {
    indicators.push('window.chrome missing');
    signals.chromePresent = false;
  }

  // Check WebGL renderer for headless indicators (cached to avoid WebGL context leaks)
  const webglResult = getCachedWebGLRenderer();
  if (webglResult !== null) {
    signals.webglRenderer = webglResult;
    if (webglResult.includes('SwiftShader') || webglResult.includes('llvmpipe')) {
      indicators.push('software renderer (headless indicator)');
    }
  }

  const detected = indicators.length >= 2;
  return {
    detected,
    frameworkType: detected ? 'cdp-generic' : 'unknown',
    method: 'automation-flag',
    confidence: detected ? 'medium' : 'low',
    detail: detected
      ? `Generic automation indicators: ${indicators.join(', ')}.`
      : 'No generic automation indicators detected.',
    signals,
  };
}
