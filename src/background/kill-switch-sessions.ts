/**
 * Kill-switch session teardown.
 *
 * The kill switch must end every session it can find — including sessions that
 * outlived a service-worker restart. The in-memory `state.activeSessions` map is
 * empty after such a restart, so ending sessions off that map silently skips the
 * very sessions the user is trying to stop. This helper drives the teardown off
 * STORED sessions instead: any session without an `endedAt` is marked ended with
 * `endReason: 'kill-switch'` and its report is generated.
 */
import { getStorageState, updateSession } from '../session/storage';

/**
 * End every stored session that has not already ended (as of a single storage
 * snapshot), marking it as terminated by the kill switch and generating a report
 * for it. A session persisted after the snapshot is left for the next kill switch
 * — by then `activeAgents` is cleared and `killSwitch.isActive` is latched, so no
 * new agent activity gets through anyway.
 *
 * @param generateReport - generates and stores the report for an ended session.
 *   Injected so this module stays decoupled from the report/consent pipeline.
 * @param now - returns the ISO timestamp to stamp as `endedAt` (injectable for tests).
 * @returns the ids of the sessions that were ended by this call.
 */
export async function endStoredSessionsForKillSwitch(
  generateReport: (sessionId: string) => Promise<void>,
  now: () => string = () => new Date().toISOString(),
): Promise<string[]> {
  const stored = await getStorageState();
  const unended = stored.sessions.filter((s) => !s.endedAt);

  for (const session of unended) {
    await updateSession(session.id, (s) => ({
      ...s,
      endedAt: now(),
      endReason: 'kill-switch' as const,
    }));
    await generateReport(session.id);
  }

  return unended.map((s) => s.id);
}
