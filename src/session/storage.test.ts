import { describe, it, expect } from 'vitest';
import {
  getStorageState,
  saveSession,
  updateSession,
  getSessions,
  saveDelegationRules,
  getDelegationRules,
  appendDetectionLog,
  getSettings,
  updateSettings,
  clearAllStorage,
} from './storage';
import { DEFAULT_SETTINGS, CURRENT_STORAGE_SCHEMA_VERSION } from './types';
import type { AgentSession } from './types';
import type { AgentIdentity } from '../types/agent';
import type { DetectionEvent } from '../types/events';

function makeAgent(id: string): AgentIdentity {
  return {
    id,
    type: 'unknown',
    detectionMethods: [],
    confidence: 'low',
    detectedAt: new Date().toISOString(),
    originUrl: 'https://example.com',
    observedCapabilities: [],
    isActive: true,
  };
}

function makeSession(id: string): AgentSession {
  return {
    id,
    agent: makeAgent('agent-' + id),
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

function makeDetectionEvent(id: string): DetectionEvent {
  return {
    id,
    timestamp: new Date().toISOString(),
    methods: [],
    confidence: 'low',
    agent: null,
    url: 'https://example.com',
    signals: {},
  };
}

describe('getStorageState', () => {
  it('returns defaults when storage is empty', async () => {
    const state = await getStorageState();
    expect(state.sessions).toEqual([]);
    expect(state.delegationRules).toEqual([]);
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
    expect(state.detectionLog).toEqual([]);
  });
});

describe('saveSession / getSessions', () => {
  it('saves and retrieves a session', async () => {
    const session = makeSession('s1');
    await saveSession(session);
    const sessions = await getSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('s1');
  });

  it('prepends new sessions (newest first)', async () => {
    await saveSession(makeSession('s1'));
    await saveSession(makeSession('s2'));
    const sessions = await getSessions();
    expect(sessions[0].id).toBe('s2');
    expect(sessions[1].id).toBe('s1');
  });

  it('enforces maxSessions limit (default 5)', async () => {
    for (let i = 0; i < 7; i++) {
      await saveSession(makeSession(`s${i}`));
    }
    const sessions = await getSessions();
    expect(sessions.length).toBeLessThanOrEqual(5);
  });
});

describe('updateSession', () => {
  it('updates an existing session', async () => {
    await saveSession(makeSession('s1'));
    await updateSession('s1', (s) => ({
      ...s,
      endedAt: '2099-01-01T00:00:00Z',
      endReason: 'kill-switch',
    }));
    const sessions = await getSessions();
    expect(sessions[0].endedAt).toBe('2099-01-01T00:00:00Z');
    expect(sessions[0].endReason).toBe('kill-switch');
  });

  it('does nothing for non-existent session', async () => {
    await saveSession(makeSession('s1'));
    await updateSession('nonexistent', (s) => ({ ...s, endedAt: 'x' }));
    const sessions = await getSessions();
    expect(sessions[0].endedAt).toBeNull();
  });
});

describe('saveDelegationRules / getDelegationRules', () => {
  it('saves and retrieves rules', async () => {
    const rules = [
      { id: 'r1', preset: 'readOnly' as const, scope: { sitePatterns: [], actionRestrictions: [], timeBound: null }, createdAt: '', isActive: true },
    ];
    await saveDelegationRules(rules);
    const retrieved = await getDelegationRules();
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].id).toBe('r1');
  });
});

describe('appendDetectionLog', () => {
  it('appends events to the log', async () => {
    await appendDetectionLog(makeDetectionEvent('e1'));
    await appendDetectionLog(makeDetectionEvent('e2'));
    const state = await getStorageState();
    expect(state.detectionLog).toHaveLength(2);
  });

  it('trims log to maxDetectionLogEntries', async () => {
    // Set a lower limit for testing
    await updateSettings({ maxDetectionLogEntries: 3 });
    for (let i = 0; i < 5; i++) {
      await appendDetectionLog(makeDetectionEvent(`e${i}`));
    }
    const state = await getStorageState();
    expect(state.detectionLog.length).toBeLessThanOrEqual(3);
  });
});

describe('getSettings / updateSettings', () => {
  it('returns defaults initially', async () => {
    const settings = await getSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('merges partial updates', async () => {
    await updateSettings({ detectionEnabled: false });
    const settings = await getSettings();
    expect(settings.detectionEnabled).toBe(false);
    expect(settings.notificationsEnabled).toBe(true); // unchanged default
  });
});

describe('clearAllStorage', () => {
  it('clears all data', async () => {
    await saveSession(makeSession('s1'));
    await clearAllStorage();
    const state = await getStorageState();
    expect(state.sessions).toEqual([]);
  });
});

describe('storage schema version + corruption recovery', () => {
  it('tags an empty load with the current schema version', async () => {
    const state = await getStorageState();
    expect(state.storageSchemaVersion).toBe(CURRENT_STORAGE_SCHEMA_VERSION);
  });

  it('resets a non-array sessions value to default and logs the corruption', async () => {
    await chrome.storage.local.set({
      storageSchemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      sessions: 'not-an-array',
    });
    const state = await getStorageState();
    expect(state.sessions).toEqual([]);
    const corruption = await chrome.storage.local.get('__corrupted_state');
    const log = corruption.__corrupted_state as Array<{ key: string; reason: string }>;
    expect(log).toBeInstanceOf(Array);
    expect(log.some((e) => e.key === 'sessions' && e.reason.includes('expected array'))).toBe(true);
  });

  it('resets a non-array delegationRules value to default and logs the corruption', async () => {
    await chrome.storage.local.set({
      storageSchemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      delegationRules: { not: 'an-array' },
    });
    const state = await getStorageState();
    expect(state.delegationRules).toEqual([]);
    const corruption = await chrome.storage.local.get('__corrupted_state');
    const log = corruption.__corrupted_state as Array<{ key: string; reason: string }>;
    expect(log.some((e) => e.key === 'delegationRules')).toBe(true);
  });

  it('resets a non-object settings value to defaults and logs the corruption', async () => {
    await chrome.storage.local.set({
      storageSchemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      settings: 'corrupt-string',
    });
    const state = await getStorageState();
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
    const corruption = await chrome.storage.local.get('__corrupted_state');
    const log = corruption.__corrupted_state as Array<{ key: string; reason: string }>;
    expect(log.some((e) => e.key === 'settings' && e.reason.includes('expected object'))).toBe(true);
  });

  it('runs migration scaffold and logs when version is missing on existing data', async () => {
    // Pre-versioning data: sessions exist, no storageSchemaVersion.
    await chrome.storage.local.set({ sessions: [] });
    const state = await getStorageState();
    expect(state.storageSchemaVersion).toBe(CURRENT_STORAGE_SCHEMA_VERSION);
    const corruption = await chrome.storage.local.get('__corrupted_state');
    const log = corruption.__corrupted_state as Array<{ key: string; reason: string }>;
    expect(log.some((e) => e.key === 'storageSchemaVersion' && e.reason.includes('migration scaffold'))).toBe(true);
  });

  it('records a downgrade marker when stored version is newer than runtime', async () => {
    await chrome.storage.local.set({
      storageSchemaVersion: CURRENT_STORAGE_SCHEMA_VERSION + 5,
      sessions: [],
    });
    await getStorageState();
    const corruption = await chrome.storage.local.get('__corrupted_state');
    const log = corruption.__corrupted_state as Array<{ key: string; reason: string }>;
    expect(log.some((e) => e.key === 'storageSchemaVersion' && e.reason.includes('newer'))).toBe(true);
  });

  it('does not log corruption for a clean current-version load', async () => {
    await chrome.storage.local.set({
      storageSchemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      sessions: [],
      delegationRules: [],
      settings: DEFAULT_SETTINGS,
      detectionLog: [],
    });
    await getStorageState();
    const corruption = await chrome.storage.local.get('__corrupted_state');
    expect(corruption.__corrupted_state).toBeUndefined();
  });

  it('persists the cleaned shape after corruption is detected', async () => {
    await chrome.storage.local.set({
      storageSchemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      sessions: 'bad',
    });
    await getStorageState();
    const after = await chrome.storage.local.get('sessions');
    expect(after.sessions).toEqual([]);
  });
});
