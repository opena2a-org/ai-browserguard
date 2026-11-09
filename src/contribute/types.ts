/**
 * Types of the anonymized summaries src/contribute/anonymize.ts builds from a
 * detection or a session. The extension sends none of them.
 */

/** A single contribution event ready for submission to the Registry. */
export interface ContributeEvent {
  /** Event type identifier. */
  type: 'detection_summary' | 'session_summary' | 'behavioral_summary';

  /** ISO 8601 timestamp when this event was created. */
  timestamp: string;

  /** Detection data (anonymized -- no URLs, no page content, no user data). */
  data: DetectionContribution | SessionContribution | BehavioralContribution;
}

/** Anonymized detection event for a single agent detection. */
export interface DetectionContribution {
  /** Framework detected (e.g., "playwright", "puppeteer", "selenium"). */
  framework: string;

  /** Detection methods used (e.g., ["cdp-connection", "framework-fingerprint"]). */
  detectionMethods: string[];

  /** Confidence level of the detection. */
  confidence: string;

  /** Whether a delegation rule was active during detection. */
  hadDelegation: boolean;
}

/** Anonymized session summary contributed at session end. */
export interface SessionContribution {
  /** Framework type for the agent in this session. */
  framework: string;

  /** Duration of the session in seconds. */
  durationSeconds: number;

  /** Total actions observed. */
  totalActions: number;

  /** Actions that were allowed. */
  allowedActions: number;

  /** Actions that were blocked. */
  blockedActions: number;

  /** Number of boundary violations. */
  violations: number;

  /** How the session ended. */
  endReason: string;

  /** Whether a delegation rule was active. */
  hadDelegation: boolean;

  /** Types of actions observed (e.g., ["navigate", "click", "type-text"]). */
  actionTypes: string[];
}

/** Anonymized behavioral summary (aggregated over time). */
export interface BehavioralContribution {
  /** Framework type. */
  framework: string;

  /** Total sessions observed for this framework. */
  totalSessions: number;

  /** Average session duration in seconds. */
  avgDurationSeconds: number;

  /** Total actions observed across sessions. */
  totalActions: number;

  /** Overall block rate (0.0 - 1.0). */
  blockRate: number;
}
