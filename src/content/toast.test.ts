/**
 * Toast helper tests.
 *
 * Focused on `safeDisplayDomain`, which guards the toast's whitelist
 * button copy against punycode / mixed-script homograph attacks.
 * The button shows "Whitelist <domain>" — if the domain came from
 * an attacker-controlled URL with an IDN homograph, the user could
 * be tricked into whitelisting the wrong site. The "(unverified)"
 * suffix is the load-bearing signal that the user should double-check.
 */
import { describe, it, expect } from 'vitest';
import { safeDisplayDomain } from './toast';

describe('safeDisplayDomain', () => {
  it('returns plain Latin domains unchanged', () => {
    expect(safeDisplayDomain('example.com')).toBe('example.com');
    expect(safeDisplayDomain('foo.bar.example.com')).toBe('foo.bar.example.com');
    expect(safeDisplayDomain('localhost')).toBe('localhost');
  });

  it('marks punycode (xn--) labels as unverified', () => {
    // xn--80ak6aa92e.com renders as "аррӏе.com" in modern browsers.
    expect(safeDisplayDomain('xn--80ak6aa92e.com')).toBe('xn--80ak6aa92e.com (unverified)');
    expect(safeDisplayDomain('mail.xn--rk6c.com')).toBe('mail.xn--rk6c.com (unverified)');
  });

  // Fixtures built from Unicode code points to keep this source file
  // ASCII-only. A literal Cyrillic char here would trip homograph
  // scanners on the test file itself.
  // U+0430 = Cyrillic small a, U+0440 = Cyrillic small er (looks like p).
  // U+043F = Cyrillic small pe (looks like n in some fonts).
  // U+0444 = Cyrillic small ef (looks like f).
  const CY_A = String.fromCodePoint(0x0430);
  const CY_ER = String.fromCodePoint(0x0440);
  const CY_PE = String.fromCodePoint(0x043F);
  const CY_EF = String.fromCodePoint(0x0444);

  it('marks mixed-script (Latin + Cyrillic) labels as unverified', () => {
    // "a" + Cyrillic-er + "ple.com" — Latin + Cyrillic in one label.
    const mixed = `a${CY_ER}ple.com`;
    expect(safeDisplayDomain(mixed)).toBe(`${mixed} (unverified)`);
  });

  it('does not mark a pure-Cyrillic label as unverified', () => {
    // A fully non-Latin label is not a homograph attack. The mixed-script
    // check requires Latin AND non-Latin in the same label.
    const pureCyrillic = `${CY_PE}${CY_ER}${CY_A}.${CY_ER}${CY_EF}`;
    expect(safeDisplayDomain(pureCyrillic)).toBe(pureCyrillic);
  });

  it('returns empty / undefined input unchanged', () => {
    expect(safeDisplayDomain('')).toBe('');
  });

  it('marks mixed script even across labels in different positions', () => {
    const mixed = `foo.a${CY_ER}ple.com`;
    expect(safeDisplayDomain(mixed)).toBe(`${mixed} (unverified)`);
  });
});
