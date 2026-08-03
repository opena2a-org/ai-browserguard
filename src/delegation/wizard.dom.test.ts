/**
 * @vitest-environment jsdom
 *
 * Wizard render coverage for the piece pure-logic tests cannot see: the DOM
 * the user actually operates. The load-bearing case is block-pattern
 * authoring — `addSitePattern` always accepted `action: 'block'`, but the
 * sites-step UI hardcoded `action: 'allow'`, so no rule a real user could
 * author ever carried a block pattern and the CDP enforcement layer
 * (ruleHasBlockPattern gate) could never arm. These tests pin the UI path,
 * not the pure function.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  createInitialWizardState,
  selectPreset,
  renderWizard,
  normalizeBlockPattern,
  type WizardState,
} from './wizard';
import { matchUrlPattern } from '../url/match-pattern';

/** Render the wizard into a fresh container, tracking state transitions. */
function mount(state: WizardState): {
  container: HTMLElement;
  latest: () => WizardState;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let current = state;
  const onStateChange = (next: WizardState): void => {
    current = next;
    renderWizard(container, next, onStateChange);
  };
  renderWizard(container, current, onStateChange);
  return { container, latest: () => current };
}

function sitesStepState(): WizardState {
  return selectPreset(createInitialWizardState(), 'limited');
}

function addPattern(container: HTMLElement, pattern: string, action: 'allow' | 'block'): void {
  const input = container.querySelector<HTMLInputElement>('input.form-input');
  const select = container.querySelector<HTMLSelectElement>('#wizard-site-action');
  const addBtn = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === 'Add',
  );
  expect(input, 'sites step must render a pattern input').toBeTruthy();
  expect(select, 'sites step must render an Allow/Block selector').toBeTruthy();
  expect(addBtn, 'sites step must render an Add button').toBeTruthy();
  input!.value = pattern;
  select!.value = action;
  addBtn!.click();
}

describe('wizard sites step — block-pattern authoring (ADR-007 reachability)', () => {
  it('renders an Allow/Block selector defaulting to allow', () => {
    const { container } = mount(sitesStepState());
    const select = container.querySelector<HTMLSelectElement>('#wizard-site-action');
    expect(select).toBeTruthy();
    expect(select!.value).toBe('allow');
    expect(Array.from(select!.options).map((o) => o.value)).toEqual(['allow', 'block']);
  });

  it('adds a BLOCK pattern (plain host expands to apex + subdomains)', () => {
    const { container, latest } = mount(sitesStepState());
    addPattern(container, 'blocked.test', 'block');
    // A plain host must cover the apex AND every subdomain — a bare
    // `blocked.test` matches only the apex (match-pattern.ts), so the wizard
    // also stores `**.blocked.test`. Without this a user who blocks a domain
    // still leaks to www.<domain>, while the UI says it is blocked.
    expect(latest().sitePatterns).toEqual([
      { pattern: 'blocked.test', action: 'block' },
      { pattern: '**.blocked.test', action: 'block' },
    ]);
  });

  it('adds an ALLOW pattern by default (stored as typed)', () => {
    const { container, latest } = mount(sitesStepState());
    addPattern(container, 'allowed.test', 'allow');
    expect(latest().sitePatterns).toEqual([{ pattern: 'allowed.test', action: 'allow' }]);
  });

  it('lists each added pattern with its action', () => {
    const { container, latest } = mount(sitesStepState());
    addPattern(container, 'allowed.test', 'allow');
    addPattern(container, 'blocked.test', 'block');
    expect(latest().sitePatterns).toHaveLength(3); // allow + (apex block, subdomain block)
    const text = container.textContent ?? '';
    expect(text).toContain('allowed.test (allow)');
    expect(text).toContain('blocked.test (block)');
    expect(text).toContain('**.blocked.test (block)');
  });
});

describe('wizard confirm step', () => {
  it('shows the action for every pattern in the summary', () => {
    const { container, latest } = mount(sitesStepState());
    addPattern(container, 'allowed.test', 'allow');
    addPattern(container, 'blocked.test', 'block');
    // sites -> time
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Next')!.click();
    // time -> confirm (selecting a duration advances)
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '15 minutes')!.click();
    expect(latest().currentStep).toBe('confirm');
    const text = container.textContent ?? '';
    expect(text).toContain('allowed.test (allow)');
    expect(text).toContain('blocked.test (block)');
  });

  it('renders user-typed pattern text inertly (no HTML parsing)', () => {
    // Allow patterns are stored as typed (unlike blocks, which are normalized to
    // a host and would reject this), so this is the surface where hostile pattern
    // text reaches the confirm step and must render as inert text, not markup.
    const hostile = '<img src=x onerror="window.__pwned=1">';
    const { container } = mount(sitesStepState());
    addPattern(container, hostile, 'allow');
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Next')!.click();
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '15 minutes')!.click();
    // The literal text must be present as TEXT, and no img element may exist.
    expect(container.textContent).toContain(hostile);
    expect(container.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('block-pattern normalization (match-pattern.ts input-time contract)', () => {
  // A block pattern that the matcher cannot match is silently inert = fail-OPEN
  // for a block. match-pattern.ts requires input-time validation; these pin it.
  it('reduces a scheme+path URL to its host and covers subdomains', () => {
    expect(normalizeBlockPattern('https://evil.com')).toEqual({
      patterns: [
        { pattern: 'evil.com', action: 'block' },
        { pattern: '**.evil.com', action: 'block' },
      ],
    });
    expect(normalizeBlockPattern('https://evil.com/tracker/path')).toEqual({
      patterns: [
        { pattern: 'evil.com', action: 'block' },
        { pattern: '**.evil.com', action: 'block' },
      ],
    });
  });

  it('a plain host blocks the apex AND every subdomain', () => {
    expect(normalizeBlockPattern('evil.com')).toEqual({
      patterns: [
        { pattern: 'evil.com', action: 'block' },
        { pattern: '**.evil.com', action: 'block' },
      ],
    });
  });

  it('respects an explicit wildcard as typed', () => {
    expect(normalizeBlockPattern('*.evil.com')).toEqual({
      patterns: [{ pattern: '*.evil.com', action: 'block' }],
    });
  });

  it('canonicalizes case and trailing/leading dots (the matcher only lowercases the request host)', () => {
    // `Evil.Com`, `evil.com.`, `.evil.com` would all be stored verbatim and
    // never match the lowercased, dot-stripped request host = silent fail-open.
    for (const input of ['Evil.Com', 'EVIL.COM', 'evil.com.', '.evil.com', 'https://Evil.Com/x']) {
      expect(normalizeBlockPattern(input), input).toEqual({
        patterns: [
          { pattern: 'evil.com', action: 'block' },
          { pattern: '**.evil.com', action: 'block' },
        ],
      });
    }
  });

  it('rejects wildcards on the registrable tail (would block a public-suffix-wide swath)', () => {
    for (const input of ['*.com', '**.com', '**.*', '*.*.*.*', '**.co']) {
      expect(normalizeBlockPattern(input), input).toHaveProperty('error');
    }
  });

  it('parses a backslash authority the way the browser does (folds to path)', () => {
    // The browser's real host for `https://evil.com\@good.com` is evil.com
    // (`\` folds to `/`, so `\@good.com` is path). A `/`-only split would wrongly
    // yield good.com. Fold `\` too, so the intended host is what gets blocked.
    expect(normalizeBlockPattern('https://evil.com\\@good.com')).toEqual({
      patterns: [
        { pattern: 'evil.com', action: 'block' },
        { pattern: '**.evil.com', action: 'block' },
      ],
    });
  });

  it('rejects malformed labels that would be inert', () => {
    for (const input of ['a..b.com', '-evil.com', 'evil-.com', 'evil.com-', '.']) {
      expect(normalizeBlockPattern(input), input).toHaveProperty('error');
    }
  });

  it('rejects the inert and the over-broad with a plain-language reason', () => {
    expect(normalizeBlockPattern('')).toHaveProperty('error');
    expect(normalizeBlockPattern('   ')).toHaveProperty('error');
    expect(normalizeBlockPattern('*')).toHaveProperty('error');       // dot-less only
    expect(normalizeBlockPattern('**')).toHaveProperty('error');      // blocks the whole tab
    expect(normalizeBlockPattern('*.*.*.*.*.evil.com')).toHaveProperty('error'); // > cap, inert
    expect(normalizeBlockPattern('evil.com/path')).toHaveProperty('error'); // path, not a host
    expect(normalizeBlockPattern('evil.com:')).toHaveProperty('error');    // trailing colon, inert
    expect(normalizeBlockPattern('foo@evil.com')).toHaveProperty('error'); // stray userinfo, inert
  });

  it('strips a bare :port and blocks the host regardless of port', () => {
    expect(normalizeBlockPattern('evil.com:8080')).toEqual({
      patterns: [
        { pattern: 'evil.com', action: 'block' },
        { pattern: '**.evil.com', action: 'block' },
      ],
    });
  });

  // Round-trip against the REAL matcher: the whole point is that what the wizard
  // stores actually blocks the request. These fail on the pre-fix code, which
  // stored `https://evil.com` verbatim (matches no real request path).
  const blocksVia = (input: string, url: string): boolean => {
    const norm = normalizeBlockPattern(input);
    if ('error' in norm) return false;
    return norm.patterns.some((p) => matchUrlPattern(url, p.pattern));
  };

  it('the stored patterns actually block the request the user meant to block', () => {
    expect(blocksVia('https://evil.com', 'https://evil.com/steal')).toBe(true);   // was FALSE pre-fix
    expect(blocksVia('evil.com', 'https://evil.com/')).toBe(true);                 // apex
    expect(blocksVia('evil.com', 'https://www.evil.com/x')).toBe(true);            // subdomain
    expect(blocksVia('evil.com', 'https://a.b.evil.com/x')).toBe(true);            // deep subdomain
    expect(blocksVia('Evil.Com', 'https://evil.com/x')).toBe(true);                // mixed case (was FALSE pre-canon)
    expect(blocksVia('evil.com.', 'https://evil.com/x')).toBe(true);               // trailing dot (was FALSE pre-canon)
    expect(blocksVia('evil.com:8080', 'https://evil.com/x')).toBe(true);           // bare port
    // and it does NOT over-reach to an unrelated host
    expect(blocksVia('evil.com', 'https://notevil.com/x')).toBe(false);
    expect(blocksVia('evil.com', 'https://evilXcom.example/x')).toBe(false);
  });
});

describe('wizard HTML-injection sink lock-in (extends the popup P1-1 rule)', () => {
  it('wizard.ts contains no innerHTML / outerHTML / insertAdjacentHTML / setHTMLUnsafe / document.write', () => {
    const source = readFileSync(resolve(__dirname, 'wizard.ts'), 'utf-8');
    const lines = source.split('\n');
    const banned = /\b(innerHTML|outerHTML|insertAdjacentHTML|setHTMLUnsafe)\b|\bdocument\.write\b/;
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (banned.test(stripped)) offenders.push(`${i + 1}: ${lines[i].trim()}`);
    }
    expect(offenders, 'wizard.ts renders popup DOM and is held to the same no-sink rule').toEqual([]);
  });
});
