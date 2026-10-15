/**
 * Agent takeover detection engine.
 *
 * Orchestrates all detection methods (CDP, WebDriver, automation, behavioral)
 * to determine whether an AI agent is controlling the current page.
 */

import type { AgentIdentity, AgentType, DetectionConfidence } from '../types/agent';
import type { DetectionEvent } from '../types/events';
import { detectCdpConnection, monitorCdpConnections } from '../detection/cdp-patterns';
import type { CdpDetectionResult } from '../detection/cdp-patterns';
import { detectWebDriverFlag, detectNavigatorAnomalies, detectSeleniumMarkers, monitorWebDriverChanges } from '../detection/webdriver';
import type { WebDriverDetectionResult } from '../detection/webdriver';
import { detectAllFrameworks } from '../detection/automation';
import type { FrameworkDetectionResult } from '../detection/automation';
import { analyzeMouseBehavior, analyzeKeyboardBehavior, analyzeClickPrecision, aggregateBehavioralAnalysis } from '../detection/behavioral';
import type { BehavioralDetectionResult } from '../detection/behavioral';

export interface DetectionVerdictResult {
  agentDetected: boolean;
  agent: AgentIdentity | null;
  cdpResult: CdpDetectionResult | null;
  webDriverResult: WebDriverDetectionResult | null;
  frameworkResults: FrameworkDetectionResult[];
  behavioralResult: BehavioralDetectionResult | null;
  overallConfidence: DetectionConfidence;
  event: DetectionEvent;
}

export interface DetectorConfig {
  enableBehavioral: boolean;
  minimumConfidence: DetectionConfidence;
  recheckIntervalMs: number;
  behavioralSampleSize: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  enableBehavioral: true,
  minimumConfidence: 'low',
  recheckIntervalMs: 5000,
  behavioralSampleSize: 20,
};

const CONFIDENCE_ORDER: DetectionConfidence[] = ['low', 'medium', 'high', 'confirmed'];

function confidenceRank(c: DetectionConfidence): number {
  return CONFIDENCE_ORDER.indexOf(c);
}

function maxConfidence(...confidences: DetectionConfidence[]): DetectionConfidence {
  return confidences.reduce((best, c) =>
    confidenceRank(c) > confidenceRank(best) ? c : best
  , 'low');
}

/**
 * Run a full detection sweep using all available methods.
 */
export function runDetectionSweep(config?: Partial<DetectorConfig>): DetectionVerdictResult {
  const cfg = { ...DEFAULT_DETECTOR_CONFIG, ...config };
  const methods: import('../types/agent').DetectionMethod[] = [];
  const signals: Record<string, unknown> = {};

  // 1. WebDriver flag check
  const webDriverResult = detectWebDriverFlag();
  if (webDriverResult.detected) {
    methods.push(webDriverResult.method);
    Object.assign(signals, webDriverResult.signals);
  }

  // Also check navigator anomalies
  const navigatorResult = detectNavigatorAnomalies();
  if (navigatorResult.detected) {
    methods.push(navigatorResult.method);
    Object.assign(signals, navigatorResult.signals);
  }

  // Check Selenium markers
  const seleniumResult = detectSeleniumMarkers();
  if (seleniumResult.detected) {
    methods.push(seleniumResult.method);
    Object.assign(signals, seleniumResult.signals);
  }

  // 2. CDP connection check
  const cdpResult = detectCdpConnection();
  if (cdpResult.detected) {
    methods.push(cdpResult.method);
    Object.assign(signals, cdpResult.signals);
  }

  // 3. Framework-specific fingerprinting
  const frameworkResults = detectAllFrameworks();
  for (const fr of frameworkResults) {
    methods.push(fr.method);
    Object.assign(signals, fr.signals);
  }

  // 4. Behavioral is skipped in synchronous sweep (needs collected events)
  const behavioralResult: BehavioralDetectionResult | null = null;

  // Determine if anything was detected
  const detectedResults = [
    webDriverResult.detected ? webDriverResult : null,
    navigatorResult.detected ? navigatorResult : null,
    seleniumResult.detected ? seleniumResult : null,
    cdpResult.detected ? cdpResult : null,
    ...frameworkResults.filter((r) => r.detected),
  ].filter(Boolean);

  const agentDetected = detectedResults.length > 0;

  // Compute overall confidence
  let overallConfidence: DetectionConfidence = 'low';
  if (agentDetected) {
    const confidences: DetectionConfidence[] = [];
    if (webDriverResult.detected) confidences.push(webDriverResult.confidence);
    if (seleniumResult.detected) confidences.push(seleniumResult.confidence);
    if (cdpResult.detected) confidences.push(cdpResult.confidence);
    for (const fr of frameworkResults) {
      if (fr.detected) confidences.push(fr.confidence);
    }
    overallConfidence = maxConfidence(...confidences);

    // Multiple signals upgrade confidence
    if (detectedResults.length >= 3 && confidenceRank(overallConfidence) < confidenceRank('confirmed')) {
      overallConfidence = 'confirmed';
    } else if (detectedResults.length >= 2 && confidenceRank(overallConfidence) < confidenceRank('high')) {
      overallConfidence = 'high';
    }
  }

  // Check minimum confidence
  if (agentDetected && confidenceRank(overallConfidence) < confidenceRank(cfg.minimumConfidence)) {
    // Below threshold - report as not detected
    const event: DetectionEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      methods,
      confidence: overallConfidence,
      agent: null,
      url: window.location.href,
      signals,
    };
    return {
      agentDetected: false,
      agent: null,
      cdpResult,
      webDriverResult,
      frameworkResults,
      behavioralResult,
      overallConfidence,
      event,
    };
  }

  // Classify agent type
  const agentType = agentDetected
    ? classifyAgentType(cdpResult, webDriverResult, frameworkResults, behavioralResult)
    : 'unknown' as AgentType;

  const agent: AgentIdentity | null = agentDetected
    ? {
        id: crypto.randomUUID(),
        type: agentType,
        detectionMethods: methods,
        confidence: overallConfidence,
        detectedAt: new Date().toISOString(),
        originUrl: window.location.href,
        observedCapabilities: [],
        isActive: true,
      }
    : null;

  const event: DetectionEvent = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    methods,
    confidence: overallConfidence,
    agent,
    url: window.location.href,
    signals,
  };

  return {
    agentDetected,
    agent,
    cdpResult,
    webDriverResult,
    frameworkResults,
    behavioralResult,
    overallConfidence,
    event,
  };
}

/**
 * Start continuous detection monitoring.
 */
export function startDetectionMonitor(
  config: Partial<DetectorConfig>,
  onDetection: (verdict: DetectionVerdictResult) => void
): () => void {
  const cfg = { ...DEFAULT_DETECTOR_CONFIG, ...config };
  const cleanups: Array<() => void> = [];

  // Each sweep names its agent by a new random id, so an agent already
  // reported is recognised by its type and the page address it was seen on:
  // the same type of agent on the same page is not reported again. A verdict
  // with no agent is passed on as before.
  let reported: { type: AgentType; url: string } | null = null;
  const report = (verdict: DetectionVerdictResult): void => {
    if (verdict.agent) {
      const { type } = verdict.agent;
      const { url } = verdict.event;
      if (reported && reported.type === type && reported.url === url) return;
      reported = { type, url };
    }
    onDetection(verdict);
  };

  // Behavioral data collection buffers
  const mouseEvents: Array<{
    type: string;
    clientX: number;
    clientY: number;
    timestamp: number;
    isTrusted: boolean;
  }> = [];
  const keyEvents: Array<{
    type: string;
    key: string;
    timestamp: number;
    isTrusted: boolean;
  }> = [];
  const clickPrecisionData: Array<{
    clientX: number;
    clientY: number;
    targetRect: { x: number; y: number; width: number; height: number };
    timestamp: number;
  }> = [];

  // Initial sweep
  const initialResult = runDetectionSweep(cfg);
  if (initialResult.agentDetected) {
    report(initialResult);
  }

  // Periodic re-checks
  const intervalId = setInterval(() => {
    const result = runDetectionSweep(cfg);

    // Behavioral analysis with collected data
    if (cfg.enableBehavioral && mouseEvents.length >= cfg.behavioralSampleSize) {
      const mouseResult = analyzeMouseBehavior([...mouseEvents]);
      const keyResult = keyEvents.length >= cfg.behavioralSampleSize
        ? analyzeKeyboardBehavior([...keyEvents])
        : null;
      const clickResult = clickPrecisionData.length >= 5
        ? analyzeClickPrecision([...clickPrecisionData])
        : null;

      const behavioralResult = aggregateBehavioralAnalysis(mouseResult, keyResult, clickResult);
      result.behavioralResult = behavioralResult;

      if (behavioralResult.detected && !result.agentDetected) {
        result.agentDetected = true;
        result.overallConfidence = behavioralResult.confidence;
        result.event.confidence = behavioralResult.confidence;
        result.event.methods.push(behavioralResult.method);
      }
    }

    if (result.agentDetected) {
      report(result);
    }
  }, cfg.recheckIntervalMs);
  cleanups.push(() => clearInterval(intervalId));

  // Behavioral event collection
  if (cfg.enableBehavioral) {
    const maxBuffer = cfg.behavioralSampleSize * 3;

    const onMouseEvent = (e: MouseEvent) => {
      mouseEvents.push({
        type: e.type,
        clientX: e.clientX,
        clientY: e.clientY,
        timestamp: e.timeStamp,
        isTrusted: e.isTrusted,
      });
      if (mouseEvents.length > maxBuffer) mouseEvents.shift();
    };

    const onKeyEvent = (e: KeyboardEvent) => {
      keyEvents.push({
        type: e.type,
        key: e.key,
        timestamp: e.timeStamp,
        isTrusted: e.isTrusted,
      });
      if (keyEvents.length > maxBuffer) keyEvents.shift();
    };

    const onClickForPrecision = (e: MouseEvent) => {
      const target = e.target as Element;
      if (target) {
        const rect = target.getBoundingClientRect();
        clickPrecisionData.push({
          clientX: e.clientX,
          clientY: e.clientY,
          targetRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          timestamp: e.timeStamp,
        });
        if (clickPrecisionData.length > maxBuffer) clickPrecisionData.shift();
      }
    };

    document.addEventListener('mousemove', onMouseEvent, { passive: true, capture: true });
    document.addEventListener('click', onClickForPrecision, { passive: true, capture: true });
    document.addEventListener('keydown', onKeyEvent, { passive: true, capture: true });
    document.addEventListener('keyup', onKeyEvent, { passive: true, capture: true });

    cleanups.push(() => {
      document.removeEventListener('mousemove', onMouseEvent, { capture: true });
      document.removeEventListener('click', onClickForPrecision, { capture: true });
      document.removeEventListener('keydown', onKeyEvent, { capture: true });
      document.removeEventListener('keyup', onKeyEvent, { capture: true });
    });
  }

  // CDP and WebDriver monitors
  const cdpCleanup = monitorCdpConnections((result) => {
    if (result.detected) {
      const verdict = runDetectionSweep(cfg);
      if (verdict.agentDetected) {
        report(verdict);
      }
    }
  });
  cleanups.push(cdpCleanup);

  const wdCleanup = monitorWebDriverChanges((result) => {
    if (result.detected) {
      const verdict = runDetectionSweep(cfg);
      if (verdict.agentDetected) {
        report(verdict);
      }
    }
  });
  cleanups.push(wdCleanup);

  return () => {
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* ignore */ }
    }
  };
}

/**
 * Determine the agent type from detection results.
 */
export function classifyAgentType(
  cdpResult: CdpDetectionResult | null,
  webDriverResult: WebDriverDetectionResult | null,
  frameworkResults: FrameworkDetectionResult[],
  behavioralResult: BehavioralDetectionResult | null
): AgentType {
  // Check framework results first (most specific)
  for (const fr of frameworkResults) {
    if (fr.detected && fr.frameworkType !== 'unknown') {
      return fr.frameworkType;
    }
  }

  // CDP-based detection
  if (cdpResult?.detected) {
    // Check for specific CDP-based frameworks from CDP detail
    if (cdpResult.detail.includes('Playwright')) return 'playwright';
    if (cdpResult.detail.includes('Puppeteer')) return 'puppeteer';
    return 'cdp-generic';
  }

  // WebDriver-based detection
  if (webDriverResult?.detected) {
    return 'webdriver-generic';
  }

  // Only behavioral
  if (behavioralResult?.detected) {
    return 'unknown';
  }

  return 'unknown';
}
