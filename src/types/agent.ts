/**
 * Agent identity and detection types.
 *
 * These types represent the identity of a detected AI agent, the method
 * used to detect it, and its advertised or inferred capabilities.
 */

/**
 * Known automation framework types that can be detected.
 * "unknown" is used when behavioral heuristics detect automation
 * but cannot fingerprint the specific framework.
 */
export type AgentType =
  | 'playwright'
  | 'puppeteer'
  | 'selenium'
  | 'anthropic-computer-use'
  | 'openai-operator'
  | 'cdp-generic'
  | 'webdriver-generic'
  | 'unknown';

/**
 * The method by which an agent was detected.
 * Multiple methods may contribute to a single detection.
 */
export type DetectionMethod =
  | 'cdp-connection'
  | 'webdriver-flag'
  | 'automation-flag'
  | 'behavioral-timing'
  | 'behavioral-precision'
  | 'behavioral-typing'
  | 'framework-fingerprint'
  | 'synthetic-event';

/**
 * Confidence level of a detection result.
 * - "confirmed": Multiple strong signals agree (e.g., WebDriver flag + CDP markers).
 * - "high": Single strong signal (e.g., navigator.webdriver is true).
 * - "medium": Behavioral heuristics suggest automation.
 * - "low": Weak or ambiguous signals that may be false positives.
 */
export type DetectionConfidence = 'confirmed' | 'high' | 'medium' | 'low';

/**
 * Capabilities an agent may request or be inferred to have.
 * Used in delegation rule matching.
 */
export type AgentCapability =
  | 'navigate'
  | 'read-dom'
  | 'click'
  | 'type-text'
  | 'submit-form'
  | 'download-file'
  | 'open-tab'
  | 'close-tab'
  | 'screenshot'
  | 'execute-script'
  | 'modify-dom'
  | 'network-request';

/**
 * Represents a detected AI agent operating in the browser.
 *
 * An AgentIdentity is created when detection confirms (or strongly suspects)
 * that an automation framework is controlling the current page.
 */
export interface AgentIdentity {
  /** Unique identifier for this agent session (UUID v4). */
  id: string;

  /** The detected or inferred automation framework. */
  type: AgentType;

  /** How the agent was detected. May include multiple methods. */
  detectionMethods: DetectionMethod[];

  /** Confidence level of the detection. */
  confidence: DetectionConfidence;

  /** ISO 8601 timestamp when the agent was first detected. */
  detectedAt: string;

  /** The URL where the agent was first detected. */
  originUrl: string;

  /** Inferred capabilities based on observed behavior. */
  observedCapabilities: AgentCapability[];

  /**
   * Optional trust score from AIM registry lookup.
   * Reserved for future AIM integration.
   * Range: 0.0 (untrusted) to 1.0 (fully trusted).
   */
  trustScore?: number;

  /**
   * Optional human-readable label for the agent.
   * May be populated from AIM registry in future versions.
   */
  label?: string;

  /** Whether this agent session is currently active. */
  isActive: boolean;
}
