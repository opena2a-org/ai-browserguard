/**
 * Download monitoring while an agent is registered (pure decision layer).
 *
 * A download is only of interest when an agent is currently registered;
 * otherwise it is ignored. When an agent IS registered, we attribute the
 * download to an agent's tab so it can be recorded on that session, at one of
 * three levels (see `DownloadAttributionLevel`):
 *
 * - `tab`: Chrome reported the download starting in an agent's tab
 *   (`Page.downloadWillBegin` on a debugger session this extension holds
 *   there), matched to the download item by URL inside
 *   {@link TAB_DOWNLOAD_START_WINDOW_MS}, and only while that URL names one
 *   download: the report carries no download id, so another download of the
 *   same URL that no report accounts for (the user's, in a tab we hold no
 *   session on) leaves both unmatched. Only this level may be cancelled.
 *   Not for a tab whose agent is an attachment seen while the built-in
 *   DevTools was open (`devToolsOnly`): that is most likely the user
 *   inspecting their own page, so a start there is at most a host match.
 * - `host`: the referrer, final URL or URL has the same origin (scheme, host
 *   and port) as the page now open in an agent's tab (else the page the agent
 *   was first seen on). A download item carries no tab id, so this
 *   cannot tell the agent's download from the user's own one in another tab of
 *   the same site; it is recorded, never cancelled.
 * - `none`: nothing ties it to an agent; recorded on the first agent's session.
 *
 * This module is pure so attribution and the block decision are unit-testable
 * without a live chrome.downloads event.
 */

import type { DownloadAttributionLevel } from '../types/events';

/** The subset of chrome.downloads.DownloadItem we reason about. */
export interface DownloadInfo {
  id: number;
  url: string;
  finalUrl?: string;
  filename?: string;
  referrer?: string;
  /** Set by Chrome when the download was initiated by an extension. */
  byExtensionId?: string;
  /** When Chrome created the item (ISO 8601). */
  startTime?: string;
}

/** An agent currently active in a tab. */
export interface ActiveAgentTab {
  tabId: number;
  /** The page the agent was first seen on. */
  originUrl: string;
  /**
   * The origin of the page now open in the agent's tab, as last recorded from
   * its navigations; null when that page has none (about:blank, data:, file:).
   * Undefined when nothing has been recorded, and `originUrl` is used instead.
   */
  pageOrigin?: string | null;
  /**
   * The agent was registered only from a debugger attachment seen while the
   * built-in DevTools was open (`medium` confidence). An open DevTools window
   * makes the page it inspects report an attachment, so this tab is most
   * likely the user's own, and a download start reported in it is not
   * tab-level attribution.
   */
  devToolsOnly?: boolean;
}

/**
 * A download start Chrome reported in a tab (`Page.downloadWillBegin` on a
 * debugger session this extension holds on that tab).
 */
export interface TabDownloadStart {
  tabId: number;
  frameId: string;
  guid: string;
  url: string;
  /** When the start was observed (ms since epoch). */
  at: number;
}

/**
 * The longest gap, in either order, between a tab's download start and the
 * chrome.downloads item it is matched to. A start not matched within it is
 * discarded, and a download item waits at most this long for its start.
 */
export const TAB_DOWNLOAD_START_WINDOW_MS = 5_000;

/** A download item a start could also belong to, as chrome.downloads lists it. */
export type RecentDownload = Pick<DownloadInfo, 'id' | 'url' | 'finalUrl' | 'startTime'>;

/** The download item a start is matched to; `id` and `startTime` when known. */
export type DownloadToMatch = Pick<DownloadInfo, 'url' | 'finalUrl' | 'startTime'> & { id?: number };

/** `startTime` in ms since epoch, or null when it is missing or unparseable. */
function startedAt(d: Pick<DownloadInfo, 'startTime'>): number | null {
  const t = d.startTime ? Date.parse(d.startTime) : NaN;
  return Number.isNaN(t) ? null : t;
}

/**
 * Whether the download `d` could be the one `start` reports: same URL, and
 * created no later than the report was observed and at most
 * {@link TAB_DOWNLOAD_START_WINDOW_MS} before it. Chrome creates the item
 * before it reports the start, so an item created after the report was
 * observed is not its download. An unknown creation time is not ruled out.
 */
function couldBeStartOf(d: Pick<DownloadInfo, 'url' | 'finalUrl' | 'startTime'>, start: TabDownloadStart): boolean {
  if (start.url !== d.url && start.url !== d.finalUrl) return false;
  const t = startedAt(d);
  return t === null || (t <= start.at && start.at - t <= TAB_DOWNLOAD_START_WINDOW_MS);
}

export interface DownloadAttribution {
  /** The agent tab whose session the download is recorded on. */
  tabId: number;
  level: DownloadAttributionLevel;
  /** `tab` only: the frame the download started in. */
  frameId?: string;
  /** `host` only: the host (with port, when not the default) that matched. */
  matchedHost?: string;
}

/** The hostname of `url`, or null when it is missing or unparseable. */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * The origin (scheme, host and port) of `url`, or null when it is missing,
 * unparseable or opaque (about:blank, file://, data:).
 */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Decide whether a download should be ignored outright.
 *
 * - Downloads initiated by THIS extension (report export) are never agent
 *   activity.
 * - With no active agent, a download is the user's own action — ignore it so
 *   normal browsing is never flagged.
 */
export function shouldIgnoreDownload(
  info: DownloadInfo,
  activeAgents: ActiveAgentTab[],
  ownExtensionId: string | undefined,
): boolean {
  if (ownExtensionId && info.byExtensionId === ownExtensionId) return true;
  if (activeAgents.length === 0) return true;
  return false;
}

/**
 * The earliest start in `starts` (the reports no download has taken yet) that
 * belongs to the download `info`: its URL equals the item's URL or final URL,
 * it was observed within {@link TAB_DOWNLOAD_START_WINDOW_MS} of `now`, and the
 * item was not created after it was observed. Null when none does.
 *
 * A report carries no download id, so its URL is all that ties it to an item.
 * `others` are the other download items that have not taken a report. When
 * more of them could be that URL's download than there are reports for it
 * besides this one, the report cannot say which download started in the
 * agent's tab, and null is returned: one of them is not the agent's, and
 * matching by arrival order could hand the report to the user's download.
 */
export function matchTabDownloadStart(
  starts: Iterable<TabDownloadStart>,
  info: DownloadToMatch,
  now: number,
  others: Iterable<RecentDownload> = [],
): TabDownloadStart | null {
  const live = Array.from(starts).filter((s) => s.url && Math.abs(now - s.at) <= TAB_DOWNLOAD_START_WINDOW_MS);
  let best: TabDownloadStart | null = null;
  for (const start of live) {
    if (!couldBeStartOf(info, start)) continue;
    if (!best || start.at < best.at) best = start;
  }
  if (!best) return null;
  const match = best;
  const reports = live.filter((s) => s.url === match.url).length;
  let rivals = 0;
  for (const d of others) {
    if (d.id !== info.id && couldBeStartOf(d, match)) rivals += 1;
  }
  return rivals < reports ? match : null;
}

/**
 * Attribute a download to an agent's tab. Caller must have already ruled out
 * {@link shouldIgnoreDownload}, so `activeAgents` is non-empty and a tab is
 * always returned.
 *
 * Order: a download start reported in a tab with a registered agent (`tab`) →
 * a referrer/finalUrl/url origin equal to the origin of the page now open in
 * an agent's tab (`host`) → the first active agent (`none`).
 */
export function attributeDownload(
  info: DownloadInfo,
  activeAgents: ActiveAgentTab[],
  tabStart: TabDownloadStart | null = null,
): DownloadAttribution {
  if (tabStart && activeAgents.some((a) => a.tabId === tabStart.tabId && a.devToolsOnly !== true)) {
    return { tabId: tabStart.tabId, level: 'tab', frameId: tabStart.frameId };
  }
  const candidateOrigins = [originOf(info.referrer), originOf(info.finalUrl), originOf(info.url)].filter(
    (o): o is string => o !== null,
  );
  for (const agent of activeAgents) {
    const agentOrigin = agent.pageOrigin !== undefined ? agent.pageOrigin : originOf(agent.originUrl);
    if (agentOrigin && candidateOrigins.includes(agentOrigin)) {
      return { tabId: agent.tabId, level: 'host', matchedHost: new URL(agentOrigin).host };
    }
  }
  return { tabId: activeAgents[0].tabId, level: 'none' };
}

/** A short, human-readable label for a download (filename, else its URL host). */
export function describeDownload(info: DownloadInfo): string {
  const name = (info.filename ?? '').split(/[\\/]/).pop();
  if (name) return name;
  return hostOf(info.finalUrl) ?? hostOf(info.url) ?? info.url ?? 'unknown file';
}
