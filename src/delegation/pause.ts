/**
 * Owner-initiated pause of enforcement (#71).
 *
 * A pause stands the guard down on one site, or everywhere, for a bounded time,
 * without disabling the extension. While a tab is covered by a live pause its
 * effective rule resolves to none, so the page-realm interceptor, the CDP layer
 * and the download monitor all pass through there, and the agent sees no guard
 * denials on that site. Detection, the timeline and the kill switch keep
 * running: a pause lifts enforcement, never monitoring, and never lifts a
 * latched kill switch.
 *
 * Bounds, so a pause cannot quietly become "disabled":
 * - A site pause covers exactly one hostname (no subdomains, no parent domain)
 *   and lasts 15 or 60 minutes, or until the owner resumes it.
 * - A pause everywhere always has an end: 15 or 60 minutes. "Until I resume"
 *   everywhere would be the extension switched off with extra steps.
 * - An expiry that cannot be parsed counts as ended, so a damaged record fails
 *   back to enforcement, not open.
 *
 * Pure helpers only; the service worker owns the state and the side effects.
 */

export type PauseScope = 'site' | 'all';

/** Durations offered for a site pause; `null` is "until I resume". */
export const SITE_PAUSE_MINUTES: readonly (number | null)[] = [15, 60, null];

/** Durations offered for a pause everywhere. Always time-boxed. */
export const ALL_PAUSE_MINUTES: readonly number[] = [15, 60];

/** Pause history entries kept for the owner to review. */
export const MAX_PAUSE_LOG_ENTRIES = 20;

/**
 * A bare hostname, as the popup derives it from `new URL(...).hostname`.
 * Same shape the DOMAIN_WHITELIST handler accepts.
 */
const PAUSABLE_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

export interface GuardPause {
  /** Unique pause identifier. */
  id: string;
  /** One site, or every site. */
  scope: PauseScope;
  /** Lowercase hostname for a site pause; null for a pause everywhere. */
  host: string | null;
  /** ISO 8601 timestamp when the owner started the pause. */
  startedAt: string;
  /** ISO 8601 timestamp when it ends on its own; null means until resumed (site only). */
  expiresAt: string | null;
}

/** Why a pause stopped covering anything. */
export type PauseEndReason = 'expired' | 'resumed' | 'replaced' | 'kill-switch';

/** One row of the pause history: what was unguarded, and when. */
export interface PauseLogEntry extends GuardPause {
  /** ISO 8601 timestamp when the pause ended; null while it is live. */
  endedAt: string | null;
  /**
   * How the pause ended; null while it is live. One of PauseEndReason when this
   * version wrote it; a stored entry may carry a reason a later version added.
   */
  endReason: string | null;
}

export type CreatePauseResult =
  | { ok: true; pause: GuardPause }
  | { ok: false; reason: string };

/** True when `host` is a hostname a site pause can cover. */
export function isPausableHost(host: unknown): host is string {
  return typeof host === 'string' && PAUSABLE_HOST.test(host);
}

/**
 * Validate a pause request from the popup and build the pause.
 *
 * `minutes` is `null` for "until I resume", which only a site pause accepts.
 */
export function createPause(
  request: { scope?: unknown; host?: unknown; minutes?: unknown },
  now: number,
  id: string,
): CreatePauseResult {
  const { scope, host, minutes } = request;
  if (scope === 'site') {
    if (!isPausableHost(host)) {
      return { ok: false, reason: 'Not a site the guard can be paused on.' };
    }
    if (!(minutes === null || (typeof minutes === 'number' && SITE_PAUSE_MINUTES.includes(minutes)))) {
      return { ok: false, reason: 'Choose 15 minutes, 60 minutes, or until you resume.' };
    }
    return {
      ok: true,
      pause: {
        id,
        scope: 'site',
        host: host.toLowerCase(),
        startedAt: new Date(now).toISOString(),
        expiresAt: minutes === null ? null : new Date(now + minutes * 60_000).toISOString(),
      },
    };
  }
  if (scope === 'all') {
    if (!(typeof minutes === 'number' && ALL_PAUSE_MINUTES.includes(minutes))) {
      return { ok: false, reason: 'A pause everywhere lasts 15 or 60 minutes.' };
    }
    return {
      ok: true,
      pause: {
        id,
        scope: 'all',
        host: null,
        startedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + minutes * 60_000).toISOString(),
      },
    };
  }
  return { ok: false, reason: 'Unknown pause scope.' };
}

/** True while the pause still covers something at time `now`. */
export function isPauseLive(pause: GuardPause, now: number): boolean {
  if (pause.expiresAt === null) return pause.scope === 'site';
  const end = Date.parse(pause.expiresAt);
  return Number.isFinite(end) && end > now;
}

/**
 * The live pause covering a page on `host`, or null. A site pause on that exact
 * host is preferred over a pause everywhere so the popup shows the narrower
 * one. A null host (unknown page) is covered only by a pause everywhere.
 */
export function pauseCovering(
  pauses: readonly GuardPause[],
  host: string | null,
  now: number,
): GuardPause | null {
  const live = pauses.filter((p) => isPauseLive(p, now));
  if (host !== null) {
    const h = host.toLowerCase();
    const site = live.find((p) => p.scope === 'site' && p.host === h);
    if (site) return site;
  }
  return live.find((p) => p.scope === 'all') ?? null;
}

/** Key deciding which earlier pause a new one replaces: one per host, one everywhere. */
function pauseKey(pause: GuardPause): string {
  return pause.scope === 'all' ? '__all__' : `site:${pause.host}`;
}

/**
 * Add a pause, replacing any earlier pause with the same scope and host (a new
 * duration for the same site is a replacement, not a second pause). Returns the
 * new list and the pauses it replaced. Does not mutate the input.
 */
export function applyPause(
  pauses: readonly GuardPause[],
  incoming: GuardPause,
): { pauses: GuardPause[]; replaced: GuardPause[] } {
  const key = pauseKey(incoming);
  const replaced = pauses.filter((p) => pauseKey(p) === key);
  const kept = pauses.filter((p) => pauseKey(p) !== key);
  return { pauses: [...kept, incoming], replaced };
}

/** Split pauses into those still live at `now` and those that have ended. */
export function splitExpiredPauses(
  pauses: readonly GuardPause[],
  now: number,
): { live: GuardPause[]; expired: GuardPause[] } {
  const live: GuardPause[] = [];
  const expired: GuardPause[] = [];
  for (const p of pauses) {
    (isPauseLive(p, now) ? live : expired).push(p);
  }
  return { live, expired };
}

/** Epoch ms of the next time-boxed pause end, or null when none is pending. */
export function nextPauseExpiry(pauses: readonly GuardPause[], now: number): number | null {
  let next: number | null = null;
  for (const p of pauses) {
    if (p.expiresAt === null || !isPauseLive(p, now)) continue;
    const end = Date.parse(p.expiresAt);
    if (next === null || end < next) next = end;
  }
  return next;
}

/** Record a newly started pause at the head of the history, bounded. */
export function logPauseStarted(log: readonly PauseLogEntry[], pause: GuardPause): PauseLogEntry[] {
  return [{ ...pause, endedAt: null, endReason: null }, ...log].slice(0, MAX_PAUSE_LOG_ENTRIES);
}

/**
 * Close a pause's history entry. An expired pause is stamped with its own
 * expiry, not the time the tick noticed it, so the history shows the window
 * that was actually unguarded.
 */
export function logPauseEnded(
  log: readonly PauseLogEntry[],
  pause: GuardPause,
  reason: PauseEndReason,
  now: number,
): PauseLogEntry[] {
  const endedAt = reason === 'expired' && pause.expiresAt !== null
    ? pause.expiresAt
    : new Date(now).toISOString();
  return log.map((entry) =>
    entry.id === pause.id && entry.endedAt === null ? { ...entry, endedAt, endReason: reason } : entry,
  );
}

/** Shape-check a stored pause; storage is a persistence boundary. */
export function isGuardPause(value: unknown): value is GuardPause {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== 'string' || typeof p.startedAt !== 'string') return false;
  if (!(p.expiresAt === null || typeof p.expiresAt === 'string')) return false;
  if (p.scope === 'site') return isPausableHost(p.host);
  if (p.scope === 'all') return p.host === null && typeof p.expiresAt === 'string';
  return false;
}

/**
 * Shape-check a stored history entry. A live entry has neither an end time nor
 * an end reason, and an ended one has both. An end reason this version has no
 * label for is kept: a later version may have written it, and the loaded
 * history is written back to storage, so dropping it here would delete it.
 */
export function isPauseLogEntry(value: unknown): value is PauseLogEntry {
  if (!isGuardPause(value)) return false;
  const { endedAt, endReason } = value as unknown as Record<string, unknown>;
  if (endedAt === null) return endReason === null;
  return typeof endedAt === 'string' && typeof endReason === 'string' && endReason !== '';
}

/**
 * The hostname a site pause would cover for a page URL, or null when the page
 * is not a website (chrome://, file:, about:blank, the new-tab page).
 */
export function pausableHostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return isPausableHost(parsed.hostname) ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Plain-language description of a pause's reach, for the timeline and popup. */
export function describePauseScope(pause: GuardPause): string {
  return pause.scope === 'all' ? 'everywhere' : `on ${pause.host}`;
}

/** Plain-language description of how long a pause lasts. */
export function describePauseDuration(pause: GuardPause): string {
  if (pause.expiresAt === null) return 'until resumed';
  const minutes = Math.round((Date.parse(pause.expiresAt) - Date.parse(pause.startedAt)) / 60_000);
  return Number.isFinite(minutes) ? `for ${minutes} minutes` : 'for a limited time';
}

/** Plain-language end reason for the pause history. */
export const PAUSE_END_REASON_LABELS: Record<PauseEndReason, string> = {
  expired: 'ended on time',
  resumed: 'resumed by you',
  replaced: 'replaced by a new pause',
  'kill-switch': 'ended by the kill switch',
};

/** The history label for an end reason; "ended" for one this version does not know. */
export function pauseEndReasonLabel(reason: string): string {
  return Object.prototype.hasOwnProperty.call(PAUSE_END_REASON_LABELS, reason)
    ? PAUSE_END_REASON_LABELS[reason as PauseEndReason]
    : 'ended';
}
