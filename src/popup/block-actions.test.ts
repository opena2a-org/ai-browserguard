/**
 * #69: what the popup offers for a recorded block, and the removal of the
 * content toast's inert "Whitelist" action.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  blockingRuleIdOf,
  isCapabilityBlock,
  CAPABILITY_BLOCK_HINT,
  CAPABILITY_BLOCK_DETAIL,
  CAPABILITY_BLOCK_DETAIL_BODY,
  CAPABILITY_BLOCK_DETAIL_LABEL,
} from './block-actions';
import { FULL_ACCESS_MAX_MINUTES } from '../delegation/rules';
import type { BoundaryAlert } from '../alerts/boundary';

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
