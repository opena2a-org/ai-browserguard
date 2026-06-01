/**
 * Unit tests for the MAIN world interceptor.
 *
 * Tests the two exported pure-logic functions:
 *   - matchesPattern(url, pattern)
 *   - isActionAllowed(capability, url, rule)
 *
 * The interceptor module has browser-API side effects (patching window.open,
 * HTMLFormElement.prototype.submit, history.pushState/replaceState) that run
 * on import. We stub the required globals before the dynamic import so the
 * module initialises cleanly in a Node environment.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

// Type alias for the subset of InterceptorRule used in these tests.
interface TestRule {
  isActive: boolean;
  expiresAt: string | null;
  actionRestrictions: Array<{ capability: string; action: 'allow' | 'block' }>;
  sitePatterns: Array<{ pattern: string; action: 'allow' | 'block' }>;
}

// Module-level refs populated after the dynamic import.
let matchesPattern: (url: string, pattern: string) => boolean;
let isActionAllowed: (
  capability: string,
  url: string,
  rule: TestRule | null
) => { allowed: boolean; reason: string };

// ── Global stubs required by the interceptor's side-effect code ──────────────

const win = globalThis as unknown as Record<string, unknown>;

function installBrowserStubs(): void {
  // window.open
  if (!win['open']) {
    win['open'] = vi.fn(() => null);
  }

  // HTMLFormElement
  if (!(globalThis as unknown as Record<string, unknown>)['HTMLFormElement']) {
    (globalThis as unknown as Record<string, unknown>)['HTMLFormElement'] = {
      prototype: { submit: vi.fn() },
    };
  }

  // history.pushState / replaceState
  if (!(globalThis as unknown as Record<string, unknown>)['history']) {
    (globalThis as unknown as Record<string, unknown>)['history'] = {
      pushState: vi.fn(),
      replaceState: vi.fn(),
    };
  }

  // window.addEventListener (may already be a vi.fn from setup.ts)
  if (typeof (globalThis as unknown as Record<string, unknown>)['addEventListener'] !== 'function') {
    (globalThis as unknown as Record<string, unknown>)['addEventListener'] = vi.fn();
  }

  // window.postMessage — stubbed for the one-shot bootstrap envelope only;
  // reportAction / reportCdpDetection / network events all flow through the
  // private MessagePort post-bootstrap, not window.postMessage.
  if (typeof (globalThis as unknown as Record<string, unknown>)['postMessage'] !== 'function') {
    (globalThis as unknown as Record<string, unknown>)['postMessage'] = vi.fn();
  }

  // window.location (fallback URL in some interceptor paths)
  if (!(globalThis as unknown as Record<string, unknown>)['location']) {
    (globalThis as unknown as Record<string, unknown>)['location'] = {
      href: 'https://test.local/',
    };
  }
}

beforeAll(async () => {
  installBrowserStubs();
  // Dynamic import so side-effect code runs AFTER stubs are in place.
  const mod = await import('./interceptor');
  matchesPattern = mod.matchesPattern;
  isActionAllowed = mod.isActionAllowed as typeof isActionAllowed;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function activeRule(overrides: Partial<TestRule> = {}): TestRule {
  return {
    isActive: true,
    expiresAt: null,
    actionRestrictions: [],
    sitePatterns: [],
    ...overrides,
  };
}

function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function pastIso(offsetMs = 60_000): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

// ── matchesPattern ────────────────────────────────────────────────────────────

describe('matchesPattern — hostname patterns (no ://)', () => {
  it('matches a single-level wildcard subdomain', () => {
    expect(matchesPattern('https://sub.example.com/page', '*.example.com')).toBe(true);
  });

  it('does not match the apex domain with a single-level wildcard', () => {
    // *.example.com should require at least one subdomain label
    expect(matchesPattern('https://example.com', '*.example.com')).toBe(false);
  });

  it('does not match a sibling domain with a single-level wildcard', () => {
    expect(matchesPattern('https://other.com', '*.example.com')).toBe(false);
  });

  it('single-level wildcard does not match across dots', () => {
    // deep.sub.example.com — * does not match "deep.sub"
    expect(matchesPattern('https://deep.sub.example.com', '*.example.com')).toBe(false);
  });

  it('double-star pattern matches multiple subdomain levels', () => {
    expect(matchesPattern('https://deep.sub.example.com', '**.example.com')).toBe(true);
  });

  it('double-star pattern matches a single subdomain level', () => {
    expect(matchesPattern('https://sub.example.com', '**.example.com')).toBe(true);
  });

  it('exact hostname matches its own URL', () => {
    expect(matchesPattern('https://example.com/path?q=1', 'example.com')).toBe(true);
  });

  it('exact hostname does not match a subdomain', () => {
    expect(matchesPattern('https://sub.example.com', 'example.com')).toBe(false);
  });

  it('exact hostname does not match a different domain', () => {
    expect(matchesPattern('https://notexample.com', 'example.com')).toBe(false);
  });

  it('returns false for an invalid URL without throwing', () => {
    expect(() => matchesPattern('not-a-url', '*.example.com')).not.toThrow();
    expect(matchesPattern('not-a-url', '*.example.com')).toBe(false);
  });

  it('returns false for an empty pattern', () => {
    expect(matchesPattern('https://example.com', '')).toBe(false);
  });
});

/**
 * NOTE on full URL pattern matching:
 * The full URL branch escapes regex metacharacters via a character class that
 * does NOT include `*`, then converts `\*` (escaped star) to `.*`.  Because
 * `*` is never escaped in step 1, step 2 never fires and `*` remains as the
 * regex quantifier "zero or more of the preceding character", not a glob.
 *
 * Concretely `https://example.com/*` becomes the regex
 * `^https://example\.com/*$` where `/*` means "zero or more forward slashes",
 * matching only `https://example.com` or `https://example.com/`.
 *
 * The tests below document this actual runtime behaviour.
 */
describe('matchesPattern — full URL patterns (contain ://)', () => {
  it('matches the base URL when the pattern ends with /* (zero slashes)', () => {
    // /* in regex = zero or more '/' → base URL without trailing slash matches
    expect(matchesPattern('https://example.com', 'https://example.com/*')).toBe(true);
  });

  it('matches the base URL with a single trailing slash', () => {
    expect(matchesPattern('https://example.com/', 'https://example.com/*')).toBe(true);
  });

  it('does not match a path with non-slash characters after the domain (implementation limitation)', () => {
    // /* does not act as a glob — /foo/bar does not satisfy the quantifier
    expect(matchesPattern('https://example.com/foo/bar', 'https://example.com/*')).toBe(false);
  });

  it('does not match a different scheme', () => {
    expect(matchesPattern('http://example.com/', 'https://example.com/*')).toBe(false);
  });

  it('does not match a different host in a full URL pattern', () => {
    expect(matchesPattern('https://other.com/', 'https://example.com/*')).toBe(false);
  });

  it('exact full URL pattern matches itself', () => {
    expect(matchesPattern('https://example.com/path', 'https://example.com/path')).toBe(true);
  });

  it('exact full URL pattern does not match a different path', () => {
    expect(matchesPattern('https://example.com/other', 'https://example.com/path')).toBe(false);
  });

  it('returns false for invalid URL string with full URL pattern without throwing', () => {
    expect(() => matchesPattern('not-a-url', 'https://example.com/*')).not.toThrow();
    expect(matchesPattern('not-a-url', 'https://example.com/*')).toBe(false);
  });
});

// ── isActionAllowed ───────────────────────────────────────────────────────────

describe('isActionAllowed — null / inactive rule (pass-through)', () => {
  it('allows when rule is null (pass-through for normal browsing)', () => {
    const { allowed, reason } = isActionAllowed('navigate', 'https://example.com', null);
    expect(allowed).toBe(true);
    expect(reason).toContain('pass-through');
  });

  it('allows when rule.isActive is false (pass-through)', () => {
    const rule = activeRule({ isActive: false });
    const { allowed } = isActionAllowed('navigate', 'https://example.com', rule);
    expect(allowed).toBe(true);
  });

  it('includes a descriptive reason when rule is inactive', () => {
    const rule = activeRule({ isActive: false });
    const { reason } = isActionAllowed('navigate', 'https://example.com', rule);
    expect(reason).toContain('pass-through');
  });
});

describe('isActionAllowed — expired rule', () => {
  it('blocks when expiresAt is in the past', () => {
    const rule = activeRule({ expiresAt: pastIso() });
    const { allowed, reason } = isActionAllowed('navigate', 'https://example.com', rule);
    expect(allowed).toBe(false);
    expect(reason).toContain('expired');
  });

  it('allows when expiresAt is in the future', () => {
    const rule = activeRule({
      expiresAt: futureIso(),
      actionRestrictions: [{ capability: 'navigate', action: 'allow' }],
    });
    const { allowed } = isActionAllowed('navigate', 'https://example.com', rule);
    expect(allowed).toBe(true);
  });

  it('allows when expiresAt is null (no expiry)', () => {
    const rule = activeRule({
      expiresAt: null,
      actionRestrictions: [{ capability: 'navigate', action: 'allow' }],
    });
    const { allowed } = isActionAllowed('navigate', 'https://example.com', rule);
    expect(allowed).toBe(true);
  });
});

describe('isActionAllowed — capability restriction checks', () => {
  it('blocks a capability explicitly set to block', () => {
    const rule = activeRule({
      actionRestrictions: [{ capability: 'submit-form', action: 'block' }],
    });
    const { allowed, reason } = isActionAllowed('submit-form', 'https://example.com', rule);
    expect(allowed).toBe(false);
    expect(reason).toContain('submit-form');
  });

  it('allows a capability explicitly set to allow', () => {
    const rule = activeRule({
      actionRestrictions: [{ capability: 'submit-form', action: 'allow' }],
    });
    const { allowed } = isActionAllowed('submit-form', 'https://example.com', rule);
    expect(allowed).toBe(true);
  });

  it('blocks when capability is missing from actionRestrictions (fail-closed, no default-allow)', () => {
    // The interceptor requires an explicit 'allow' entry — absence means blocked.
    const rule = activeRule({ actionRestrictions: [] });
    const { allowed } = isActionAllowed('open-tab', 'https://example.com', rule);
    expect(allowed).toBe(false);
  });

  it('allows the matching capability when multiple restrictions are listed', () => {
    const rule = activeRule({
      actionRestrictions: [
        { capability: 'navigate', action: 'allow' },
        { capability: 'submit-form', action: 'block' },
      ],
    });
    expect(isActionAllowed('navigate', 'https://example.com', rule).allowed).toBe(true);
    expect(isActionAllowed('submit-form', 'https://example.com', rule).allowed).toBe(false);
  });

  it('reason mentions allowed by delegation when capability is allowed', () => {
    const rule = activeRule({
      actionRestrictions: [{ capability: 'navigate', action: 'allow' }],
    });
    const { reason } = isActionAllowed('navigate', 'https://example.com', rule);
    expect(reason.toLowerCase()).toContain('allow');
  });
});

describe('isActionAllowed — site pattern checks', () => {
  it('blocks when a block pattern matches the URL', () => {
    const rule = activeRule({
      actionRestrictions: [{ capability: 'navigate', action: 'allow' }],
      sitePatterns: [{ pattern: '*.bank.com', action: 'block' }],
    });
    const { allowed, reason } = isActionAllowed(
      'navigate',
      'https://secure.bank.com/login',
      rule
    );
    expect(allowed).toBe(false);
    expect(reason).toContain('*.bank.com');
  });

  it('does not block when the block pattern does not match the URL', () => {
    const rule = activeRule({
      actionRestrictions: [{ capability: 'navigate', action: 'allow' }],
      sitePatterns: [{ pattern: '*.bank.com', action: 'block' }],
    });
    const { allowed } = isActionAllowed('navigate', 'https://example.com', rule);
    expect(allowed).toBe(true);
  });

  it('an allow site pattern does not block navigation', () => {
    // An 'allow' pattern entry does not itself block anything — it is permissive.
    const rule = activeRule({
      actionRestrictions: [{ capability: 'navigate', action: 'allow' }],
      sitePatterns: [{ pattern: '*.example.com', action: 'allow' }],
    });
    const { allowed } = isActionAllowed('navigate', 'https://sub.example.com', rule);
    expect(allowed).toBe(true);
  });

  it('blocked site pattern takes precedence even when capability is allowed', () => {
    const rule = activeRule({
      actionRestrictions: [{ capability: 'navigate', action: 'allow' }],
      sitePatterns: [{ pattern: 'secure.bank.com', action: 'block' }],
    });
    // Exact hostname match
    const { allowed } = isActionAllowed(
      'navigate',
      'https://secure.bank.com/dashboard',
      rule
    );
    expect(allowed).toBe(false);
  });

  it('does not block when site pattern action is allow and URL matches', () => {
    // A matching 'allow' pattern should not interfere — the capability check governs.
    const rule = activeRule({
      actionRestrictions: [{ capability: 'submit-form', action: 'block' }],
      sitePatterns: [{ pattern: 'example.com', action: 'allow' }],
    });
    const { allowed } = isActionAllowed('submit-form', 'https://example.com', rule);
    // Capability is block, site pattern is allow — capability block wins.
    expect(allowed).toBe(false);
  });

  it('block pattern for a non-matching host leaves other decisions untouched', () => {
    const rule = activeRule({
      actionRestrictions: [{ capability: 'open-tab', action: 'allow' }],
      sitePatterns: [{ pattern: '*.blocked.com', action: 'block' }],
    });
    // URL does not match the blocked pattern
    const { allowed } = isActionAllowed('open-tab', 'https://safe.example.com', rule);
    expect(allowed).toBe(true);
  });
});
