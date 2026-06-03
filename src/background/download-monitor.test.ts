import { describe, it, expect } from 'vitest';
import {
  shouldIgnoreDownload,
  attributeDownload,
  describeDownload,
  type DownloadInfo,
  type ActiveAgentTab,
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
    expect(a.tabId).toBe(7);
    expect(a.matchedByReferrer).toBe(true);
  });

  it('falls back to the sole active agent when no host matches', () => {
    const agents: ActiveAgentTab[] = [{ tabId: 9, originUrl: 'https://nomatch.com/' }];
    const a = attributeDownload(info({ referrer: undefined, finalUrl: undefined, url: 'data:text/plain;base64,AAA' }), agents);
    expect(a.tabId).toBe(9);
    expect(a.matchedByReferrer).toBe(false);
  });

  it('matches by final/url host when no referrer is present', () => {
    const agents: ActiveAgentTab[] = [
      { tabId: 1, originUrl: 'https://files.example.com/' },
      { tabId: 2, originUrl: 'https://other.com/' },
    ];
    const a = attributeDownload(info({ referrer: undefined }), agents);
    expect(a.tabId).toBe(1);
    expect(a.matchedByReferrer).toBe(true);
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
    expect(a.matchedByReferrer).toBe(false);
    expect([1, 2]).toContain(a.tabId);
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
