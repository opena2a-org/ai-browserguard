/**
 * Delegation types for controlling agent access.
 *
 * The delegation system allows users to define boundaries for what
 * an AI agent is permitted to do in their browser session.
 */

import type { AgentCapability } from './agent';

/**
 * Built-in delegation presets that provide quick configuration.
 * - "readOnly": Agent can navigate and read DOM, but cannot interact.
 * - "limited": Agent can interact with specific allowlisted sites, time-bounded.
 * - "fullAccess": Agent can do anything, but all actions are logged and boundary alerts fire.
 */
export type DelegationPreset = 'readOnly' | 'limited' | 'fullAccess';

/**
 * URL pattern for site-level access control.
 * Uses glob-style matching (e.g., "*.bank.com", "https://example.com/*").
 */
export interface SitePattern {
  /** Glob pattern to match against page URLs. */
  pattern: string;

  /** Whether this pattern allows or blocks access. */
  action: 'allow' | 'block';

  /** Optional human-readable description of why this rule exists. */
  reason?: string;
}

/**
 * Restriction on specific action types.
 * When an action type is listed here, it is blocked for the current delegation.
 */
export interface ActionRestriction {
  /** The capability being restricted. */
  capability: AgentCapability;

  /** Whether this capability is allowed or blocked. */
  action: 'allow' | 'block';
}

/**
 * Time-based bounds for a delegation session.
 * Delegation automatically expires when the time bound is reached.
 */
export interface TimeBound {
  /** Duration in minutes (15, 60, 240 are the preset options). */
  durationMinutes: number;

  /** ISO 8601 timestamp when the delegation was granted. */
  grantedAt: string;

  /** ISO 8601 timestamp when the delegation expires. Computed from grantedAt + duration. */
  expiresAt: string;
}

/**
 * The scope of actions permitted under a delegation.
 * Combines site patterns, action restrictions, and time bounds.
 */
export interface DelegationScope {
  /** Site-level access patterns. Evaluated in order; first match wins. */
  sitePatterns: SitePattern[];

  /** Action-level restrictions. If an action is not listed, it is blocked by default. */
  actionRestrictions: ActionRestriction[];

  /** Time bounds for this delegation. Null means no time limit (fullAccess preset). */
  timeBound: TimeBound | null;
}

/**
 * A complete delegation rule that maps a preset to a concrete scope.
 * Created by the delegation wizard and stored in chrome.storage.local.
 */
export interface DelegationRule {
  /** Unique identifier for this rule (UUID v4). */
  id: string;

  /** The preset this rule was created from. */
  preset: DelegationPreset;

  /** The concrete scope defining what is permitted. */
  scope: DelegationScope;

  /** ISO 8601 timestamp when this rule was created. */
  createdAt: string;

  /**
   * The detected agent this rule is bound to.
   *
   * - A string binds the rule to one specific detected agent (by `agent.id`).
   *   It is enforced only in the tab where that agent is active, so allowing
   *   one agent never grants access to another.
   * - `null` is a session-wide rule (created by the delegation wizard) that
   *   applies to any tab without a more specific per-agent rule.
   *
   * Multiple rules can be active at once: at most one per agent, plus at most
   * one session-wide rule. A per-agent rule takes precedence over the
   * session-wide rule in its tab.
   */
  agentId: string | null;

  /** Whether this rule is currently active. */
  isActive: boolean;

  /** Optional label for this rule (e.g., "Banking session", "Development work"). */
  label?: string;
}

/**
 * A delegation token that could be verified against AIM in future versions.
 * Currently generated locally and not cryptographically signed.
 * The structure is designed to be extensible for AIM integration.
 */
export interface DelegationToken {
  /** Unique token identifier (UUID v4). */
  tokenId: string;

  /** Reference to the delegation rule this token was issued under. */
  ruleId: string;

  /** Reference to the detected agent this token was issued to. */
  agentId: string;

  /** The scope encoded in this token. Duplicates rule scope for portability. */
  scope: DelegationScope;

  /** ISO 8601 timestamp when this token was issued. */
  issuedAt: string;

  /** ISO 8601 timestamp when this token expires. */
  expiresAt: string;

  /** Whether this token has been revoked (e.g., by kill switch). */
  revoked: boolean;

  /**
   * Reserved for AIM integration: cryptographic signature of the token.
   * Not currently populated.
   */
  signature?: string;

  /**
   * Reserved for AIM integration: the AIM instance that issued this token.
   * Not currently populated.
   */
  issuer?: string;
}
