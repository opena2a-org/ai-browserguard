import { describe, it, expect } from 'vitest';
import {
  createRuleFromPreset,
  evaluateRule,
  evaluateSitePatterns,
  evaluateActionRestrictions,
  isTimeBoundExpired,
  issueToken,
  revokeToken,
  FULL_ACCESS_MAX_MINUTES,
} from './rules';

describe('createRuleFromPreset', () => {
  it('creates a readOnly rule with only navigate and read-dom allowed', () => {
    const rule = createRuleFromPreset('readOnly');
    expect(rule.preset).toBe('readOnly');
    expect(rule.isActive).toBe(true);
    expect(rule.scope.timeBound).toBeNull();

    const allowed = rule.scope.actionRestrictions
      .filter((r) => r.action === 'allow')
      .map((r) => r.capability);
    expect(allowed).toEqual(['navigate', 'read-dom']);
  });

  it('creates a limited rule with time bound and site patterns', () => {
    const rule = createRuleFromPreset('limited', {
      sitePatterns: [{ pattern: '*.example.com', action: 'allow' }],
      durationMinutes: 15,
      label: 'Test session',
    });
    expect(rule.preset).toBe('limited');
    expect(rule.scope.timeBound).not.toBeNull();
    expect(rule.scope.timeBound!.durationMinutes).toBe(15);
    expect(rule.scope.sitePatterns).toHaveLength(1);
    expect(rule.label).toBe('Test session');

    const allowed = rule.scope.actionRestrictions
      .filter((r) => r.action === 'allow')
      .map((r) => r.capability);
    expect(allowed).toContain('navigate');
    expect(allowed).toContain('read-dom');
    expect(allowed).toContain('click');
    expect(allowed).toContain('type-text');
    expect(allowed).not.toContain('submit-form');
  });

  it('creates a fullAccess rule with all capabilities allowed', () => {
    const rule = createRuleFromPreset('fullAccess');
    expect(rule.preset).toBe('fullAccess');

    const blocked = rule.scope.actionRestrictions
      .filter((r) => r.action === 'block');
    expect(blocked).toHaveLength(0);
  });

  it('time-bounds fullAccess so it cannot grant everything indefinitely', () => {
    const rule = createRuleFromPreset('fullAccess');
    expect(rule.scope.timeBound).not.toBeNull();
    expect(rule.scope.timeBound!.durationMinutes).toBe(FULL_ACCESS_MAX_MINUTES);
  });

  it('caps a requested fullAccess duration at the maximum', () => {
    const rule = createRuleFromPreset('fullAccess', { durationMinutes: 10_000 });
    expect(rule.scope.timeBound!.durationMinutes).toBe(FULL_ACCESS_MAX_MINUTES);
  });

  it('binds a rule to an agent when agentId is supplied (session-wide otherwise)', () => {
    expect(createRuleFromPreset('readOnly').agentId).toBeNull();
    expect(createRuleFromPreset('readOnly', { agentId: 'agent-42' }).agentId).toBe('agent-42');
  });

  it('defaults limited duration to 60 minutes when not specified', () => {
    const rule = createRuleFromPreset('limited');
    expect(rule.scope.timeBound!.durationMinutes).toBe(60);
  });
});

describe('evaluateRule', () => {
  it('blocks when rule is inactive', () => {
    const rule = createRuleFromPreset('fullAccess');
    rule.isActive = false;
    const result = evaluateRule(rule, 'click', 'https://example.com');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not active');
  });

  it('allows navigate under readOnly', () => {
    const rule = createRuleFromPreset('readOnly');
    const result = evaluateRule(rule, 'navigate', 'https://example.com');
    expect(result.allowed).toBe(true);
  });

  it('blocks click under readOnly', () => {
    const rule = createRuleFromPreset('readOnly');
    const result = evaluateRule(rule, 'click', 'https://example.com');
    expect(result.allowed).toBe(false);
  });

  it('allows all actions under fullAccess', () => {
    const rule = createRuleFromPreset('fullAccess');
    expect(evaluateRule(rule, 'click', 'https://example.com').allowed).toBe(true);
    expect(evaluateRule(rule, 'submit-form', 'https://bank.com').allowed).toBe(true);
    expect(evaluateRule(rule, 'execute-script', 'https://example.com').allowed).toBe(true);
  });

  it('blocks expired limited delegation', () => {
    const rule = createRuleFromPreset('limited', {
      sitePatterns: [{ pattern: '*.example.com', action: 'allow' }],
      durationMinutes: 15,
    });
    // Set expiry to the past
    rule.scope.timeBound!.expiresAt = new Date(Date.now() - 1000).toISOString();
    const result = evaluateRule(rule, 'click', 'https://example.com');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('blocks URLs not in allowlist for limited preset', () => {
    const rule = createRuleFromPreset('limited', {
      sitePatterns: [{ pattern: '*.example.com', action: 'allow' }],
      durationMinutes: 60,
    });
    const result = evaluateRule(rule, 'click', 'https://other.com/page');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('URL blocked');
  });

  it('allows URLs in allowlist for limited preset', () => {
    const rule = createRuleFromPreset('limited', {
      sitePatterns: [{ pattern: '*.example.com', action: 'allow' }],
      durationMinutes: 60,
    });
    const result = evaluateRule(rule, 'click', 'https://sub.example.com/page');
    expect(result.allowed).toBe(true);
  });
});

describe('evaluateSitePatterns', () => {
  it('returns default when no patterns match', () => {
    const result = evaluateSitePatterns('https://example.com', [], 'allow');
    expect(result.allowed).toBe(true);
    expect(result.matchedPattern).toBeNull();
  });

  it('matches first pattern (first-match-wins)', () => {
    const patterns = [
      { pattern: '*.bank.com', action: 'block' as const },
      { pattern: '*.example.com', action: 'allow' as const },
    ];
    const result = evaluateSitePatterns('https://my.bank.com', patterns, 'allow');
    expect(result.allowed).toBe(false);
    expect(result.matchedPattern?.pattern).toBe('*.bank.com');
  });

  it('blocks by default when default is block', () => {
    const result = evaluateSitePatterns('https://unknown.com', [], 'block');
    expect(result.allowed).toBe(false);
  });

  // Regression: P0-4 — `?` is a regex zero-or-one metacharacter. Before the
  // escape-class fix, a full-URL pattern containing a literal `?` widened the
  // match: `https://example.com/?` became a regex that also matched
  // `https://example.com/` (the slash made optional).
  it('treats a literal `?` in a full-URL pattern literally', () => {
    const patterns = [
      { pattern: 'https://example.com/?', action: 'allow' as const },
    ];
    // Exact match should pass.
    expect(
      evaluateSitePatterns('https://example.com/?', patterns, 'block').allowed,
    ).toBe(true);
    // Without the trailing `?`, the prior buggy behavior would have allowed.
    // The fix asserts this URL is NOT matched by the pattern.
    expect(
      evaluateSitePatterns('https://example.com/', patterns, 'block').allowed,
    ).toBe(false);
  });

  // ---------------------------------------------------------------------
  // ReDoS regression: a pattern with many consecutive wildcards like
  // `*****...` previously compiled to `.*.*.*.*` against which a long URL
  // triggers catastrophic backtracking. The collapse-runs fix caps the
  // compiled regex at `.*.*` regardless of how many `*` the pattern has.
  // ---------------------------------------------------------------------
  describe('catastrophic backtracking guard', () => {
    it('completes within 100ms on a 1000-star pattern against a long URL', () => {
      const patterns = [{ pattern: 'https://' + '*'.repeat(1000), action: 'allow' as const }];
      const longUrl = 'https://example.com/' + 'a/b/'.repeat(500);
      const t0 = Date.now();
      evaluateSitePatterns(longUrl, patterns, 'allow');
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(100);
    });

    it('treats `***` the same as `**` (semantics-preserving collapse)', () => {
      const twoStar = [{ pattern: 'https://**', action: 'allow' as const }];
      const threeStar = [{ pattern: 'https://***', action: 'allow' as const }];
      const url = 'https://example.com/path';
      expect(evaluateSitePatterns(url, twoStar, 'block').allowed).toBe(
        evaluateSitePatterns(url, threeStar, 'block').allowed,
      );
    });
  });
});

describe('evaluateActionRestrictions', () => {
  it('returns allowed for allowed capabilities', () => {
    const restrictions = [
      { capability: 'click' as const, action: 'allow' as const },
      { capability: 'submit-form' as const, action: 'block' as const },
    ];
    expect(evaluateActionRestrictions('click', restrictions).allowed).toBe(true);
  });

  it('returns blocked for blocked capabilities', () => {
    const restrictions = [
      { capability: 'click' as const, action: 'allow' as const },
      { capability: 'submit-form' as const, action: 'block' as const },
    ];
    expect(evaluateActionRestrictions('submit-form', restrictions).allowed).toBe(false);
  });

  it('blocks unlisted capabilities by default', () => {
    const restrictions = [
      { capability: 'click' as const, action: 'allow' as const },
    ];
    expect(evaluateActionRestrictions('execute-script', restrictions).allowed).toBe(false);
  });
});

describe('isTimeBoundExpired', () => {
  it('returns false for null (no time limit)', () => {
    expect(isTimeBoundExpired(null)).toBe(false);
  });

  it('returns false for future expiry', () => {
    const timeBound = {
      durationMinutes: 60,
      grantedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
    expect(isTimeBoundExpired(timeBound)).toBe(false);
  });

  it('returns true for past expiry', () => {
    const timeBound = {
      durationMinutes: 60,
      grantedAt: new Date(Date.now() - 7200000).toISOString(),
      expiresAt: new Date(Date.now() - 3600000).toISOString(),
    };
    expect(isTimeBoundExpired(timeBound)).toBe(true);
  });
});

describe('issueToken / revokeToken', () => {
  it('creates a token with correct fields', () => {
    const scope = {
      sitePatterns: [],
      actionRestrictions: [],
      timeBound: null,
    };
    const token = issueToken('rule-1', 'agent-1', scope, '2099-01-01T00:00:00Z');
    expect(token.ruleId).toBe('rule-1');
    expect(token.agentId).toBe('agent-1');
    expect(token.revoked).toBe(false);
    expect(token.tokenId).toBeTruthy();
  });

  it('revokes a token', () => {
    const scope = {
      sitePatterns: [],
      actionRestrictions: [],
      timeBound: null,
    };
    const token = issueToken('rule-1', 'agent-1', scope, '2099-01-01T00:00:00Z');
    const revoked = revokeToken(token);
    expect(revoked.revoked).toBe(true);
    expect(token.revoked).toBe(false); // original unchanged
  });
});
