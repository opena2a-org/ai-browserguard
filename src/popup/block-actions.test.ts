/**
 * #69: what the popup offers for a recorded block, and the removal of the
 * content toast's inert "Whitelist" action.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  blockingRuleIdOf,
  capabilityRecoveryFor,
  isCapabilityBlock,
  CAPABILITY_BLOCK_HINT,
  CAPABILITY_BLOCK_DETAIL,
  CAPABILITY_BLOCK_DETAIL_BODY,
  CAPABILITY_BLOCK_DETAIL_LABEL,
} from './block-actions';
import { createRuleFromPreset, FULL_ACCESS_MAX_MINUTES } from '../delegation/rules';
import type { BoundaryAlert } from '../alerts/boundary';
import type { DelegationRule } from '../types/delegation';

function alert(attemptedAction: string, blockingRuleId: string): BoundaryAlert {
  return {
    violation: { attemptedAction, blockingRuleId, url: 'https://example.com/x' },
  } as unknown as BoundaryAlert;
}

describe('block-actions', () => {
  it('treats a download block as capability-level (no site Allow offered)', () => {
    expect(isCapabilityBlock(alert('download-file', 'r1'))).toBe(true);
    // The hint leads with the one remedy that neither widens the agent's
    // authority nor ends every delegation, and never claims the user's own
    // downloads are exempt.
    expect(CAPABILITY_BLOCK_HINT).toMatch(/close that agent's tab, then retry\.$/);
    expect(CAPABILITY_BLOCK_HINT).toMatch(/yours included/);
    expect(CAPABILITY_BLOCK_HINT).not.toMatch(/never|save the file yourself/i);
  });

  it('names the other controls with their conditions, the Full Access limit rendered from rules.ts', () => {
    expect(CAPABILITY_BLOCK_DETAIL_LABEL).toBe('Other controls');
    expect(CAPABILITY_BLOCK_DETAIL).toBe(`${CAPABILITY_BLOCK_DETAIL_LABEL}: ${CAPABILITY_BLOCK_DETAIL_BODY}`);
    // The label and body split must not change a word: joined, they are the
    // ruled detail string byte for byte.
    expect(CAPABILITY_BLOCK_DETAIL).toBe(
      `Other controls: Revoke on the agent's card frees downloads if no session delegation blocks them. End on the session delegation frees them if the agent's card holds no grant of its own. Full Access permits downloads but gives the agent every capability for up to ${FULL_ACCESS_MAX_MINUTES} minutes, and a grant on the agent's card overrides a session one. The kill switch frees them but closes agent tabs and ends every delegation.`,
    );
    expect(CAPABILITY_BLOCK_DETAIL_BODY).toContain(`for up to ${FULL_ACCESS_MAX_MINUTES} minutes`);
    expect(CAPABILITY_BLOCK_DETAIL_BODY).toMatch(/^Revoke on the agent's card frees downloads if no session delegation blocks them\./);
    expect(CAPABILITY_BLOCK_DETAIL_BODY).toMatch(/The kill switch frees them but closes agent tabs and ends every delegation\.$/);
  });

  it('never leaves Full Access as the only path: a control that grants nothing is named for each kind of grant', () => {
    // A grant on the agent's card: Revoke. A session delegation: End.
    expect(CAPABILITY_BLOCK_DETAIL_BODY).toContain("Revoke on the agent's card frees downloads");
    expect(CAPABILITY_BLOCK_DETAIL_BODY).toContain('End on the session delegation frees them');
    expect(CAPABILITY_BLOCK_DETAIL_BODY.indexOf('End on the session delegation'))
      .toBeLessThan(CAPABILITY_BLOCK_DETAIL_BODY.indexOf('Full Access'));
  });

  it('offers a site Allow for site-level blocks', () => {
    expect(isCapabilityBlock(alert('navigate', 'r1'))).toBe(false);
    expect(isCapabilityBlock(alert('submit-form', 'r1'))).toBe(false);
  });

  it('targets the rule that blocked the action, or the session rule when none is recorded', () => {
    expect(blockingRuleIdOf(alert('navigate', 'rule-42'))).toBe('rule-42');
    expect(blockingRuleIdOf(alert('navigate', 'none'))).toBeUndefined();
    expect(blockingRuleIdOf(alert('navigate', ''))).toBeUndefined();
  });

  it('popup.ts routes both Allow buttons through the checked path', () => {
    const popup = readFileSync(resolve(__dirname, 'popup.ts'), 'utf-8');
    expect(popup).not.toMatch(/sendToBackground\('DOMAIN_WHITELIST', \{ domain(: d)? \}\)/);
    expect(popup.match(/sendWhitelist\(/g)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('content toast', () => {
  it('offers no Whitelist action (DOMAIN_WHITELIST is popup-only; the button was inert)', () => {
    const src = readFileSync(resolve(__dirname, '..', 'content', 'index.ts'), 'utf-8')
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/onWhitelist\s*:/);
    expect(src).not.toMatch(/'DOMAIN_WHITELIST'/);
  });
});

describe('capabilityRecoveryFor: the hint names the control for the rule that blocks the download', () => {
  const URL = 'https://shop.example.com/files/invoice-123.pdf';

  function download(agentId: string, agoMs = 1_000, url = URL): BoundaryAlert {
    return {
      violation: {
        attemptedAction: 'download-file',
        agentId,
        blockingRuleId: 'r',
        url,
        timestamp: new Date(Date.now() - agoMs).toISOString(),
      },
    } as unknown as BoundaryAlert;
  }

  const names: Record<string, string> = { a1: 'Puppeteer', a2: 'Playwright' };
  const nameOf = (id: string): string | null => names[id] ?? null;

  it("a grant on the agent's card with no session delegation: Revoke on its card, and what Revoke leaves", () => {
    const card = createRuleFromPreset('readOnly', { agentId: 'a1' });
    const r = capabilityRecoveryFor([download('a1')], [card], nameOf);
    expect(r.hint).toBe(
      "Cancelled: the grant on Puppeteer's card (Read-Only) blocks downloads started in its tab, yours included, and a site Allow cannot change that. To get the file, close that agent's tab, then retry. Revoke on its card also frees them, and leaves that agent with no delegation.",
    );
    expect(r.hint).not.toMatch(/\bEnd\b/);
    expect(r.showOtherControls).toBe(true);
  });

  it('a card grant over a session delegation that also blocks downloads: Revoke frees them only together with End', () => {
    const card = createRuleFromPreset('readOnly', { agentId: 'a1' });
    const session = createRuleFromPreset('limited', { agentId: null });
    const r = capabilityRecoveryFor([download('a1')], [session, card], nameOf);
    expect(r.hint).toMatch(/^Cancelled: the grant on Puppeteer's card \(Read-Only\) blocks downloads/);
    expect(r.hint).toMatch(
      /Revoke on its card frees them only together with End on the session delegation \(Limited\), which blocks them too\.$/,
    );
  });

  it('a card grant over a session delegation that permits downloads: Revoke, and the session rule then applies', () => {
    const card = createRuleFromPreset('readOnly', { agentId: 'a1' });
    const session = createRuleFromPreset('fullAccess', { agentId: null });
    const r = capabilityRecoveryFor([download('a1')], [session, card], nameOf);
    expect(r.hint).toMatch(
      /Revoke on its card also frees them, and the session delegation \(Full Access\) then applies to that agent\.$/,
    );
  });

  it('a session delegation with no card grant: End on the session delegation, never Revoke', () => {
    const session = createRuleFromPreset('readOnly', { agentId: null });
    const otherAgentsCard = createRuleFromPreset('fullAccess', { agentId: 'a2' });
    const r = capabilityRecoveryFor([download('a1')], [session, otherAgentsCard], nameOf);
    expect(r.hint).toBe(
      "Cancelled: the session delegation (Read-Only) blocks downloads started in Puppeteer's tab, yours included, and a site Allow cannot change that. To get the file, close that agent's tab, then retry. End on the session delegation also frees them, and leaves every agent without a grant of its own with no delegation.",
    );
    expect(r.hint).not.toMatch(/Revoke/);
    expect(r.showOtherControls).toBe(true);
  });

  it('once no rule in force blocks downloads in that tab, says to retry and drops the other controls', () => {
    const revokedCard = { ...createRuleFromPreset('readOnly', { agentId: 'a1' }), isActive: false };
    const endedSession = { ...createRuleFromPreset('readOnly', { agentId: null }), isActive: false };
    for (const rules of [[], [revokedCard], [revokedCard, endedSession], [createRuleFromPreset('fullAccess', { agentId: 'a1' })]]) {
      const r = capabilityRecoveryFor([download('a1')], rules, nameOf);
      expect(r.hint).toBe(
        "Cancelled under a delegation that no longer blocks downloads in Puppeteer's tab. Retry the download.",
      );
      expect(r.showOtherControls).toBe(false);
    }
  });

  it('judges the rule in force against the latest blocked download, with the same evaluation the background uses', () => {
    // A session rule that permits downloads except from one blocked site: the
    // older download came from that site, the latest one did not.
    const full = createRuleFromPreset('fullAccess', { agentId: null });
    const session: DelegationRule = {
      ...full,
      scope: { ...full.scope, sitePatterns: [{ pattern: 'other.example.org', action: 'block' }] },
    };
    const older = download('a1', 60_000, 'https://other.example.org/a.zip');
    const latest = download('a1', 1_000);
    expect(capabilityRecoveryFor([older, latest], [session], nameOf).showOtherControls).toBe(false);
    expect(capabilityRecoveryFor([latest, older], [session], nameOf).showOtherControls).toBe(false);
    expect(capabilityRecoveryFor([older], [session], nameOf).hint)
      .toMatch(/^Cancelled: the session delegation \(Full Access\) blocks downloads/);
  });

  it('falls back to the general hint when the agent is no longer detected, or the blocks come from different agents', () => {
    const session = createRuleFromPreset('readOnly', { agentId: null });
    const generic = { hint: CAPABILITY_BLOCK_HINT, showOtherControls: true };
    expect(capabilityRecoveryFor([download('a-gone')], [session], nameOf)).toEqual(generic);
    expect(capabilityRecoveryFor([download('')], [session], nameOf)).toEqual(generic);
    expect(capabilityRecoveryFor([download('a1'), download('a2')], [session], nameOf)).toEqual(generic);
    expect(capabilityRecoveryFor([], [session], nameOf)).toEqual(generic);
    // A non-download block does not count as a block from another agent.
    expect(capabilityRecoveryFor([download('a1'), alert('click', 'r')], [session], nameOf).hint)
      .toMatch(/^Cancelled: the session delegation \(Read-Only\)/);
  });

  it('never offers Full Access as the way out, and always names a control that grants nothing', () => {
    const cases: DelegationRule[][] = [
      [createRuleFromPreset('readOnly', { agentId: 'a1' })],
      [createRuleFromPreset('readOnly', { agentId: 'a1' }), createRuleFromPreset('readOnly', { agentId: null })],
      [createRuleFromPreset('limited', { agentId: null })],
    ];
    for (const rules of cases) {
      const { hint } = capabilityRecoveryFor([download('a1')], rules, nameOf);
      expect(hint).toContain("close that agent's tab, then retry");
      expect(hint).toMatch(/Revoke on its card|End on the session delegation/);
      expect(hint).not.toMatch(/grant(ing)? Full Access|Allow Full Access/);
    }
  });
});
