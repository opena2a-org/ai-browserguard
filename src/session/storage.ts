/**
 * Session persistence layer using chrome.storage.local.
 *
 * Manages reading and writing of sessions, delegation rules, settings,
 * and detection logs. Enforces session limits (5 sessions, 100 log entries).
 */

import type { AgentSession, StorageSchema, UserSettings, LifetimeStats } from './types';
import { DEFAULT_SETTINGS, DEFAULT_LIFETIME_STATS, CURRENT_STORAGE_SCHEMA_VERSION } from './types';
import type { DelegationRule } from '../types/delegation';
import type { DetectionEvent } from '../types/events';

const DEFAULT_STORAGE: StorageSchema = {
  storageSchemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
  sessions: [],
  delegationRules: [],
  settings: DEFAULT_SETTINGS,
  detectionLog: [],
};

const CORRUPTION_LOG_KEY = '__corrupted_state';
const MAX_CORRUPTION_LOG_ENTRIES = 50;

interface CorruptionLogEntry {
  timestamp: string;
  key: string;
  reason: string;
}

async function logCorruption(entries: CorruptionLogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    const existing = await chrome.storage.local.get(CORRUPTION_LOG_KEY);
    const prior = Array.isArray(existing[CORRUPTION_LOG_KEY])
      ? (existing[CORRUPTION_LOG_KEY] as CorruptionLogEntry[])
      : [];
    const merged = [...prior, ...entries];
    if (merged.length > MAX_CORRUPTION_LOG_ENTRIES) {
      merged.splice(0, merged.length - MAX_CORRUPTION_LOG_ENTRIES);
    }
    await chrome.storage.local.set({ [CORRUPTION_LOG_KEY]: merged });
  } catch (err) {
    console.error('[AI Browser Guard] Failed to log storage corruption:', err);
  }
}

/**
 * Run a migration from the stored version to CURRENT_STORAGE_SCHEMA_VERSION.
 * Currently a no-op scaffold: future version bumps add cases that mutate `data` in place.
 */
function migrateStorageShape(
  data: Record<string, unknown>,
  fromVersion: number
): { data: Record<string, unknown>; migrated: boolean } {
  let migrated = false;
  let version = fromVersion;
  while (version < CURRENT_STORAGE_SCHEMA_VERSION) {
    // Future: case `1`: migrate v1 → v2 by reshaping data.sessions, etc.
    version++;
    migrated = true;
  }
  return { data, migrated };
}

/**
 * Retrieve the full storage schema from chrome.storage.local.
 *
 * Validates each top-level key against an expected type. Invalid values are
 * reset to defaults and the corruption is logged under `__corrupted_state` so
 * users (and future debug tools) can see what was discarded. An unrecognized
 * `storageSchemaVersion` triggers the migration scaffold before validation.
 */
export async function getStorageState(): Promise<StorageSchema> {
  try {
    const result = await chrome.storage.local.get([
      'storageSchemaVersion',
      'sessions',
      'delegationRules',
      'settings',
      'detectionLog',
    ]);
    const corruption: CorruptionLogEntry[] = [];
    const now = new Date().toISOString();

    let workingData: Record<string, unknown> = { ...result };
    const storedVersion = typeof workingData.storageSchemaVersion === 'number'
      ? workingData.storageSchemaVersion
      : null;
    if (storedVersion === null && Object.keys(result).some((k) => result[k] !== undefined)) {
      // Existing data missing version — run migration scaffold from v0.
      corruption.push({ timestamp: now, key: 'storageSchemaVersion', reason: 'missing — ran migration scaffold from v0' });
      const { data } = migrateStorageShape(workingData, 0);
      workingData = data;
    } else if (storedVersion !== null && storedVersion < CURRENT_STORAGE_SCHEMA_VERSION) {
      corruption.push({ timestamp: now, key: 'storageSchemaVersion', reason: `migrated from v${storedVersion} to v${CURRENT_STORAGE_SCHEMA_VERSION}` });
      const { data } = migrateStorageShape(workingData, storedVersion);
      workingData = data;
    } else if (storedVersion !== null && storedVersion > CURRENT_STORAGE_SCHEMA_VERSION) {
      // Downgrade scenario — keep data as-is but record it.
      corruption.push({ timestamp: now, key: 'storageSchemaVersion', reason: `stored version v${storedVersion} is newer than runtime v${CURRENT_STORAGE_SCHEMA_VERSION}` });
    }

    const sessions = Array.isArray(workingData.sessions)
      ? (workingData.sessions as AgentSession[])
      : (workingData.sessions !== undefined
          ? (corruption.push({ timestamp: now, key: 'sessions', reason: `expected array, got ${typeof workingData.sessions}` }), DEFAULT_STORAGE.sessions)
          : DEFAULT_STORAGE.sessions);

    const delegationRules = Array.isArray(workingData.delegationRules)
      ? (workingData.delegationRules as DelegationRule[])
      : (workingData.delegationRules !== undefined
          ? (corruption.push({ timestamp: now, key: 'delegationRules', reason: `expected array, got ${typeof workingData.delegationRules}` }), DEFAULT_STORAGE.delegationRules)
          : DEFAULT_STORAGE.delegationRules);

    const detectionLog = Array.isArray(workingData.detectionLog)
      ? (workingData.detectionLog as DetectionEvent[])
      : (workingData.detectionLog !== undefined
          ? (corruption.push({ timestamp: now, key: 'detectionLog', reason: `expected array, got ${typeof workingData.detectionLog}` }), DEFAULT_STORAGE.detectionLog)
          : DEFAULT_STORAGE.detectionLog);

    const rawSettings = workingData.settings;
    const settingsObject = (rawSettings !== null && typeof rawSettings === 'object' && !Array.isArray(rawSettings))
      ? (rawSettings as Partial<UserSettings>)
      : (rawSettings !== undefined
          ? (corruption.push({ timestamp: now, key: 'settings', reason: `expected object, got ${Array.isArray(rawSettings) ? 'array' : typeof rawSettings}` }), {})
          : {});

    if (corruption.length > 0) {
      void logCorruption(corruption);
      // Persist the cleaned shape so the next read is consistent.
      await chrome.storage.local.set({
        storageSchemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
        sessions,
        delegationRules,
        settings: { ...DEFAULT_SETTINGS, ...settingsObject },
        detectionLog,
      });
    }

    return {
      storageSchemaVersion: CURRENT_STORAGE_SCHEMA_VERSION,
      sessions,
      delegationRules,
      settings: { ...DEFAULT_SETTINGS, ...settingsObject },
      detectionLog,
    };
  } catch (err) {
    console.error('[AI Browser Guard] Storage read error:', err);
    return { ...DEFAULT_STORAGE };
  }
}

/**
 * Save a new agent session to storage.
 * Enforces the limit of 5 sessions by evicting the oldest.
 */
export async function saveSession(session: AgentSession): Promise<void> {
  try {
    const state = await getStorageState();
    const sessions = [session, ...state.sessions];
    const maxSessions = state.settings.maxSessions ?? 5;
    if (sessions.length > maxSessions) {
      sessions.length = maxSessions;
    }
    await chrome.storage.local.set({ sessions });
  } catch (err) {
    console.error('[AI Browser Guard] Failed to save session:', err);
  }
}

/**
 * Update an existing session in storage.
 */
export async function updateSession(
  sessionId: string,
  updater: (session: AgentSession) => AgentSession
): Promise<void> {
  try {
    const state = await getStorageState();
    const index = state.sessions.findIndex((s) => s.id === sessionId);
    if (index === -1) {
      console.warn('[AI Browser Guard] Session not found:', sessionId);
      return;
    }
    state.sessions[index] = updater(state.sessions[index]);
    await chrome.storage.local.set({ sessions: state.sessions });
  } catch (err) {
    console.error('[AI Browser Guard] Failed to update session:', err);
  }
}

/**
 * Retrieve all stored sessions.
 */
export async function getSessions(): Promise<AgentSession[]> {
  const state = await getStorageState();
  return state.sessions;
}

/**
 * Save or update delegation rules in storage.
 */
export async function saveDelegationRules(rules: DelegationRule[]): Promise<void> {
  try {
    await chrome.storage.local.set({ delegationRules: rules });
  } catch (err) {
    console.error('[AI Browser Guard] Failed to save delegation rules:', err);
  }
}

/**
 * Retrieve all delegation rules from storage.
 */
export async function getDelegationRules(): Promise<DelegationRule[]> {
  const state = await getStorageState();
  return state.delegationRules;
}

/**
 * Append a detection event to the log.
 * Enforces the limit of 100 log entries by evicting the oldest.
 */
export async function appendDetectionLog(event: DetectionEvent): Promise<void> {
  try {
    const state = await getStorageState();
    const log = [...state.detectionLog, event];
    const maxEntries = state.settings.maxDetectionLogEntries ?? 100;
    if (log.length > maxEntries) {
      log.splice(0, log.length - maxEntries);
    }
    await chrome.storage.local.set({ detectionLog: log });
  } catch (err) {
    console.error('[AI Browser Guard] Failed to append detection log:', err);
  }
}

/**
 * Retrieve user settings from storage.
 */
export async function getSettings(): Promise<UserSettings> {
  const state = await getStorageState();
  return state.settings;
}

/**
 * Update user settings in storage (partial merge).
 */
export async function updateSettings(updates: Partial<UserSettings>): Promise<void> {
  try {
    const current = await getSettings();
    const merged = { ...current, ...updates };
    await chrome.storage.local.set({ settings: merged });
  } catch (err) {
    console.error('[AI Browser Guard] Failed to update settings:', err);
  }
}

/**
 * Retrieve lifetime protection stats from storage.
 */
export async function getLifetimeStats(): Promise<LifetimeStats> {
  try {
    const result = await chrome.storage.local.get('lifetimeStats');
    return { ...DEFAULT_LIFETIME_STATS, ...(result.lifetimeStats ?? {}) };
  } catch {
    return { ...DEFAULT_LIFETIME_STATS };
  }
}

/**
 * Update lifetime stats with an updater function.
 */
export async function updateLifetimeStats(
  updater: (stats: LifetimeStats) => LifetimeStats
): Promise<void> {
  try {
    const current = await getLifetimeStats();
    const updated = updater(current);
    await chrome.storage.local.set({ lifetimeStats: updated });
  } catch {
    // Best effort — stats are non-critical
  }
}

/**
 * Clear all stored data.
 */
export async function clearAllStorage(): Promise<void> {
  try {
    await chrome.storage.local.clear();
  } catch (err) {
    console.error('[AI Browser Guard] Failed to clear storage:', err);
  }
}
