/**
 * #69 regressions, driven through the real background worker and the
 * repository's chrome mock (the fixtures are the issue's reproduction):
 *
 *  - a user's own download in another tab is not cancelled while a CDP agent is
 *    active, when nothing ties it to the agent (the uncertain fallback, including
 *    an agent origin with no host, file://);
 *  - a download tied to the agent's own origin is still cancelled, external
 *    driver or not;
 *  - the popup's Allow writes the plain host to the rule it names, and says so
 *    when nothing was written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chromeMock } from '../__tests__/setup';
import { createRuleFromPreset } from '../delegation/rules';
import { matchUrlPattern } from '../url/match-pattern';

const POPUP_SENDER = { id: 'test-id', url: 'chrome-extension://test-id/dist/popup/index.html' };
const FILE_AGENT_URL = 'file:///private/var/folders/bv/ct3ql5_n7z333l6j5k/agent.html';

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;
type Rule = ReturnType<typeof createRuleFromPreset>;
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await flush();
}

function cdpDetection(originUrl: string) {
  return {
    id: 'det-1',
    timestamp: new Date().toISOString(),
    methods: ['cdp-connection'],
    confidence: 'high',
    agent: {
      id: 'agent-1',
      type: 'cdp-generic',
      detectionMethods: ['cdp-connection'],
      confidence: 'high',
      detectedAt: new Date().toISOString(),
      originUrl,
      observedCapabilities: [],
      isActive: true,
    },
    url: originUrl,
    signals: {},
  };
}

function contentSender(url: string) {
  let origin = 'null';
  try { origin = new URL(url).origin; } catch { /* file:// has an opaque origin */ }
  return { id: 'test-id', tab: { id: 42 }, frameId: 0, url, origin };
}

// The human's Google Slides export in a DIFFERENT tab (no agent there).
const HUMAN_DOWNLOAD = {
  id: 7,
  url: 'https://docs.google.com/presentation/d/abc/export/pdf',
  finalUrl: 'https://doc-00-a0-slides.googleusercontent.com/docs/securesc/x/deck.pdf',
  referrer: 'https://docs.google.com/',
  filename: '/home/user/Downloads/deck.pdf',
};

async function loadWorker() {
  const downloads = chromeMock.downloads as unknown as Record<string, unknown>;
  downloads.onCreated = { addListener: vi.fn(), removeListener: vi.fn() };
  const cancel = vi.fn((_id: number, cb?: () => void) => { cb?.(); });
  downloads.cancel = cancel;
  chromeMock.runtime.onMessage.addListener.mockClear();
  await import('./index');
  const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
  const handleMessage = calls[calls.length - 1][0] as Listener;
  const onCreated = (downloads.onCreated as { addListener: { mock: { calls: unknown[][] } } })
    .addListener.mock.calls[0][0] as (item: unknown) => Promise<void>;
  return { handleMessage, onCreated, cancel };
}

function send(handleMessage: Listener, type: string, data: unknown, sender: unknown = POPUP_SENDER) {
  const respond = vi.fn();
  const accepted = handleMessage({ type, data }, sender, respond);
  return { respond, accepted };
}

async function withAgentAndReadOnly(originUrl: string) {
  const w = await loadWorker();
  const det = send(w.handleMessage, 'DETECTION_RESULT', cdpDetection(originUrl), contentSender(originUrl));
  await settle(3);
  expect(det.respond).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  const rule = createRuleFromPreset('readOnly');
  send(w.handleMessage, 'DELEGATION_UPDATE', rule);
  await settle(3);
  return { ...w, rule };
}

function status(handleMessage: Listener) {
  const { respond } = send(handleMessage, 'STATUS_QUERY', {});
  return respond.mock.calls[0][0] as {
    recentViolations: Array<{ title: string }>;
    delegationRules: Rule[];
  };
}

beforeEach(async () => {
  vi.resetModules();
  await chromeMock.storage.local.clear();
});

describe('#69 download attribution', () => {
  it('does not cancel the user\'s own download while a file:// CDP agent is active (the reported case)', async () => {
    const w = await withAgentAndReadOnly(FILE_AGENT_URL);
    await w.onCreated(HUMAN_DOWNLOAD);
    await settle();
    expect(w.cancel).not.toHaveBeenCalled();
    expect(status(w.handleMessage).recentViolations.some((a) => a.title === 'Download blocked')).toBe(false);
  });

  it('does not cancel a download whose hosts match no agent origin (https agent, another site)', async () => {
    const w = await withAgentAndReadOnly('https://agent.example.com/run');
    await w.onCreated(HUMAN_DOWNLOAD);
    await settle();
    expect(w.cancel).not.toHaveBeenCalled();
  });

  it('still cancels a download tied to the agent\'s own origin, for an external (CDP) driver too', async () => {
    const w = await withAgentAndReadOnly('https://agent.example.com/run');
    await w.onCreated({
      id: 8,
      url: 'https://agent.example.com/files/report.pdf',
      finalUrl: 'https://agent.example.com/files/report.pdf',
      referrer: 'https://agent.example.com/run',
      filename: '/home/user/Downloads/report.pdf',
    });
    await settle();
    expect(w.cancel).toHaveBeenCalledTimes(1);
    expect(status(w.handleMessage).recentViolations.some((a) => a.title === 'Download blocked')).toBe(true);
  });
});

describe('#69 popup Allow (DOMAIN_WHITELIST)', () => {
  const DOMAIN = 'doc-00-a0-slides.googleusercontent.com';
  const BLOCKED_URL = `https://${DOMAIN}/docs/securesc/x/deck.pdf`;

  it('writes the plain host to the rule the popup names, and the pattern matches the blocked host', async () => {
    const w = await withAgentAndReadOnly(FILE_AGENT_URL);
    const r = send(w.handleMessage, 'DOMAIN_WHITELIST', { domain: DOMAIN, ruleId: w.rule.id });
    await settle();
    expect(r.accepted).toBe(true);
    expect(r.respond).toHaveBeenCalledWith({ success: true });
    const rule = status(w.handleMessage).delegationRules.find((x) => x.id === w.rule.id)!;
    expect(rule.scope.sitePatterns).toContainEqual({ pattern: DOMAIN, action: 'allow' });
    expect(matchUrlPattern(BLOCKED_URL, DOMAIN)).toBe(true);
  });

  it('writes to a named per-agent grant, not to the session-wide rule', async () => {
    const w = await withAgentAndReadOnly(FILE_AGENT_URL);
    const agentRule = createRuleFromPreset('readOnly', { agentId: 'agent-1' });
    send(w.handleMessage, 'DELEGATION_UPDATE', agentRule);
    await settle(3);
    const r = send(w.handleMessage, 'DOMAIN_WHITELIST', { domain: DOMAIN, ruleId: agentRule.id });
    await settle();
    expect(r.respond).toHaveBeenCalledWith({ success: true });
    const rules = status(w.handleMessage).delegationRules;
    expect(rules.find((x) => x.id === agentRule.id)!.scope.sitePatterns).toContainEqual({ pattern: DOMAIN, action: 'allow' });
    expect(rules.find((x) => x.id === w.rule.id)!.scope.sitePatterns).toEqual([]);
  });

  it('falls back to the session-wide rule when the named rule is not active', async () => {
    const w = await withAgentAndReadOnly(FILE_AGENT_URL);
    const r = send(w.handleMessage, 'DOMAIN_WHITELIST', { domain: DOMAIN, ruleId: 'no-such-rule' });
    await settle();
    expect(r.respond).toHaveBeenCalledWith({ success: true });
    const rule = status(w.handleMessage).delegationRules.find((x) => x.id === w.rule.id)!;
    expect(rule.scope.sitePatterns).toContainEqual({ pattern: DOMAIN, action: 'allow' });
  });

  it('does not add a duplicate on a second click', async () => {
    const w = await withAgentAndReadOnly(FILE_AGENT_URL);
    send(w.handleMessage, 'DOMAIN_WHITELIST', { domain: DOMAIN, ruleId: w.rule.id });
    await settle();
    send(w.handleMessage, 'DOMAIN_WHITELIST', { domain: DOMAIN, ruleId: w.rule.id });
    await settle();
    const rule = status(w.handleMessage).delegationRules.find((x) => x.id === w.rule.id)!;
    expect(rule.scope.sitePatterns.filter((p) => p.pattern === DOMAIN)).toHaveLength(1);
  });

  it('says so, and writes nothing, when there is no active delegation', async () => {
    const w = await loadWorker();
    const r = send(w.handleMessage, 'DOMAIN_WHITELIST', { domain: DOMAIN });
    await settle();
    expect(r.respond).toHaveBeenCalledWith({ success: false, reason: expect.any(String) });
    expect(status(w.handleMessage).delegationRules).toEqual([]);
  });

  it('refuses a value that is not a host name', async () => {
    const w = await withAgentAndReadOnly(FILE_AGENT_URL);
    for (const bad of ['*.example.com', 'https://example.com', '', 'a b.com', 'x'.repeat(300)]) {
      const r = send(w.handleMessage, 'DOMAIN_WHITELIST', { domain: bad, ruleId: w.rule.id });
      await settle();
      expect(r.respond).toHaveBeenCalledWith({ success: false, reason: expect.any(String) });
    }
    const rule = status(w.handleMessage).delegationRules.find((x) => x.id === w.rule.id)!;
    expect(rule.scope.sitePatterns).toEqual([]);
  });

  it('is still refused from a content script', async () => {
    const w = await withAgentAndReadOnly(FILE_AGENT_URL);
    const r = send(w.handleMessage, 'DOMAIN_WHITELIST', { domain: DOMAIN, ruleId: w.rule.id }, contentSender(FILE_AGENT_URL));
    await settle();
    expect(r.accepted).toBe(false);
    const rule = status(w.handleMessage).delegationRules.find((x) => x.id === w.rule.id)!;
    expect(rule.scope.sitePatterns).toEqual([]);
  });
});
