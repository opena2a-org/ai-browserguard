import { describe, it, expect } from 'vitest';
import {
  shouldIgnoreDownload,
  attributeDownload,
  describeDownload,
  matchTabDownloadStart,
  originOf,
  TAB_DOWNLOAD_START_WINDOW_MS,
  type DownloadInfo,
  type ActiveAgentTab,
  type TabDownloadStart,
} from './download-monitor';

function info(overrides?: Partial<DownloadInfo>): DownloadInfo {
  return {
    id: 1,
    url: 'https://files.example.com/a.txt',
    finalUrl: 'https://files.example.com/a.txt',
    filename: '/tmp/dl/a.txt',
    referrer: 'https://app.example.com/',
    ...overrides,
  };
}

describe('shouldIgnoreDownload', () => {
  const agents: ActiveAgentTab[] = [{ tabId: 1, originUrl: 'https://app.example.com/' }];

  it("ignores this extension's own report-export download", () => {
    expect(shouldIgnoreDownload(info({ byExtensionId: 'self-id' }), agents, 'self-id')).toBe(true);
  });

  it('ignores any download when no agent is active (a user download)', () => {
    expect(shouldIgnoreDownload(info(), [], 'self-id')).toBe(true);
  });

  it('does not ignore a download while an agent is active', () => {
    expect(shouldIgnoreDownload(info(), agents, 'self-id')).toBe(false);
  });

  it('does not ignore a download from a different extension', () => {
    expect(shouldIgnoreDownload(info({ byExtensionId: 'other-id' }), agents, 'self-id')).toBe(false);
  });
});

describe('attributeDownload', () => {
  it('matches by referrer host to the active agent tab', () => {
    const agents: ActiveAgentTab[] = [
      { tabId: 5, originUrl: 'https://other.com/' },
      { tabId: 7, originUrl: 'https://app.example.com/page' },
    ];
    const a = attributeDownload(info({ referrer: 'https://app.example.com/x' }), agents);
    expect(a).toEqual({ tabId: 7, level: 'host', matchedHost: 'app.example.com' });
  });

  it('falls back to the sole active agent when no host matches', () => {
    const agents: ActiveAgentTab[] = [{ tabId: 9, originUrl: 'https://nomatch.com/' }];
    const a = attributeDownload(info({ referrer: undefined, finalUrl: undefined, url: 'data:text/plain;base64,AAA' }), agents);
    expect(a).toEqual({ tabId: 9, level: 'none' });
  });

  it('matches by final/url host when no referrer is present', () => {
    const agents: ActiveAgentTab[] = [
      { tabId: 1, originUrl: 'https://files.example.com/' },
      { tabId: 2, originUrl: 'https://other.com/' },
    ];
    const a = attributeDownload(info({ referrer: undefined }), agents);
    expect(a.tabId).toBe(1);
    expect(a.level).toBe('host');
  });

  it('marks attribution uncertain with multiple unmatched agents', () => {
    const agents: ActiveAgentTab[] = [
      { tabId: 1, originUrl: 'https://a.com/' },
      { tabId: 2, originUrl: 'https://b.com/' },
    ];
    const a = attributeDownload(
      info({ referrer: 'https://c.com/', finalUrl: 'https://c.com/x', url: 'https://c.com/x' }),
      agents,
    );
    expect(a.level).toBe('none');
    expect([1, 2]).toContain(a.tabId);
  });

  it('compares scheme, host and port, not the bare host name', () => {
    const agents: ActiveAgentTab[] = [{ tabId: 3, originUrl: 'http://localhost:3000/app' }];
    const otherPort = info({ url: 'http://localhost:8080/export.csv', finalUrl: undefined, referrer: 'http://localhost:8080/' });
    expect(attributeDownload(otherPort, agents).level).toBe('none');
    const otherScheme = info({ url: 'https://localhost:3000/x', finalUrl: undefined, referrer: undefined });
    expect(attributeDownload(otherScheme, agents).level).toBe('none');
    const sameOrigin = info({ url: 'http://localhost:3000/export.csv', finalUrl: undefined, referrer: undefined });
    expect(attributeDownload(sameOrigin, agents)).toEqual({ tabId: 3, level: 'host', matchedHost: 'localhost:3000' });
  });

  it('a download start reported in an agent tab is tab-level, ahead of any host match', () => {
    const agents: ActiveAgentTab[] = [
      { tabId: 4, originUrl: 'https://files.example.com/' },
      { tabId: 8, originUrl: 'about:blank' },
    ];
    const start: TabDownloadStart = { tabId: 8, frameId: 'F1', guid: 'g1', url: 'https://files.example.com/a.txt', at: 0 };
    expect(attributeDownload(info(), agents, start)).toEqual({ tabId: 8, level: 'tab', frameId: 'F1' });
  });

  it("matches against the page now open in the agent's tab, falling back to the first-seen page", () => {
    const moved: ActiveAgentTab[] = [{ tabId: 3, originUrl: 'https://a.example.com/start', pageOrigin: 'https://b.example.com' }];
    const fromNewSite = info({ url: 'https://b.example.com/export.zip', finalUrl: undefined, referrer: undefined });
    expect(attributeDownload(fromNewSite, moved)).toEqual({ tabId: 3, level: 'host', matchedHost: 'b.example.com' });
    const fromOldSite = info({ url: 'https://a.example.com/x.pdf', finalUrl: undefined, referrer: undefined });
    expect(attributeDownload(fromOldSite, moved).level).toBe('none');
    const opaquePage: ActiveAgentTab[] = [{ tabId: 3, originUrl: 'https://a.example.com/start', pageOrigin: null }];
    expect(attributeDownload(fromOldSite, opaquePage).level).toBe('none');
    const unrecorded: ActiveAgentTab[] = [{ tabId: 3, originUrl: 'https://a.example.com/start' }];
    expect(attributeDownload(fromOldSite, unrecorded).level).toBe('host');
  });

  it('a download start in a tab with no registered agent is not tab-level', () => {
    const agents: ActiveAgentTab[] = [{ tabId: 4, originUrl: 'https://nomatch.example/' }];
    const start: TabDownloadStart = { tabId: 99, frameId: 'F1', guid: 'g1', url: 'https://files.example.com/a.txt', at: 0 };
    expect(attributeDownload(info(), agents, start).level).toBe('none');
  });

  it('a download start in the tab of an attachment seen while DevTools was open is at most a host match', () => {
    const start: TabDownloadStart = { tabId: 8, frameId: 'F1', guid: 'g1', url: 'https://files.example.com/a.txt', at: 0 };
    const inspected: ActiveAgentTab[] = [{ tabId: 8, originUrl: 'https://files.example.com/app', devToolsOnly: true }];
    expect(attributeDownload(info(), inspected, start)).toEqual({ tabId: 8, level: 'host', matchedHost: 'files.example.com' });
    const elsewhere: ActiveAgentTab[] = [{ tabId: 8, originUrl: 'https://other.example.org/', devToolsOnly: true }];
    expect(attributeDownload(info(), elsewhere, start)).toEqual({ tabId: 8, level: 'none' });
  });
});

describe('originOf', () => {
  it('returns the origin, or null for opaque and unparseable URLs', () => {
    expect(originOf('https://a.example:8443/x?y')).toBe('https://a.example:8443');
    expect(originOf('about:blank')).toBeNull();
    expect(originOf('file:///Users/me/page.html')).toBeNull();
    expect(originOf('data:text/plain,hi')).toBeNull();
    expect(originOf('not a url')).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});

describe('matchTabDownloadStart', () => {
  const start = (over: Partial<TabDownloadStart>): TabDownloadStart => ({
    tabId: 1, frameId: 'F', guid: 'g', url: 'https://files.example.com/a.txt', at: 1_000, ...over,
  });

  it('matches on the item URL or its final URL', () => {
    const item = { url: 'https://files.example.com/redirect', finalUrl: 'https://cdn.example.net/a.txt' };
    expect(matchTabDownloadStart([start({ url: 'https://files.example.com/redirect' })], item, 1_000)?.guid).toBe('g');
    expect(matchTabDownloadStart([start({ url: 'https://cdn.example.net/a.txt' })], item, 1_000)?.guid).toBe('g');
    expect(matchTabDownloadStart([start({ url: 'https://files.example.com/other' })], item, 1_000)).toBeNull();
  });

  it('matches only inside the window, in either order', () => {
    const item = { url: 'https://files.example.com/a.txt' };
    const s = [start({ at: 10_000 })];
    expect(matchTabDownloadStart(s, item, 10_000 + TAB_DOWNLOAD_START_WINDOW_MS)).not.toBeNull();
    expect(matchTabDownloadStart(s, item, 10_000 - TAB_DOWNLOAD_START_WINDOW_MS)).not.toBeNull();
    expect(matchTabDownloadStart(s, item, 10_000 + TAB_DOWNLOAD_START_WINDOW_MS + 1)).toBeNull();
  });

  it('picks the earliest of two starts for the same URL', () => {
    const item = { url: 'https://files.example.com/a.txt' };
    const s = [start({ guid: 'later', tabId: 2, at: 1_500 }), start({ guid: 'first', tabId: 1, at: 1_200 })];
    expect(matchTabDownloadStart(s, item, 2_000)?.guid).toBe('first');
  });
});

describe('describeDownload', () => {
  it('uses the basename of the filename', () => {
    expect(describeDownload(info({ filename: '/tmp/dl/agent-download.txt' }))).toBe('agent-download.txt');
  });

  it('falls back to the host when no filename', () => {
    expect(describeDownload(info({ filename: undefined }))).toBe('files.example.com');
  });
});
