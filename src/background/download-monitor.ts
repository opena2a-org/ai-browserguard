/**
 * Agent-initiated download monitoring (pure decision layer).
 *
 * A download is only of interest when an agent is currently active — otherwise
 * it is the user downloading a file and must not be flagged. When an agent IS
 * active, we attribute the download to the agent's tab (by referrer host, then
 * single-agent fallback) so it can be recorded on that session and, under a
 * delegation that blocks `download-file`, cancelled.
 *
 * This module is pure so attribution and the block decision are unit-testable
 * without a live chrome.downloads event.
 */

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
  originUrl: string;
}

export interface DownloadAttribution {
  tabId: number;
  /** True when matched to a tab by referrer/url host rather than as a fallback. */
  matchedByReferrer: boolean;
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
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
 * Attribute a download to the tab of the agent that most likely caused it.
 * Caller must have already ruled out {@link shouldIgnoreDownload}, so
 * `activeAgents` is non-empty and a best-effort tab is always returned.
 *
 * Order: referrer/finalUrl/url host matches an active agent's origin host →
 * the sole active agent → the first active agent (attribution uncertain).
 */
export function attributeDownload(
  info: DownloadInfo,
  activeAgents: ActiveAgentTab[],
): DownloadAttribution {
  const candidateHosts = [hostOf(info.referrer), hostOf(info.finalUrl), hostOf(info.url)].filter(
    (h): h is string => h !== null,
  );
  for (const agent of activeAgents) {
    const agentHost = hostOf(agent.originUrl);
    if (agentHost && candidateHosts.includes(agentHost)) {
      return { tabId: agent.tabId, matchedByReferrer: true };
    }
  }
  if (activeAgents.length === 1) {
    return { tabId: activeAgents[0].tabId, matchedByReferrer: false };
  }
  return { tabId: activeAgents[0].tabId, matchedByReferrer: false };
}

/** A short, human-readable label for a download (filename, else its URL host). */
export function describeDownload(info: DownloadInfo): string {
  const name = (info.filename ?? '').split(/[\\/]/).pop();
  if (name) return name;
  return hostOf(info.finalUrl) ?? hostOf(info.url) ?? info.url ?? 'unknown file';
}
