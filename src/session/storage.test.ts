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
  getKillSwitchState,
  saveKillSwitchState,
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

  it('does not lose concurrent saves within the limit (race)', async () => {
    const sessions = Array.from({ length: 5 }, (_, i) => makeSession(`p${i}`));
    await Promise.all(sessions.map((s) => saveSession(s)));
    const stored = await getSessions();
    expect(stored).toHaveLength(5);
    expect(new Set(stored.map((s) => s.id)).size).toBe(5);
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

  it('does not lose entries under concurrent appends (read-modify-write race)', async () => {
    // Fire many appends without awaiting between them. Each does a full
    // read-modify-write; without serialization, later writes clobber earlier
    // ones and entries vanish. The storage mutex must preserve all of them.
    const events = Array.from({ length: 25 }, (_, i) => makeDetectionEvent(`c${i}`));
    await Promise.all(events.map((e) => appendDetectionLog(e)));

    const state = await getStorageState();
    expect(state.detectionLog).toHaveLength(25);
    const ids = new Set(state.detectionLog.map((e) => e.id));
    expect(ids.size).toBe(25);
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

describe('kill-switch persistence (regression: fail-open on SW restart)', () => {
  it('defaults to inactive when nothing is persisted', async () => {
    await clearAllStorage();
    const ks = await getKillSwitchState();
    expect(ks.isActive).toBe(false);
    expect(ks.lastEvent).toBeNull();
    expect(ks.lastActivatedAt).toBeNull();
  });

  it('round-trips an active kill switch so a restart can rehydrate it', async () => {
    await clearAllStorage();
    await saveKillSwitchState({
      isActive: true,
      lastEvent: null,
      lastActivatedAt: '2026-06-03T00:00:00.000Z',
    });
    // Simulates a fresh service-worker cold start reading persisted state.
    const ks = await getKillSwitchState();
    expect(ks.isActive).toBe(true);
    expect(ks.lastActivatedAt).toBe('2026-06-03T00:00:00.000Z');
  });

  it('persists a reset so a later restart does not re-arm', async () => {
    await saveKillSwitchState({ isActive: true, lastEvent: null, lastActivatedAt: 'x' });
    await saveKillSwitchState({ isActive: false, lastEvent: null, lastActivatedAt: null });
    const ks = await getKillSwitchState();
    expect(ks.isActive).toBe(false);
  });

  it('falls back to inactive on a corrupt persisted value', async () => {
    await chrome.storage.local.set({ killSwitchState: 'not-an-object' });
    const ks = await getKillSwitchState();
    expect(ks.isActive).toBe(false);
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

  it('only writes back the corrupted keys, leaving healthy keys untouched', async () => {
    // Seed: sessions is corrupt, delegationRules is healthy, settings is healthy.
    const goodRules = [
      { id: 'rule-keep', preset: 'readOnly' as const, scope: { sitePatterns: [], actionRestrictions: [], timeBound: null }, createdAt: '', isActive: true },
    ];
    const goodSettings = { ...DEFAULT_SETTINGS, detectionEnabled: false };
    await chrome.storage.local.set({
      storageSchemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      sessions: 'corrupt',
      delegationRules: goodRules,
      settings: goodSettings,
    });

    // Clear the seed call from the history so we only inspect what
    // getStorageState writes itself.
    (chrome.storage.local.set as unknown as { mockClear: () => void }).mockClear();

    await getStorageState();

    // Use the .mock.calls history to inspect every set() call argument.
    // The corruption-recovery write-back is the call that does NOT contain
    // the corruption log key — distinguish it from the bounded log write.
    const allCalls = (chrome.storage.local.set as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const writes = allCalls.map((c) => c[0] as Record<string, unknown>);
    const recoveryWrites = writes.filter((c) => !('__corrupted_state' in c));
    // Should be at most one recovery write, and it MUST only include the
    // corrupted key ('sessions'), not 'delegationRules' or 'settings'.
    expect(recoveryWrites.length).toBeLessThanOrEqual(1);
    if (recoveryWrites.length === 1) {
      const keys = Object.keys(recoveryWrites[0]);
      expect(keys).toContain('sessions');
      expect(keys).not.toContain('delegationRules');
      expect(keys).not.toContain('settings');
    }

    // And the healthy values are still in storage afterwards.
    const after = await chrome.storage.local.get(['delegationRules', 'settings']);
    expect(after.delegationRules).toEqual(goodRules);
    expect((after.settings as { detectionEnabled: boolean }).detectionEnabled).toBe(false);
  });

  it('does NOT write a lower storageSchemaVersion back on downgrade', async () => {
    const futureVersion = CURRENT_STORAGE_SCHEMA_VERSION + 5;
    await chrome.storage.local.set({
      storageSchemaVersion: futureVersion,
      sessions: [],
    });
    await getStorageState();
    const after = await chrome.storage.local.get('storageSchemaVersion');
    expect(after.storageSchemaVersion).toBe(futureVersion);
  });

  it('rejects http:// aimBaseUrl in settings and resets to default', async () => {
    await chrome.storage.local.set({
      storageSchemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      settings: { ...DEFAULT_SETTINGS, aimBaseUrl: 'http://attacker.example' },
    });
    const state = await getStorageState();
    expect(state.settings.aimBaseUrl).toBe(DEFAULT_SETTINGS.aimBaseUrl);
    const corruption = await chrome.storage.local.get('__corrupted_state');
    const log = corruption.__corrupted_state as Array<{ key: string; reason: string }>;
    expect(log.some((e) => e.reason.includes('aimBaseUrl'))).toBe(true);
  });

  it('rejects javascript: scheme in registryBaseUrl and resets to default', async () => {
    await chrome.storage.local.set({
      storageSchemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      settings: { ...DEFAULT_SETTINGS, registryBaseUrl: 'javascript:alert(1)' },
    });
    const state = await getStorageState();
    expect(state.settings.registryBaseUrl).toBe(DEFAULT_SETTINGS.registryBaseUrl);
  });

  it('rejects array-typed aimBaseUrl (not a string) and resets to default', async () => {
    await chrome.storage.local.set({
      storageSchemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      settings: { ...DEFAULT_SETTINGS, aimBaseUrl: ['http://attacker'] },
    });
    const state = await getStorageState();
    expect(state.settings.aimBaseUrl).toBe(DEFAULT_SETTINGS.aimBaseUrl);
  });

  it('rejects non-boolean detectionEnabled and resets to default', async () => {
    await chrome.storage.local.set({
      storageSchemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      settings: { ...DEFAULT_SETTINGS, detectionEnabled: 'yes' },
    });
    const state = await getStorageState();
    expect(state.settings.detectionEnabled).toBe(DEFAULT_SETTINGS.detectionEnabled);
  });

  it('accepts a fully valid settings object without rewriting', async () => {
    const sane = { ...DEFAULT_SETTINGS, detectionEnabled: false, aimBaseUrl: 'https://aim.example.com' };
    await chrome.storage.local.set({
      storageSchemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      settings: sane,
    });
    (chrome.storage.local.set as unknown as { mockClear: () => void }).mockClear();
    const state = await getStorageState();
    expect(state.settings.detectionEnabled).toBe(false);
    expect(state.settings.aimBaseUrl).toBe('https://aim.example.com');
    const allCalls = (chrome.storage.local.set as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const writes = allCalls.map((c) => c[0] as Record<string, unknown>);
    const recovery = writes.filter((c) => !('__corrupted_state' in c));
    expect(recovery).toEqual([]);
  });
});
