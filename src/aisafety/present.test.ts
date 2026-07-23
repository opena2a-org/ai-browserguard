import { describe, it, expect } from 'vitest';
import { presentDeclaration } from './present';
import type { DeclarationView } from './present';

function rowsOf(view: DeclarationView): Array<{ label: string; value: string }> {
  if (view.state !== 'declared') throw new Error(`expected declared, got ${view.state}`);
  return view.rows.map(({ label, value }) => ({ label, value }));
}

describe('a published declaration', () => {
  it('renders every present field, in draft order', () => {
    const view = presentDeclaration({
      status: 'ok',
      declaration: {
        aiSafe: true,
        injectionProtected: true,
        consistentRendering: true,
        contact: 'mailto:security@example.com',
        attestation: 'https://registry.example.org/verify/example.com',
        lastVerified: '2026-07-01',
      },
    });

    expect(rowsOf(view)).toEqual([
      { label: 'Site-authored content', value: 'Claimed' },
      { label: 'Injection-hardened', value: 'Claimed' },
      { label: 'Consistent rendering', value: 'Claimed' },
      { label: 'Contact', value: 'mailto:security@example.com' },
      { label: 'Attestation', value: 'https://registry.example.org/verify/example.com' },
      { label: 'Last verified', value: '2026-07-01' },
    ]);
  });

  it('always carries the self-asserted caveat', () => {
    const view = presentDeclaration({ status: 'ok', declaration: { aiSafe: true } });
    if (view.state !== 'declared') throw new Error('expected declared');
    // Draft section 5.1: a declaration MUST NOT be treated as proof. The caveat
    // is the only thing on screen that says so.
    expect(view.caveat).toContain('Self-asserted');
    expect(view.caveat).toContain('not verified');
  });

  it('gives every row a plain-language hint', () => {
    const view = presentDeclaration({
      status: 'ok',
      declaration: {
        aiSafe: true,
        injectionProtected: false,
        consistentRendering: true,
        contact: 'mailto:a@b.com',
        attestation: 'https://x.example/v',
        lastVerified: '2026-07-01',
      },
    });
    if (view.state !== 'declared') throw new Error('expected declared');
    for (const row of view.rows) {
      expect(row.hint.length).toBeGreaterThan(20);
    }
  });
});

describe('claimed vs not claimed vs absent', () => {
  it('renders an explicit false as "Not claimed", not as a failure', () => {
    const view = presentDeclaration({
      status: 'ok',
      declaration: { aiSafe: true, injectionProtected: false },
    });
    expect(rowsOf(view)).toEqual([
      { label: 'Site-authored content', value: 'Claimed' },
      { label: 'Injection-hardened', value: 'Not claimed' },
    ]);
  });

  it('omits absent fields entirely rather than showing them as "Not claimed"', () => {
    // "The site said nothing" and "the site declined the claim" are different
    // statements. Absence gets no row, so the two stay distinguishable.
    const view = presentDeclaration({ status: 'ok', declaration: { aiSafe: true } });
    expect(rowsOf(view)).toEqual([{ label: 'Site-authored content', value: 'Claimed' }]);
  });

  it('never describes a site as safe or unsafe', () => {
    const view = presentDeclaration({
      status: 'ok',
      declaration: { aiSafe: false, injectionProtected: false, consistentRendering: false },
    });
    if (view.state !== 'declared') throw new Error('expected declared');
    const text = [...view.rows.map((r) => `${r.label} ${r.value}`), view.caveat].join(' ').toLowerCase();
    // A site declining every claim is not thereby dangerous, and we have
    // verified nothing either way.
    expect(text).not.toMatch(/\bunsafe\b|\bdangerous\b|\brisk\b|\bwarning\b|\bfail/);
  });
});

describe('the hostile case', () => {
  it('presents an over-claiming site as claims, never as findings', () => {
    // A malicious site can assert everything at zero cost. The UI must read as
    // "this site says X", never "X is true".
    const view = presentDeclaration({
      status: 'ok',
      declaration: { aiSafe: true, injectionProtected: true, consistentRendering: true },
    });
    if (view.state !== 'declared') throw new Error('expected declared');
    expect(view.rows.every((r) => r.value === 'Claimed')).toBe(true);
    expect(view.caveat).toContain('Any site can publish any claim');
  });
});

describe('no declaration', () => {
  it('reports none published without implying anything about the site', () => {
    const view = presentDeclaration({ status: 'none' });
    expect(view).toEqual({ state: 'none', note: 'No declaration published' });
  });

  it('treats an empty declaration as none rather than a caveat-only block', () => {
    const view = presentDeclaration({ status: 'ok', declaration: {} });
    expect(view.state).toBe('none');
  });
});

describe('unchecked', () => {
  it('distinguishes "could not check" from "there is none"', () => {
    // Reporting `unreachable` as "no declaration published" would assert
    // something we do not know. This is the AIM `unregistered` lesson: no
    // signal is not a negative signal.
    const view = presentDeclaration({ status: 'unreachable' });
    expect(view).toEqual({ state: 'unchecked', note: 'Could not check this site' });
    expect(view.state).not.toBe('none');
  });
});

describe('the live opena2a.org declaration', () => {
  it('presents the real published file', () => {
    const view = presentDeclaration({
      status: 'ok',
      declaration: {
        aiSafe: true,
        injectionProtected: false,
        consistentRendering: true,
        contact: 'mailto:info@opena2a.org',
        lastVerified: '2026-07-16',
      },
    });

    // The interesting case in the wild: a site that claims site-authored content
    // AND declines the injection-hardened claim, because it publishes payloads
    // as research. That combination is honest, and must not read as a problem.
    expect(rowsOf(view)).toEqual([
      { label: 'Site-authored content', value: 'Claimed' },
      { label: 'Injection-hardened', value: 'Not claimed' },
      { label: 'Consistent rendering', value: 'Claimed' },
      { label: 'Contact', value: 'mailto:info@opena2a.org' },
      { label: 'Last verified', value: '2026-07-16' },
    ]);
  });

  it('shows no Attestation row, since the file omits it', () => {
    const view = presentDeclaration({
      status: 'ok',
      declaration: { aiSafe: true, contact: 'mailto:info@opena2a.org' },
    });
    if (view.state !== 'declared') throw new Error('expected declared');
    expect(view.rows.some((r) => r.label === 'Attestation')).toBe(false);
  });
});
