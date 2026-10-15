/**
 * Where a boundary violation is recorded, and what the privacy policy says
 * about it.
 *
 * A tab is given the session delegation whether or not an agent was detected
 * in it, and an untrusted event there is blocked under that rule. Such a tab
 * has no session, so its violation has no session log to go in: it is held
 * only in the in-memory list the popup reads. The policy once said each
 * violation is recorded in its session log.
 *
 * Driven through the real background worker and the repository's chrome mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { chromeMock } from '../__tests__/setup';
import { createRuleFromPreset } from '../delegation/rules';
import type { AgentSession } from '../session/types';
import type { BoundaryViolation } from '../types/events';

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;

const POPUP = { id: 'test-id', url: 'chrome-extension://test-id/dist/popup/index.html' };
const AGENT_TAB = 7;
const AGENT_URL = 'https://shop.example.com/cart';
const OTHER_TAB = 8;
const OTHER_URL = 'https://news.example.org/today';

const step = (ms = 10) => vi.advanceTimersByTimeAsync(ms);

function tabSender(tabId: number, url: string) {
  return { id: 'test-id', tab: { id: tabId }, frameId: 0, url, origin: new URL(url).origin };
}

async function loadWorker(): Promise<Listener> {
  const downloads = chromeMock.downloads as unknown as Record<string, unknown>;
  downloads.onCreated = { addListener: vi.fn(), removeListener: vi.fn() };
  chromeMock.runtime.onMessage.addListener.mockClear();
  await import('./index');
  await step();
  const calls = chromeMock.runtime.onMessage.addListener.mock.calls;
  return calls[calls.length - 1][0] as Listener;
}

/** A Read-Only session delegation is active and an agent is detected in AGENT_TAB only. */
async function workerWithOneAgent(): Promise<Listener> {
  const h = await loadWorker();
  h({ type: 'DELEGATION_UPDATE', data: createRuleFromPreset('readOnly') }, POPUP, vi.fn());
  await step();

  const agent = { id: 'a1', type: 'playwright', detectionMethods: ['framework-fingerprint'], confidence: 'confirmed',
    detectedAt: new Date().toISOString(), originUrl: AGENT_URL, observedCapabilities: [], isActive: true };
  h({ type: 'DETECTION_RESULT', data: { id: 'det-a1', timestamp: new Date().toISOString(),
    methods: ['framework-fingerprint'], confidence: 'confirmed', agent, url: AGENT_URL, signals: {} } },
  tabSender(AGENT_TAB, AGENT_URL), vi.fn());
  await step();
  return h;
}

async function blockTextInput(h: Listener, tabId: number, url: string, id: string): Promise<void> {
  const violation: BoundaryViolation = {
    id,
    timestamp: new Date().toISOString(),
    agentId: '',
    attemptedAction: 'type-text',
    url,
    targetSelector: '#q',
    blockingRuleId: 'rule',
    reason: 'Delegation does not permit text input',
    userOverride: false,
  };
  h({ type: 'BOUNDARY_CHECK_REQUEST', data: violation }, tabSender(tabId, url), vi.fn());
  await step();
}

/** The ids in the in-memory list the popup's Violations panel reads. */
function recentViolationIds(h: Listener): string[] {
  const respond = vi.fn();
  h({ type: 'STATUS_QUERY', data: {} }, POPUP, respond);
  const status = respond.mock.calls[0][0] as { recentViolations: Array<{ violation: BoundaryViolation }> };
  return status.recentViolations.map((alert) => alert.violation.id);
}

/** The address of each violation written to a stored session log. */
async function storedViolationUrls(): Promise<string[]> {
  const { sessions } = (await chromeMock.storage.local.get('sessions')) as { sessions?: AgentSession[] };
  expect(sessions, 'the detected agent must have a stored session').toHaveLength(1);
  return sessions![0].events.filter((e) => e.type === 'boundary-violation').map((e) => e.url);
}

/** The text of the policy's "Violation records" list item. */
function policyViolationRecords(): string {
  const html = readFileSync(new URL('../../docs/privacy-policy.html', import.meta.url), 'utf-8');
  const start = html.indexOf('<li><strong>Violation records');
  expect(start, 'no list item labelled "Violation records" in the policy').toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf('</li>', start));
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  await chromeMock.storage.local.clear();
  (chromeMock as unknown as Record<string, unknown>).debugger = undefined;
  delete (chromeMock.tabs as unknown as Record<string, unknown>).get;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('where a boundary violation is recorded', () => {
  it('a violation in a tab where no agent was detected reaches the popup list and no session log', async () => {
    const h = await workerWithOneAgent();

    await blockTextInput(h, OTHER_TAB, OTHER_URL, 'v-other');

    expect(recentViolationIds(h)).toEqual(['v-other']);
    expect(await storedViolationUrls()).toEqual([]);

    const item = policyViolationRecords();
    expect(item).toContain(
      'A violation in a tab with no session, such as a tab where no agent was detected, is recorded in no session log.',
    );
    expect(item).toContain('violations from any tab are held in memory, not saved');
    expect(item).not.toMatch(/Each boundary violation/i);
  });

  // #122: the README stated the scope of enforcement without saying that a
  // session delegation governs a tab with no detected agent, where a block is
  // shown with no detection to explain it.
  it('a tab where no agent was detected is given the session delegation, and a block there adds no detection', async () => {
    const h = await workerWithOneAgent();

    const respond = vi.fn();
    h({ type: 'TAB_STATE_QUERY', data: {} }, tabSender(OTHER_TAB, OTHER_URL), respond);
    await step();
    expect((respond.mock.calls[0][0] as { effectiveRule: { preset: string } | null }).effectiveRule?.preset).toBe('readOnly');

    chromeMock.notifications.create.mockClear();
    chromeMock.action.setBadgeText.mockClear();
    await blockTextInput(h, OTHER_TAB, OTHER_URL, 'v-other');

    const titles = (chromeMock.notifications.create.mock.calls as unknown as Array<[string, { title?: string }]>)
      .map(([, options]) => options.title);
    expect(titles).toEqual(['AI Browser Guard - Text input blocked']);
    const badges = (chromeMock.action.setBadgeText.mock.calls as unknown as Array<[{ text: string }]>).map(([b]) => b.text);
    expect(badges[badges.length - 1]).toBe('!');
    expect(recentViolationIds(h)).toEqual(['v-other']);

    const { detectionLog } = (await chromeMock.storage.local.get('detectionLog')) as { detectionLog?: Array<{ url: string }> };
    expect((detectionLog ?? []).map((entry) => entry.url)).toEqual([AGENT_URL]);

    // The note that follows the README's scope note says so in short and
    // links the scope of enforcement page, which says what you see.
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf-8');
    const scope = readme.indexOf('> **Scope of enforcement.**');
    expect(scope, 'the README must keep its "Scope of enforcement" note').toBeGreaterThanOrEqual(0);
    const start = readme.indexOf('\n\n', scope) + 2;
    expect(
      readme.startsWith('> **Tabs with no detected agent.**', start),
      'the README must follow its "Scope of enforcement" note with the "Tabs with no detected agent" note',
    ).toBe(true);
    const note = readme.slice(start, readme.indexOf('\n\n', start));
    expect(note).toContain('A session delegation is the rule in a tab where no agent was detected too');
    expect(note).toContain('(docs/enforcement-scope.md#tabs-with-no-detected-agent)');

    const page = readFileSync(new URL('../../docs/enforcement-scope.md', import.meta.url), 'utf-8');
    const heading = page.indexOf('\n## Tabs with no detected agent\n');
    expect(heading, 'docs/enforcement-scope.md must keep its "Tabs with no detected agent" section').toBeGreaterThanOrEqual(0);
    const end = page.indexOf('\n## ', heading + 1);
    const section = page.slice(heading, end === -1 ? undefined : end);
    expect(section).toContain('A session delegation is the rule in a tab where no agent was detected too');
    expect(section).toContain(
      'you get the block notification, the toolbar badge shows `!` and the block is listed in the popup, while nothing is added to the detection log or to a session log',
    );
  });

  it("a violation in a detected agent's tab is also written to that agent's session log", async () => {
    const h = await workerWithOneAgent();

    await blockTextInput(h, AGENT_TAB, AGENT_URL, 'v-agent');

    expect(recentViolationIds(h)).toEqual(['v-agent']);
    expect(await storedViolationUrls()).toEqual([AGENT_URL]);

    expect(policyViolationRecords()).toContain(
      "in a tab during a detected agent's session is recorded in that session's log",
    );
  });
});
