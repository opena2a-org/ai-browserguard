/**
 * What the popup offers for a recorded block (#69).
 *
 * A block from the delegation's capability list (today: `download-file`)
 * cannot be lifted by a site allow, so no site "Allow" is offered for it; the
 * hint names the real recovery. A site allow is written to the rule that
 * blocked the action, which the violation records as `blockingRuleId`.
 */
import type { BoundaryAlert } from '../alerts/boundary';

export const CAPABILITY_BLOCK_HINT =
  'Blocked because the delegation does not permit downloads. Allowing the site does not change that; Full Access permits downloads.';

export function isCapabilityBlock(alert: BoundaryAlert): boolean {
  return alert.violation.attemptedAction === 'download-file';
}

/** The rule to write a site allow to, or undefined to use the session-wide rule. */
export function blockingRuleIdOf(alert: BoundaryAlert): string | undefined {
  const id = alert.violation.blockingRuleId;
  return id && id !== 'none' ? id : undefined;
}
