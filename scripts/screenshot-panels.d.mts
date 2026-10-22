import type { AgentIdentity } from '../src/types/agent';
import type { AgentSession } from '../src/session/types';

/** The stored sessions the detection capture's timeline shows, newest first. */
export const DETECTION_SESSIONS: AgentSession[];

/** The agents the detection capture shows as detected, in the order they were detected. */
export const DETECTED_AGENTS: AgentIdentity[];

export interface PopupPanelsState {
  /** The agents the background reports as detected, in its order. */
  detectedAgents: AgentIdentity[];
  delegationActive: boolean;
  killSwitchActive: boolean;
}

/**
 * Fill `#detection-content`, set `#kill-switch-btn` and add `#network-panel`
 * to the popup document the way the popup renders them for `state`.
 */
export function drawPopupPanels(state: PopupPanelsState): void;
