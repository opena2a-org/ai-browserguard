import { describe, it, expect } from 'vitest';
import {
  createTimelineEvent,
  appendEventToSession,
  computeSessionSummary,
  filterTimelineEvents,
  getRecentEvents,
  MAX_SESSION_EVENTS,
  MAX_STORED_URL_LENGTH,
  MAX_STORED_SELECTOR_LENGTH,
} from './timeline';
import type { AgentSession } from './types';
import type { AgentIdentity } from '../types/agent';

function makeSession(): AgentSession {
  const agent: AgentIdentity = {
    id: 'agent-1',
    type: 'unknown',
    detectionMethods: [],
    confidence: 'low',
    detectedAt: new Date().toISOString(),
    originUrl: 'https://example.com',
    observedCapabilities: [],
    isActive: true,
  };
  return {
    id: 'session-1',
    agent,
    delegationRule: null,
    events: [],
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    summary: {
      totalActions: 0,
      allowedActions: 0,
      blockedActions: 0,
      violations: 0,
      topUrls: [],
      durationSeconds: null,
    },
  };
}

describe('createTimelineEvent', () => {
  it('creates an event with defaults', () => {
    const event = createTimelineEvent('detection', 'https://example.com', 'Agent detected');
    expect(event.id).toBeTruthy();
    expect(event.type).toBe('detection');
    expect(event.url).toBe('https://example.com');
    expect(event.description).toBe('Agent detected');
    expect(event.outcome).toBe('informational');
    expect(event.timestamp).toBeTruthy();
  });

  it('accepts optional fields', () => {
    const event = createTimelineEvent('action-blocked', 'https://example.com', 'Click blocked', {
      targetSelector: '#submit-btn',
      attemptedAction: 'click',
      outcome: 'blocked',
      ruleId: 'rule-1',
    });
    expect(event.outcome).toBe('blocked');
    expect(event.targetSelector).toBe('#submit-btn');
    expect(event.attemptedAction).toBe('click');
    expect(event.ruleId).toBe('rule-1');
  });
});

describe('appendEventToSession', () => {
  it('appends event and updates summary', () => {
    const session = makeSession();
    const event = createTimelineEvent('action-allowed', 'https://example.com', 'Navigate', {
      outcome: 'allowed',
    });
    const updated = appendEventToSession(session, event);
    expect(updated.events).toHaveLength(1);
    expect(updated.summary.totalActions).toBe(1);
    expect(updated.summary.allowedActions).toBe(1);
  });

  it('does not mutate original session', () => {
    const session = makeSession();
    const event = createTimelineEvent('action-allowed', 'https://example.com', 'Navigate', {
      outcome: 'allowed',
    });
    appendEventToSession(session, event);
    expect(session.events).toHaveLength(0);
  });

  // Regression (#126): a tab's session stays open while the tab does, and
  // every action was appended with no limit.
  it(`keeps the ${MAX_SESSION_EVENTS} most recent events besides detections, and counts the ones it drops`, () => {
    let session = appendEventToSession(makeSession(), createTimelineEvent('detection', 'https://example.com', 'Agent detected'));
    session = appendEventToSession(session, createTimelineEvent('boundary-violation', 'https://example.com', 'Violation', {
      outcome: 'blocked',
    }));
    for (let i = 1; i <= MAX_SESSION_EVENTS + 50; i++) {
      session = appendEventToSession(session, createTimelineEvent('action-allowed', 'https://example.com', `click ${i}`, {
        outcome: 'allowed',
      }));
    }

    expect(session.events).toHaveLength(MAX_SESSION_EVENTS + 1);
    expect(session.events[0].type).toBe('detection');
    expect(session.events[1].description).toBe('click 51');
    expect(session.events[session.events.length - 1].description).toBe(`click ${MAX_SESSION_EVENTS + 50}`);
    expect(session.summary).toMatchObject({
      totalActions: MAX_SESSION_EVENTS + 51,
      allowedActions: MAX_SESSION_EVENTS + 50,
      blockedActions: 1,
      violations: 1,
    });
  });

  it('stores a page address and target selector cut to a fixed length', () => {
    const event = createTimelineEvent('action-allowed', `https://example.com/?q=${'a'.repeat(5000)}`, 'click allowed', {
      targetSelector: `#${'b'.repeat(5000)}`,
      outcome: 'allowed',
    });
    const [stored] = appendEventToSession(makeSession(), event).events;
    expect(stored.url).toHaveLength(MAX_STORED_URL_LENGTH);
    expect(stored.url.endsWith('a…')).toBe(true);
    expect(stored.targetSelector).toHaveLength(MAX_STORED_SELECTOR_LENGTH);
    expect(stored.targetSelector!.endsWith('b…')).toBe(true);
  });

  it('stores an address and selector within the limits as they are', () => {
    const event = createTimelineEvent('action-allowed', 'https://example.com/cart', 'click allowed', {
      targetSelector: '#submit-btn',
      outcome: 'allowed',
    });
    const [stored] = appendEventToSession(makeSession(), event).events;
    expect(stored.url).toBe('https://example.com/cart');
    expect(stored.targetSelector).toBe('#submit-btn');
  });
});

describe('computeSessionSummary', () => {
  it('counts actions by outcome', () => {
    const events = [
      createTimelineEvent('action-allowed', 'https://a.com', 'a', { outcome: 'allowed' }),
      createTimelineEvent('action-allowed', 'https://a.com', 'b', { outcome: 'allowed' }),
      createTimelineEvent('action-blocked', 'https://b.com', 'c', { outcome: 'blocked' }),
      createTimelineEvent('boundary-violation', 'https://b.com', 'd', { outcome: 'blocked' }),
    ];
    const summary = computeSessionSummary(events, events[0].timestamp);
    expect(summary.totalActions).toBe(4);
    expect(summary.allowedActions).toBe(2);
    expect(summary.blockedActions).toBe(2);
    expect(summary.violations).toBe(1);
  });

  it('computes top URLs by frequency, reduced to hostname only', () => {
    const events = [
      createTimelineEvent('action-allowed', 'https://a.com', 'a', { outcome: 'allowed' }),
      createTimelineEvent('action-allowed', 'https://b.com', 'b', { outcome: 'allowed' }),
      createTimelineEvent('action-allowed', 'https://a.com', 'c', { outcome: 'allowed' }),
      createTimelineEvent('action-allowed', 'https://a.com', 'd', { outcome: 'allowed' }),
      createTimelineEvent('action-allowed', 'https://b.com', 'e', { outcome: 'allowed' }),
    ];
    const summary = computeSessionSummary(events, events[0].timestamp);
    expect(summary.topUrls[0]).toBe('a.com');
    expect(summary.topUrls[1]).toBe('b.com');
  });

  it('stores only the hostname in topUrls — no path, query, or credentials', () => {
    const events = [
      createTimelineEvent('action-allowed', 'https://app.example.com/account?token=secret123', 'a', { outcome: 'allowed' }),
      createTimelineEvent('action-allowed', 'https://user:pass@app.example.com/login', 'b', { outcome: 'allowed' }),
    ];
    const summary = computeSessionSummary(events, events[0].timestamp);
    // Both events share the hostname, so it collapses to a single entry.
    expect(summary.topUrls).toEqual(['app.example.com']);
    for (const entry of summary.topUrls) {
      expect(entry).not.toContain('/');
      expect(entry).not.toContain('?');
      expect(entry).not.toContain('token');
      expect(entry).not.toContain('secret');
      expect(entry).not.toContain('pass');
    }
  });

  it('drops malformed URLs rather than storing them verbatim', () => {
    const events = [
      createTimelineEvent('action-allowed', 'not a url', 'a', { outcome: 'allowed' }),
      createTimelineEvent('action-allowed', 'https://valid.example.com/path', 'b', { outcome: 'allowed' }),
    ];
    const summary = computeSessionSummary(events, events[0].timestamp);
    expect(summary.topUrls).toEqual(['valid.example.com']);
  });

  it('handles empty events', () => {
    const summary = computeSessionSummary([], new Date().toISOString());
    expect(summary.totalActions).toBe(0);
    expect(summary.durationSeconds).toBeNull();
    expect(summary.topUrls).toEqual([]);
  });
});

describe('filterTimelineEvents', () => {
  it('filters by type', () => {
    const events = [
      createTimelineEvent('detection', 'https://a.com', 'detect'),
      createTimelineEvent('action-allowed', 'https://a.com', 'allow', { outcome: 'allowed' }),
      createTimelineEvent('action-blocked', 'https://b.com', 'block', { outcome: 'blocked' }),
    ];
    const filtered = filterTimelineEvents(events, { type: 'action-allowed' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].type).toBe('action-allowed');
  });

  it('filters by outcome', () => {
    const events = [
      createTimelineEvent('action-allowed', 'https://a.com', 'a', { outcome: 'allowed' }),
      createTimelineEvent('action-blocked', 'https://a.com', 'b', { outcome: 'blocked' }),
    ];
    const filtered = filterTimelineEvents(events, { outcome: 'blocked' });
    expect(filtered).toHaveLength(1);
  });

  it('combines filters with AND logic', () => {
    const events = [
      createTimelineEvent('action-allowed', 'https://a.com', 'a', { outcome: 'allowed' }),
      createTimelineEvent('action-allowed', 'https://b.com', 'b', { outcome: 'allowed' }),
      createTimelineEvent('action-blocked', 'https://a.com', 'c', { outcome: 'blocked' }),
    ];
    const filtered = filterTimelineEvents(events, { url: 'https://a.com', outcome: 'allowed' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].description).toBe('a');
  });
});

describe('getRecentEvents', () => {
  it('returns last N events in reverse order', () => {
    const events = [
      createTimelineEvent('detection', 'https://a.com', 'first'),
      createTimelineEvent('detection', 'https://a.com', 'second'),
      createTimelineEvent('detection', 'https://a.com', 'third'),
    ];
    const recent = getRecentEvents(events, 2);
    expect(recent).toHaveLength(2);
    expect(recent[0].description).toBe('third');
    expect(recent[1].description).toBe('second');
  });

  it('handles count larger than array', () => {
    const events = [createTimelineEvent('detection', 'https://a.com', 'only')];
    const recent = getRecentEvents(events, 5);
    expect(recent).toHaveLength(1);
  });
});
