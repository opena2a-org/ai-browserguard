/**
 * Event types for inter-component communication and session logging.
 *
 * These types define the messages passed between content scripts,
 * the background service worker, and the popup UI.
 */

import type { AgentIdentity, AgentCapability, DetectionMethod, DetectionConfidence } from './agent';
import type { DelegationRule } from './delegation';

/**
 * Categories of agent events tracked in the session timeline.
 */
export type AgentEventType =
  | 'detection'
  | 'action-allowed'
  | 'action-blocked'
  | 'boundary-violation'
  | 'delegation-granted'
  | 'delegation-revoked'
  | 'kill-switch-activated'
  | 'download'
  | 'session-start'
  | 'session-end';

/**
 * A single event in the agent session timeline.
 * Stored chronologically in the session log.
 */
export interface AgentEvent {
  /** Unique event identifier (UUID v4). */
  id: string;

  /** The type of event. */
  type: AgentEventType;

  /** ISO 8601 timestamp when this event occurred. */
  timestamp: string;

  /** The URL where this event occurred. */
  url: string;

  /** CSS selector of the target DOM element, if applicable. */
  targetSelector?: string;

  /** The action the agent attempted, if applicable. */
  attemptedAction?: AgentCapability;

  /** Whether the action was allowed or blocked. */
  outcome: 'allowed' | 'blocked' | 'informational';

  /** Human-readable description of what happened. */
  description: string;

  /** Reference to the delegation rule that governed this event, if any. */
  ruleId?: string;
}

/**
 * A boundary violation event. Created when an agent attempts an action
 * that exceeds its delegated permissions.
 */
export interface BoundaryViolation {
  /** Unique violation identifier (UUID v4). */
  id: string;

  /** ISO 8601 timestamp when the violation occurred. */
  timestamp: string;

  /** Reference to the agent that caused the violation. */
  agentId: string;

  /** The action the agent attempted. */
  attemptedAction: AgentCapability;

  /** The URL where the violation occurred. */
  url: string;

  /** CSS selector of the target element, if applicable. */
  targetSelector?: string;

  /** The delegation rule that blocked this action. */
  blockingRuleId: string;

  /** Human-readable explanation of why this was blocked. */
  reason: string;

  /** Whether the user chose to allow this action as a one-time override. */
  userOverride: boolean;
}

/**
 * Event emitted when the kill switch is activated.
 * Contains details about what was terminated.
 */
export interface KillSwitchEvent {
  /** Unique event identifier (UUID v4). */
  id: string;

  /** ISO 8601 timestamp when the kill switch was activated. */
  timestamp: string;

  /** How the kill switch was triggered. */
  trigger: 'button' | 'keyboard-shortcut' | 'api';

  /** IDs of agent sessions that were terminated. */
  terminatedAgentIds: string[];

  /** IDs of delegation tokens that were revoked. */
  revokedTokenIds: string[];

  /** Whether CDP connections were successfully terminated. */
  cdpTerminated: boolean;

  /** Whether automation flags were successfully cleared. */
  automationFlagsCleared: boolean;
}

/**
 * Event emitted when agent detection occurs or updates.
 */
export interface DetectionEvent {
  /** Unique event identifier (UUID v4). */
  id: string;

  /** ISO 8601 timestamp of the detection. */
  timestamp: string;

  /** The detection methods that contributed to this result. */
  methods: DetectionMethod[];

  /** Confidence level of the detection. */
  confidence: DetectionConfidence;

  /** The resulting agent identity, if detection was positive. */
  agent: AgentIdentity | null;

  /** The URL where detection was performed. */
  url: string;

  /** Raw signal data for debugging (e.g., which flags were set). */
  signals: Record<string, unknown>;
}

// ============================================================
// Message passing types (content script <-> background <-> popup)
// ============================================================

/**
 * Message types used in chrome.runtime.sendMessage communication.
 */
export type MessageType =
  | 'DETECTION_RESULT'
  | 'AGENT_ACTION'
  | 'BOUNDARY_CHECK_REQUEST'
  | 'BOUNDARY_CHECK_RESPONSE'
  | 'KILL_SWITCH_ACTIVATE'
  | 'KILL_SWITCH_RESET'
  | 'KILL_SWITCH_RESULT'
  | 'DELEGATION_UPDATE'
  | 'SESSION_QUERY'
  | 'SESSION_DATA'
  | 'STATUS_QUERY'
  | 'STATUS_RESPONSE'
  | 'SETTINGS_UPDATE'
  | 'ALLOW_ONCE'
  | 'CDP_DEBUGGER_CHECK'
  | 'NETWORK_EVENT'
  | 'REPORTS_QUERY'
  | 'REPORT_EXPORT'
  | 'REPORT_DOWNLOAD'
  | 'CONTRIBUTE_STATS'
  | 'CONTRIBUTE_ENABLE'
  | 'CONTRIBUTE_DISABLE'
  | 'CONTRIBUTE_FLUSH'
  | 'CONTRIBUTE_TIP_DISMISS'
  | 'DOMAIN_WHITELIST'
  | 'OPEN_POPUP';

/**
 * Typed message payload for inter-component communication.
 * Each message type maps to a specific payload shape.
 */
export interface MessagePayload {
  /** The message type identifier. */
  type: MessageType;

  /** The message payload. Shape depends on `type`. */
  data: unknown;

  /** Optional correlation ID for request-response pairs. */
  correlationId?: string;

  /** ISO 8601 timestamp when the message was sent. */
  sentAt: string;
}
