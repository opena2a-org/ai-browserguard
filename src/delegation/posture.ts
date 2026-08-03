/**
 * Browser-posture guidance (ADR-008 roadmap item R1).
 *
 * External CDP/WebDriver drivers are detect-only for ABG (see enforceability.ts)
 * — but since Chrome 136 the browser ITSELF closes the highest-value case:
 * remote debugging of the default profile is refused unless Chrome was launched
 * with a separate `--user-data-dir`. Telling the user that turns the honest
 * "Not enforced" caveat into something actionable: their everyday profile is
 * already covered by the browser, and an agent that did reach a tab is running
 * in a separate profile or was granted debugging at launch.
 *
 * Pure and dependency-free so every surface states the same fact and tests can
 * pin it. Honesty constraints, in order:
 *  - The statement is about the BROWSER VERSION, never about the current
 *    profile — an extension cannot see which profile it is running in.
 *  - It must not read as "this agent is contained": the agent in front of the
 *    user has, by existing, already crossed that protection.
 */

/**
 * Major version parsed from a user-agent string, or null when it cannot be
 * determined. Matches the desktop UA shape (`Chrome/136.0.x.y`); brand checks
 * beyond that are deliberately out of scope — Chromium forks that keep the
 * token ship the same remote-debugging change.
 */
export function chromeMajorVersion(userAgent: string): number | null {
  const match = /\bChrome\/(\d+)\./.exec(userAgent);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isFinite(major) && major > 0 ? major : null;
}

/** First Chrome major that refuses remote debugging of the default profile. */
export const DEFAULT_PROFILE_PROTECTED_SINCE = 136;

/**
 * One-sentence posture line for an EXTERNAL (detect-only) agent card, or null
 * when the version is unknown. Recovery-framed both ways: on a protected
 * version it explains what the agent's presence implies; on an older version it
 * names the concrete fix (update) instead of only the exposure.
 */
export function remoteDebuggingPosture(major: number | null): string | null {
  if (major === null) return null;
  if (major >= DEFAULT_PROFILE_PROTECTED_SINCE) {
    return 'Your Chrome already refuses remote debugging of its default profile '
      + `(Chrome ${DEFAULT_PROFILE_PROTECTED_SINCE}+). An external agent that reached this tab is `
      + 'running in a separate profile, or debugging was enabled when this browser was launched.';
  }
  return `Updating Chrome (${DEFAULT_PROFILE_PROTECTED_SINCE}+) makes it refuse remote debugging `
    + 'of your default profile — the strongest protection against external drivers.';
}
