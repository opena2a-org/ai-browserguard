/**
 * Delegation rule engine.
 *
 * Evaluates delegation rules to determine what actions an agent is
 * permitted to perform. Supports site patterns, action restrictions,
 * and time bounds.
 */

import type {
  DelegationRule,
  DelegationPreset,
  DelegationScope,
  DelegationToken,
  SitePattern,
  ActionRestriction,
  TimeBound,
} from '../types/delegation';
import type { AgentCapability } from '../types/agent';

function generateId(): string {
  return crypto.randomUUID();
}

const READ_ONLY_CAPABILITIES: AgentCapability[] = ['navigate', 'read-dom'];
const LIMITED_CAPABILITIES: AgentCapability[] = ['navigate', 'read-dom', 'click', 'type-text'];
const ALL_CAPABILITIES: AgentCapability[] = [
  'navigate', 'read-dom', 'click', 'type-text', 'submit-form',
  'download-file', 'open-tab', 'close-tab', 'screenshot',
  'execute-script', 'modify-dom',
];

function buildActionRestrictions(allowed: AgentCapability[]): ActionRestriction[] {
  return ALL_CAPABILITIES.map((cap) => ({
    capability: cap,
    action: allowed.includes(cap) ? 'allow' as const : 'block' as const,
  }));
}

/**
 * Create a delegation rule from a preset.
 */
export function createRuleFromPreset(
  preset: DelegationPreset,
  options?: {
    sitePatterns?: SitePattern[];
    durationMinutes?: number;
    label?: string;
  }
): DelegationRule {
  const now = new Date();
  let scope: DelegationScope;

  switch (preset) {
    case 'readOnly':
      scope = {
        sitePatterns: [],
        actionRestrictions: buildActionRestrictions(READ_ONLY_CAPABILITIES),
        timeBound: null,
      };
      break;

    case 'limited': {
      const durationMinutes = options?.durationMinutes ?? 60;
      const expiresAt = new Date(now.getTime() + durationMinutes * 60000);
      const timeBound: TimeBound = {
        durationMinutes,
        grantedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      scope = {
        sitePatterns: options?.sitePatterns ?? [],
        actionRestrictions: buildActionRestrictions(LIMITED_CAPABILITIES),
        timeBound,
      };
      break;
    }

    case 'fullAccess':
      scope = {
        sitePatterns: [],
        actionRestrictions: buildActionRestrictions(ALL_CAPABILITIES),
        timeBound: null,
      };
      break;
  }

  return {
    id: generateId(),
    preset,
    scope,
    createdAt: now.toISOString(),
    isActive: true,
    label: options?.label,
  };
}

/**
 * Evaluate whether an action is allowed under a delegation rule.
 */
export function evaluateRule(
  rule: DelegationRule,
  action: AgentCapability,
  url: string
): { allowed: boolean; reason: string } {
  if (!rule.isActive) {
    return { allowed: false, reason: 'Delegation rule is not active.' };
  }

  if (isTimeBoundExpired(rule.scope.timeBound)) {
    return { allowed: false, reason: 'Delegation has expired.' };
  }

  // Check site patterns
  const defaultSiteAction = rule.preset === 'limited' ? 'block' as const : 'allow' as const;
  const siteResult = evaluateSitePatterns(url, rule.scope.sitePatterns, defaultSiteAction);
  if (!siteResult.allowed) {
    const patternDetail = siteResult.matchedPattern
      ? ` (matched: ${siteResult.matchedPattern.pattern})`
      : ' (default policy)';
    return { allowed: false, reason: `URL blocked by site policy${patternDetail}.` };
  }

  // Check action restrictions
  const actionResult = evaluateActionRestrictions(action, rule.scope.actionRestrictions);
  if (!actionResult.allowed) {
    return {
      allowed: false,
      reason: `Action "${action}" is not permitted under ${rule.preset} delegation.`,
    };
  }

  return { allowed: true, reason: 'Action permitted by delegation rules.' };
}

/**
 * Check if a URL matches any site pattern in the scope.
 * First match wins.
 */
export function evaluateSitePatterns(
  url: string,
  patterns: SitePattern[],
  defaultAction: 'allow' | 'block'
): { allowed: boolean; matchedPattern: SitePattern | null } {
  for (const pattern of patterns) {
    if (matchGlob(url, pattern.pattern)) {
      return {
        allowed: pattern.action === 'allow',
        matchedPattern: pattern,
      };
    }
  }
  return { allowed: defaultAction === 'allow', matchedPattern: null };
}

/**
 * Match a URL against a glob pattern.
 */
function matchGlob(url: string, pattern: string): boolean {
  try {
    // If pattern doesn't contain protocol, match against hostname
    if (!pattern.includes('://')) {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname;
      // Convert glob to regex: * matches any characters except dots in domain context
      const regexStr = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^.]*');
      return new RegExp(`^${regexStr}$`).test(hostname);
    }

    // Full URL pattern matching. The escape class includes `?` so that a
    // literal `?` in a URL pattern (which is a regex zero-or-one metacharacter)
    // does not silently widen the match. `*` is intentionally not escaped here
    // — the next replace converts `\*` back into `.*` for glob semantics.
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
      .replace(/\\\*/g, '.*');
    return new RegExp(`^${regexStr}$`).test(url);
  } catch {
    return false;
  }
}

/**
 * Check if an action is allowed by the action restriction list.
 */
export function evaluateActionRestrictions(
  action: AgentCapability,
  restrictions: ActionRestriction[]
): { allowed: boolean; matchedRestriction: ActionRestriction | null } {
  const restriction = restrictions.find((r) => r.capability === action);
  if (!restriction) {
    // Default-block if not listed
    return { allowed: false, matchedRestriction: null };
  }
  return {
    allowed: restriction.action === 'allow',
    matchedRestriction: restriction,
  };
}

/**
 * Check if a time bound has expired.
 */
export function isTimeBoundExpired(timeBound: TimeBound | null): boolean {
  if (timeBound === null) return false;
  return new Date().getTime() > new Date(timeBound.expiresAt).getTime();
}

/**
 * Issue a delegation token for an agent session (local-only, local-only, unsigned).
 */
export function issueToken(
  ruleId: string,
  agentId: string,
  scope: DelegationScope,
  expiresAt: string
): DelegationToken {
  return {
    tokenId: generateId(),
    ruleId,
    agentId,
    scope,
    issuedAt: new Date().toISOString(),
    expiresAt,
    revoked: false,
  };
}

/**
 * Revoke a delegation token.
 */
export function revokeToken(token: DelegationToken): DelegationToken {
  return { ...token, revoked: true };
}
