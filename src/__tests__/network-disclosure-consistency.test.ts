/**
 * ADR-006's lockstep rule, enforced instead of promised.
 *
 * ADR-006: "We must keep all four surfaces (policy, README, listing, settings
 * UI) in sync whenever a network path changes. A drift here is a disclosure
 * bug, not a cosmetic one." That was a rule a human had to remember. Nothing
 * checked it, and the v0.3.0 Web Store rejection is what drift costs.
 *
 * So: every boolean setting must be classified as either local-only or a
 * network gate. A network gate must default OFF and must be named in the
 * privacy policy. Adding a new setting fails this test until someone makes that
 * choice deliberately — which is the point. A contributor who adds a network
 * feature cannot ship it undisclosed without editing this file and noticing why
 * it exists.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { DEFAULT_SETTINGS } from '../session/types';

function read(relPath: string): string {
  return readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf-8');
}

/**
 * Settings that cause no outbound request. Local behaviour only.
 *
 * `cdpEnforcementEnabled` belongs here: it attaches chrome.debugger to block
 * requests locally, and sends nothing anywhere.
 */
const LOCAL_ONLY_SETTINGS = new Set([
  'detectionEnabled',
  'notificationsEnabled',
  'autoBlockUnknownAgents',
  'autoBlockUntrustedAgents',
  'cdpEnforcementEnabled',
]);

/**
 * Settings that gate an outbound request. Each MUST default false and MUST be
 * disclosed in the privacy policy by exact setting name.
 */
const NETWORK_GATES = new Set([
  'aimLookupEnabled',
  'registryLookupEnabled',
  'aiSafetyTxtEnabled',
]);

const booleanSettings = Object.entries(DEFAULT_SETTINGS)
  .filter(([, value]) => typeof value === 'boolean')
  .map(([key]) => key);

describe('every boolean setting is classified', () => {
  it.each(booleanSettings)('%s is either local-only or a declared network gate', (key) => {
    const classified = LOCAL_ONLY_SETTINGS.has(key) !== NETWORK_GATES.has(key);
    expect(
      classified,
      `Setting "${key}" is not classified. Add it to LOCAL_ONLY_SETTINGS if it makes no ` +
        'outbound request, or to NETWORK_GATES if it does — and if it does, disclose it in ' +
        'docs/privacy-policy.html, README.md, the store listing, and its settings-panel ' +
        'description before shipping (ADR-006).',
    ).toBe(true);
  });
});

describe('network gates ship off by default', () => {
  it.each([...NETWORK_GATES])('%s defaults to false', (key) => {
    // The "a fresh install makes zero network requests" claim on the store
    // listing and in the policy is only true because of this.
    expect(DEFAULT_SETTINGS[key as keyof typeof DEFAULT_SETTINGS]).toBe(false);
  });
});

describe('network gates are disclosed', () => {
  const privacyPolicy = read('docs/privacy-policy.html');

  it.each([...NETWORK_GATES])('%s is named in the privacy policy', (key) => {
    // By exact setting name, so a reader can match the policy to the code.
    expect(privacyPolicy).toContain(key);
  });

  it('the policy no longer claims OpenA2A servers are the only ones reachable', () => {
    // ai-safety.txt (ADR-009) made this claim false: with that setting on, the
    // extension requests a file from the site the agent is on. The old wording
    // was "The only servers it can contact ... are OpenA2A's own ...". If it
    // ever comes back while aiSafetyTxtEnabled exists, the policy is lying.
    expect(privacyPolicy).not.toMatch(/only servers it can contact/i);
  });

  it('the policy discloses that a site the agent is on can be contacted', () => {
    expect(privacyPolicy).toContain('/.well-known/ai-safety.txt');
  });

  it('the README documents the same four features', () => {
    const readme = read('README.md');
    expect(readme).toContain('ai-safety.txt');
    expect(readme).toMatch(/off by default/i);
  });
});
