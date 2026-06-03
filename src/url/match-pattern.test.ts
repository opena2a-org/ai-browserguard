import { describe, it, expect } from 'vitest';
import { matchUrlPattern } from './match-pattern';

describe('matchUrlPattern — hostname patterns (no ://)', () => {
  it('single * matches within one label, not across dots', () => {
    expect(matchUrlPattern('https://sub.example.com/page', '*.example.com')).toBe(true);
    expect(matchUrlPattern('https://deep.sub.example.com', '*.example.com')).toBe(false);
  });

  it('** matches across labels', () => {
    expect(matchUrlPattern('https://deep.sub.example.com', '**.example.com')).toBe(true);
    expect(matchUrlPattern('https://sub.example.com', '**.example.com')).toBe(true);
    // apex: **. requires at least one leading label
    expect(matchUrlPattern('https://example.com', '**.example.com')).toBe(false);
  });

  it('matches the apex exactly', () => {
    expect(matchUrlPattern('https://example.com/path', 'example.com')).toBe(true);
    expect(matchUrlPattern('https://sub.example.com', 'example.com')).toBe(false);
    expect(matchUrlPattern('https://notexample.com', 'example.com')).toBe(false);
  });

  it('returns false for an unparseable URL instead of throwing', () => {
    expect(() => matchUrlPattern('not-a-url', '*.example.com')).not.toThrow();
    expect(matchUrlPattern('not-a-url', '*.example.com')).toBe(false);
  });
});

describe('matchUrlPattern — full URL patterns (contain ://)', () => {
  it('matches a path wildcard at any depth', () => {
    expect(matchUrlPattern('https://example.com/foo', 'https://example.com/*')).toBe(true);
    expect(matchUrlPattern('https://example.com/foo/bar', 'https://example.com/*')).toBe(true);
    expect(matchUrlPattern('http://example.com/', 'https://example.com/*')).toBe(false);
  });

  it('matches an interior wildcard between literal segments', () => {
    expect(matchUrlPattern('https://example.com/a/b/c', 'https://example.com/*/c')).toBe(true);
    expect(matchUrlPattern('https://example.com/a/b/d', 'https://example.com/*/c')).toBe(false);
  });

  it('matches an exact pattern with no wildcard', () => {
    expect(matchUrlPattern('https://example.com/path', 'https://example.com/path')).toBe(true);
    expect(matchUrlPattern('https://example.com/other', 'https://example.com/path')).toBe(false);
  });

  it('treats a literal ? in the pattern literally, not as a regex quantifier', () => {
    // A regex `?` would make the preceding char optional, silently widening scope.
    expect(matchUrlPattern('https://example.com/a?b=1', 'https://example.com/a?b=1')).toBe(true);
    expect(matchUrlPattern('https://example.com/ab=1', 'https://example.com/a?b=1')).toBe(false);
  });
});

describe('matchUrlPattern — no domain confusion in full-URL patterns', () => {
  it('does not let a host pattern match the path of a different origin', () => {
    // `*` in the host part must not span the origin boundary into the path.
    expect(matchUrlPattern('https://evil.com/.trusted.com/', 'https://*.trusted.com/*')).toBe(false);
    expect(matchUrlPattern('https://evil.com/?x=.trusted.com/', 'https://*.trusted.com/*')).toBe(false);
  });

  it('matches the browser-normalized URL, defeating backslash/userinfo origin confusion', () => {
    // The parser folds `\` to `/`, so the effective host of each of these is
    // evil.com — they must NOT match a `*.trusted.com` allow pattern.
    expect(matchUrlPattern('https://evil.com\\.trusted.com/', 'https://*.trusted.com/*')).toBe(false);
    expect(matchUrlPattern('https://evil.com\\foo.trusted.com/', 'https://*.trusted.com/*')).toBe(false);
    expect(matchUrlPattern('https://x@evil.com/.trusted.com/', 'https://*.trusted.com/*')).toBe(false);
  });

  it('strips a trailing FQDN dot so it cannot evade a dot-less block/allow pattern', () => {
    // hostname branch
    expect(matchUrlPattern('https://evil.com./login', 'evil.com')).toBe(true);
    expect(matchUrlPattern('https://sub.trusted.com./x', '*.trusted.com')).toBe(true);
    // full-URL branch
    expect(matchUrlPattern('https://evil.com./login', 'https://evil.com/*')).toBe(true);
  });

  it('still matches a legitimate subdomain + path', () => {
    expect(matchUrlPattern('https://sub.trusted.com/foo', 'https://*.trusted.com/*')).toBe(true);
    expect(matchUrlPattern('https://a.b.trusted.com/x/y', 'https://*.trusted.com/*')).toBe(true);
  });
});

describe('matchUrlPattern — regex injection is neutralized', () => {
  it('treats regex metacharacters in a hostname pattern as literals', () => {
    // An allow pattern must not widen via alternation / char-class, and a block
    // pattern must not shrink via an optional-char quantifier.
    expect(matchUrlPattern('https://evil.com', '(evil|trusted).com')).toBe(false);
    expect(matchUrlPattern('https://xexample.com', '[a-z]example.com')).toBe(false);
    expect(matchUrlPattern('https://ab.com', 'ab?.com')).toBe(false); // `?` literal in hostname branch too
  });

  it('treats regex metacharacters in a full-URL pattern as literals', () => {
    expect(matchUrlPattern('https://example.com/(a|b)', 'https://example.com/(a|b)')).toBe(true);
    expect(matchUrlPattern('https://example.com/a', 'https://example.com/(a|b)')).toBe(false);
  });

  it('strips a NUL in the pattern so it cannot act as the cross-label sentinel', () => {
    // After stripping, the pattern is just `*.example.com` — a legitimate match.
    expect(matchUrlPattern('https://x.example.com', '*\x00.example.com')).toBe(true);
  });
});

describe('matchUrlPattern — ReDoS resistance', () => {
  it('stays linear on alternating-wildcard patterns against a huge URL', () => {
    // `*a*a*a…` survives any consecutive-run collapse and is the classic
    // catastrophic-backtracking shape. The full-URL branch matches with ordered
    // substring search (no regex), so this must return quickly, not hang.
    const evil = 'https://' + 'a'.repeat(200_000) + '!';
    const pattern = 'https://' + '*a'.repeat(40);
    const start = performance.now();
    const result = matchUrlPattern(evil, pattern);
    const elapsedMs = performance.now() - start;
    expect(result).toBe(false);
    expect(elapsedMs).toBeLessThan(500);
  });

  it('stays linear on a 1000-star pattern and keeps match semantics', () => {
    const start = performance.now();
    expect(matchUrlPattern('https://example.com/anything/here', 'https://example.com/' + '*'.repeat(1000))).toBe(true);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('rejects an absurdly-wildcarded hostname pattern instead of evaluating it', () => {
    // `**.**.**.example.com` etc. — beyond the cap, the hostname regex is not
    // compiled (returns false) rather than risking pathological matching.
    expect(matchUrlPattern('https://a.b.c.d.example.com', '**.**.**.**.**.example.com')).toBe(false);
  });

  it('stays linear on a multi-kB crafted hostname with adjacent wildcards', () => {
    // The URL parser does not enforce the 253-char DNS limit, so a long single
    // label with `*a**z` (only 3 stars, under the count cap) could drive
    // `[^.]*a.*z` backtracking. The length cap must keep this fast.
    const evil = 'http://' + 'a'.repeat(60_000) + '/';
    const start = performance.now();
    const result = matchUrlPattern(evil, '*a**z');
    const elapsedMs = performance.now() - start;
    expect(result).toBe(false);
    expect(elapsedMs).toBeLessThan(100);
  });
});
