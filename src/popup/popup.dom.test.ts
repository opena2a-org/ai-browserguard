/**
 * P1-1 lock-in: enforce that popup.ts never re-introduces an HTML-injection sink.
 *
 * The popup renders user-controllable data (URLs, agent labels, settings
 * the user types). A regression that switches a `textContent` write back
 * to `innerHTML` (or any sibling sink that parses HTML strings) would re-
 * open XSS in the popup. We lock the no-sink rule in at test time because
 * this repo's "lint" step is `tsc --noEmit --strict`, not ESLint, so
 * there's no native config to host the rule.
 *
 * The banned-token list covers the full DOM-injection sink family the
 * popup might plausibly reach for, not just `innerHTML`:
 *
 *   - innerHTML        — assignment parses HTML
 *   - outerHTML        — same, replaces the element itself
 *   - insertAdjacentHTML — same, at a relative position
 *   - setHTMLUnsafe    — the explicit-opt-in raw-HTML sink (Trusted Types era)
 *   - document.write   — legacy HTML parser entry point
 *
 * The match runs after comment-stripping so future "// don't use innerHTML"
 * documentation does not trip it. The popup has no legitimate need to
 * touch any of these — `replaceChildren()`, `textContent`, and
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

const BANNED_SINK_PATTERN = /\b(innerHTML|outerHTML|insertAdjacentHTML|setHTMLUnsafe)\b|\bdocument\.write\b/;

describe('popup.ts HTML-injection sink lock-in (P1-1)', () => {
  const source = readFileSync(
    resolve(__dirname, 'popup.ts'),
    'utf-8'
  );

  it('contains no innerHTML / outerHTML / insertAdjacentHTML / setHTMLUnsafe / document.write', () => {
    const lines = source.split('\n');
    const offenders: { line: number; text: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const stripped = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (BANNED_SINK_PATTERN.test(stripped)) {
        offenders.push({ line: i + 1, text: line.trim() });
      }
    }
    expect(
      offenders,
      `popup.ts must use textContent / createElement / replaceChildren — not innerHTML, outerHTML, insertAdjacentHTML, setHTMLUnsafe, or document.write.\nOffenders:\n${offenders.map((o) => `  ${o.line}: ${o.text}`).join('\n')}`
    ).toEqual([]);
  });

  it('uses replaceChildren() for container clearing (sanity check)', () => {
    // Sanity: confirm the migration target is actually present, so a
    // future "rewrite popup.ts" PR that accidentally removes both
    // doesn't pass this lock-in.
    expect(source).toContain('.replaceChildren()');
  });
});

/**
 * The same no-sink rule for the content-script toast. The toast injects DOM
 * into pages the extension does not control, so an innerHTML regression here is
 * strictly worse than in the popup. The shield icon is built via
 * createElementNS, never an HTML string.
 */
describe('toast.ts HTML-injection sink lock-in', () => {
  const source = readFileSync(resolve(__dirname, '../content/toast.ts'), 'utf-8');

  it('contains no innerHTML / outerHTML / insertAdjacentHTML / setHTMLUnsafe / document.write', () => {
    const lines = source.split('\n');
    const offenders: { line: number; text: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (BANNED_SINK_PATTERN.test(stripped)) {
        offenders.push({ line: i + 1, text: lines[i].trim() });
      }
    }
    expect(
      offenders,
      `toast.ts must build DOM via createElement / createElementNS / textContent — not HTML-string sinks.\nOffenders:\n${offenders.map((o) => `  ${o.line}: ${o.text}`).join('\n')}`
    ).toEqual([]);
  });

  it('builds the shield icon via createElementNS (not an HTML string)', () => {
    expect(source).toContain("createElementNS");
  });
});
