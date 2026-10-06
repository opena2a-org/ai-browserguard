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
 *   {@link TAB_DOWNLOAD_START_WINDOW_MS}. Only this level may be cancelled.
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
 * The earliest start in `starts` that belongs to the download `info`: its URL
 * equals the item's URL or final URL, and it was observed within
 * {@link TAB_DOWNLOAD_START_WINDOW_MS} of `now`. Null when none does.
 */
export function matchTabDownloadStart(
  starts: Iterable<TabDownloadStart>,
  info: Pick<DownloadInfo, 'url' | 'finalUrl'>,
  now: number,
): TabDownloadStart | null {
  let best: TabDownloadStart | null = null;
  for (const start of starts) {
    if (Math.abs(now - start.at) > TAB_DOWNLOAD_START_WINDOW_MS) continue;
    if (!start.url || (start.url !== info.url && start.url !== info.finalUrl)) continue;
    if (!best || start.at < best.at) best = start;
  }
  return best;
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
