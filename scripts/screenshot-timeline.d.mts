import type { AgentSession } from '../src/session/types';

/** The stored sessions the kill switch capture's timeline shows, newest first. */
export const KILL_SWITCH_SESSIONS: AgentSession[];

/**
 * Fill `#timeline-list` of the popup document, and show or hide
 * `#timeline-panel`, the way the popup renders `sessions`.
 */
export function drawTimeline(sessions: AgentSession[]): void;
