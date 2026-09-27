/**
 * What the popup offers for a recorded block (#69).
 *
 * A block from the delegation's capability list (today: `download-file`)
 * cannot be lifted by a site allow, so no site "Allow" is offered for it; the
 * hint names the real recovery, and the detail names the other controls with
 * their conditions. Both render visibly in one recovery block, never as a
 * `title`. A site allow is written to the rule that blocked the action, which
 * the violation records as `blockingRuleId`.
 */
import type { BoundaryAlert } from '../alerts/boundary';
import { FULL_ACCESS_MAX_MINUTES } from '../delegation/rules';

export const CAPABILITY_BLOCK_HINT =
  "Cancelled: the delegation blocks downloads from the site where the agent was detected, yours included, and a site Allow cannot change that. To get the file, close that agent's tab, then retry.";

/** Summary of the disclosure that holds the other recovery controls. */
export const CAPABILITY_BLOCK_DETAIL_LABEL = 'Other controls';

/** The other recovery controls, each with the condition under which it works. */
export const CAPABILITY_BLOCK_DETAIL_BODY =
  `Revoke on the agent's card frees downloads if no session delegation blocks them. Full Access permits downloads but gives the agent every capability for up to ${FULL_ACCESS_MAX_MINUTES} minutes, and a grant on the agent's card overrides a session one. The kill switch frees them but closes agent tabs and ends every delegation.`;

/** The full detail string, label and body, as one sentence group. */
export const CAPABILITY_BLOCK_DETAIL = `${CAPABILITY_BLOCK_DETAIL_LABEL}: ${CAPABILITY_BLOCK_DETAIL_BODY}`;

export function isCapabilityBlock(alert: BoundaryAlert): boolean {
  return alert.violation.attemptedAction === 'download-file';
}

/** The rule to write a site allow to, or undefined to use the session-wide rule. */
export function blockingRuleIdOf(alert: BoundaryAlert): string | undefined {
  const id = alert.violation.blockingRuleId;
  return id && id !== 'none' ? id : undefined;
}
