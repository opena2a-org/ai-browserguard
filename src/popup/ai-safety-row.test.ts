/**
 * The declaration row must never truncate a site-supplied value.
 *
 * These values come from a hostile origin, and for a URL the END is the part
 * that decides where it points. Eliding the end is a spoof primitive:
 *
 *     Contact: https://google.com.<150 chars of padding>.evil.com/
 *
 * renders under `text-overflow: ellipsis` as `https://google.com.aaaa…` — reads
 * as Google, resolves to evil.com. No parser rule closes this class: rejecting
 * embedded credentials kills `https://google.com@evil.com`, but padding a
 * subdomain needs no credentials. Only not-truncating closes it.
 *
 * This is a source-level lock-in, matching popup.dom.test.ts's approach — this
 * repo has no jsdom in its test env, and the rendering logic itself lives in the
 * pure, fully-tested aisafety/present.ts. What is worth pinning here is the one
 * CSS property whose loss would silently restore the spoof, and which nothing
 * else would catch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const source = readFileSync(resolve(__dirname, 'ai-safety-row.ts'), 'utf-8');

/** Strip comments so the prose explaining the rule does not trip the rule. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('site-supplied values are never truncated', () => {
  it('does not use text-overflow: ellipsis', () => {
    expect(code).not.toMatch(/text-overflow\s*:\s*ellipsis/);
  });

  it('does not use white-space: nowrap', () => {
    // nowrap without ellipsis still clips or overflows; either way the end of a
    // hostile URL stops being visible.
    expect(code).not.toMatch(/white-space\s*:\s*nowrap/);
  });

  it('wraps long values instead, so the whole value stays on screen', () => {
    expect(code).toMatch(/word-break\s*:\s*break-all/);
    expect(code).toMatch(/white-space\s*:\s*normal/);
  });
});

describe('values reach the DOM as text, never as markup', () => {
  it('assigns every site-supplied value with textContent', () => {
    expect(code).toMatch(/value\.textContent\s*=\s*row\.value/);
  });

  it('uses no HTML-parsing sink', () => {
    // Also enforced across the whole directory by popup.dom.test.ts; asserted
    // here too because this is the file that handles hostile input.
    expect(code).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML|setHTMLUnsafe)\b/);
  });

  it('never renders a site-supplied value as a link', () => {
    // Display-only (ADR-009 section 4). An href a hostile site controls is not
    // something this feature needs, and the parser's scheme allowlist is a
    // second line of defence rather than the only one.
    expect(code).not.toMatch(/createElement\(\s*['"]a['"]\s*\)/);
    expect(code).not.toMatch(/\.href\s*=/);
  });
});
