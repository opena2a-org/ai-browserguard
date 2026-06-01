/**
 * P1-1 lock-in: enforce that popup.ts never re-introduces `innerHTML`.
 *
 * The popup renders user-controllable data (URLs, agent labels, settings
 * the user types). A regression that switches a `textContent` write back
 * to `innerHTML` would re-open XSS in the popup. We lock the no-innerHTML
 * rule in at test time because this repo's "lint" step is `tsc --noEmit
 * --strict`, not ESLint, so there's no native config to host the rule.
 *
 * The match is intentionally strict (the literal `innerHTML` token, in
 * any form): assignment, getter read, comparison, and any future
 * dynamic-string variant all trip it. The popup has no legitimate need
 * to touch `innerHTML` — `replaceChildren()`, `textContent`, and
 * `createElement` cover every use case observed in the audit.
 *
 * The companion jsdom-driven render assertion is intentionally
 * out-of-scope here: popup.ts is a side-effect module with no exports,
 * and wrapping the full init lifecycle just to load a single render
 * function would add more surface than it locks in. The grep-style
 * assertion below is the load-bearing guarantee; manual XSS testing
 * remains the secondary check.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('popup.ts innerHTML purge (P1-1 lock-in)', () => {
  const source = readFileSync(
    resolve(__dirname, 'popup.ts'),
    'utf-8'
  );

  it('contains no `innerHTML` assignments, reads, or comparisons', () => {
    const lines = source.split('\n');
    const offenders: { line: number; text: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip comments that mention innerHTML for context (none today,
      // but allow them in future without tripping the test).
      const stripped = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/\binnerHTML\b/.test(stripped)) {
        offenders.push({ line: i + 1, text: line.trim() });
      }
    }
    expect(
      offenders,
      `popup.ts must use textContent / createElement / replaceChildren — not innerHTML.\nOffenders:\n${offenders.map((o) => `  ${o.line}: ${o.text}`).join('\n')}`
    ).toEqual([]);
  });

  it('uses replaceChildren() for container clearing (sanity check)', () => {
    // Sanity: confirm the migration target is actually present, so a
    // future "rewrite popup.ts" PR that accidentally removes both
    // doesn't pass this lock-in.
    expect(source).toContain('.replaceChildren()');
  });
});
