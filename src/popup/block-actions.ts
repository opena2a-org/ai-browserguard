/**
 * What the popup offers for a recorded block (#69).
 *
 * A block from the delegation's capability list (today: `download-file`)
 * cannot be lifted by a site allow, so no site "Allow" is offered for it; the
 * hint names the real recovery for the rule that blocks downloads in the
 * agent's tab, and the detail names the other controls with their conditions.
 * Both render visibly in one recovery block, never as a `title`. A site allow
 * is written to the rule that blocked the action, which the violation records
 * as `blockingRuleId`.
 */
import type { BoundaryAlert } from '../alerts/boundary';
import { evaluateRule, FULL_ACCESS_MAX_MINUTES } from '../delegation/rules';
import { selectEffectiveRule } from '../delegation/effective';
import type { DelegationPreset, DelegationRule } from '../types/delegation';

export const CAPABILITY_BLOCK_HINT =
  "Cancelled: the delegation blocks downloads started in the agent's tab, yours included, and a site Allow cannot change that. To get the file, close that agent's tab, then retry.";

/** Summary of the disclosure that holds the other recovery controls. */
export const CAPABILITY_BLOCK_DETAIL_LABEL = 'Other controls';

/** The other recovery controls, each with the condition under which it works. */
export const CAPABILITY_BLOCK_DETAIL_BODY =
  `Revoke on the agent's card frees downloads if no session delegation blocks them. End on the session delegation frees them if the agent's card holds no grant of its own. Full Access permits downloads but gives the agent every capability for up to ${FULL_ACCESS_MAX_MINUTES} minutes, and a grant on the agent's card overrides a session one. The kill switch frees them but closes agent tabs and ends every delegation.`;

/** The full detail string, label and body, as one sentence group. */
export const CAPABILITY_BLOCK_DETAIL = `${CAPABILITY_BLOCK_DETAIL_LABEL}: ${CAPABILITY_BLOCK_DETAIL_BODY}`;

export function isCapabilityBlock(alert: BoundaryAlert): boolean {
  return alert.violation.attemptedAction === 'download-file';
}

/** What the recovery block shows for the download blocks on screen. */
export interface CapabilityRecovery {
  /** The visible hint. */
  hint: string;
  /** Whether the "Other controls" disclosure is shown under it. */
  showOtherControls: boolean;
}

/** Preset names as the agent card and the delegation panel show them. */
const PRESET_NAMES: Record<DelegationPreset, string> = {
  readOnly: 'Read-Only',
  limited: 'Limited',
  fullAccess: 'Full Access',
};

const GENERAL_RECOVERY: CapabilityRecovery = { hint: CAPABILITY_BLOCK_HINT, showOtherControls: true };

/** Which tabs a live owner pause (#71) covers, as the background reports them. */
export interface PauseCoverage {
  /** A pause everywhere is live, so no rule applies in any tab. */
  everywhere: boolean;
  /** Detected agents whose tab a live pause covers, by the page now in it. */
  agentIds: readonly string[];
}

const NO_PAUSE: PauseCoverage = { everywhere: false, agentIds: [] };

/**
 * The recovery hint for the download blocks on screen, naming the control that
 * frees downloads under the rule now in force in the agent's tab: Revoke on
 * the card for a grant on the agent's card, End on the session delegation for
 * a session rule, both when both block. The rule is resolved and evaluated as
 * the background does for the latest block, so once Revoke or End has been
 * pressed the hint says to retry. A tab a live owner pause covers resolves to
 * no rule in the background, so while one covers the agent's tab, or a pause
 * everywhere is live, the hint says to retry too. The general hint is kept
 * when the blocks come from more than one agent or the agent is no longer
 * detected (`agentNameOf` returns null), since no single rule then applies.
 */
export function capabilityRecoveryFor(
  alerts: readonly BoundaryAlert[],
  rules: DelegationRule[],
  agentNameOf: (agentId: string) => string | null,
  paused: PauseCoverage = NO_PAUSE,
): CapabilityRecovery {
  if (paused.everywhere) {
    return {
      hint: 'Cancelled, but the guard is now paused everywhere, so no delegation blocks downloads until the pause ends. Retry the download.',
      showOtherControls: false,
    };
  }

  const blocks = alerts.filter(isCapabilityBlock);
  const agentIds = new Set(blocks.map((a) => a.violation.agentId));
  if (agentIds.size !== 1) return GENERAL_RECOVERY;
  const [agentId] = agentIds;
  const agent = agentId ? agentNameOf(agentId) : null;
  if (!agent) return GENERAL_RECOVERY;
  if (paused.agentIds.includes(agentId)) {
    return {
      hint: `Cancelled, but the guard is now paused in ${agent}'s tab, so no delegation blocks downloads there until the pause ends. Retry the download.`,
      showOtherControls: false,
    };
  }

  const latest = blocks.reduce((a, b) =>
    Date.parse(b.violation.timestamp) > Date.parse(a.violation.timestamp) ? b : a);
  const blocksDownloads = (rule: DelegationRule): boolean =>
    !evaluateRule(rule, 'download-file', latest.violation.url).allowed;

  const inForce = selectEffectiveRule(rules, agentId);
  if (inForce === null || !blocksDownloads(inForce)) {
    return {
      hint: `Cancelled under a delegation that no longer blocks downloads in ${agent}'s tab. Retry the download.`,
      showOtherControls: false,
    };
  }

  const retry = "To get the file, close that agent's tab, then retry.";
  if (inForce.agentId === null) {
    return {
      hint: `Cancelled: the session delegation (${PRESET_NAMES[inForce.preset]}) blocks downloads started in ${agent}'s tab, yours included, and a site Allow cannot change that. ${retry} End on the session delegation also frees them, and leaves every agent without a grant of its own with no delegation.`,
      showOtherControls: true,
    };
  }

  // A grant on the agent's card: after Revoke the session rule, if any, governs the tab.
  const session = selectEffectiveRule(rules, null);
  const revoke = session === null
    ? 'Revoke on its card also frees them, and leaves that agent with no delegation.'
    : blocksDownloads(session)
      ? `Revoke on its card frees them only together with End on the session delegation (${PRESET_NAMES[session.preset]}), which blocks them too.`
      : `Revoke on its card also frees them, and the session delegation (${PRESET_NAMES[session.preset]}) then applies to that agent.`;
  return {
    hint: `Cancelled: the grant on ${agent}'s card (${PRESET_NAMES[inForce.preset]}) blocks downloads started in its tab, yours included, and a site Allow cannot change that. ${retry} ${revoke}`,
    showOtherControls: true,
  };
}

/** The rule to write a site allow to, or undefined to use the session-wide rule. */
export function blockingRuleIdOf(alert: BoundaryAlert): string | undefined {
  const id = alert.violation.blockingRuleId;
  return id && id !== 'none' ? id : undefined;
}
