/**
 * @vitest-environment jsdom
 *
 * What the privacy surfaces say about turning each optional network feature
 * off, checked against the switches the popup's Settings panel has.
 *
 * The privacy policy, the store copy and the privacy page said every optional
 * network feature could be turned off with one click, and the popup has no
 * switch for the registry trust lookup (#148, #151). Which features have a switch is
 * read from the rendered popup, not written into this file: with every feature
 * on, each switch in the Settings panel is clicked once, and the message it
 * sends shows which feature it turns off. The copy is checked against those
 * switches, not against a list kept here.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');

function read(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), 'utf-8');
}

/** The surfaces that describe the optional network features (ADR-006). */
const SURFACES = [
  'docs/privacy-policy.html',
  'docs/privacy.md',
  'README.md',
  'docs/chrome-web-store-description.md',
  'docs/store-listing.md',
  'docs/store-description-v0.5.0.txt',
];

interface SentMessage {
  type: string;
  data: unknown;
}

interface Feature {
  name: string;
  /** How a sentence on the surfaces names the feature. */
  named: RegExp;
  /** Whether a message the popup sent turns the feature off. */
  turnsOff: (message: SentMessage) => boolean;
  /** The stored setting a surface names when the feature has no switch. */
  setting?: string;
}

function setsSetting(message: SentMessage, key: string, value: boolean): boolean {
  return (
    message.type === 'SETTINGS_UPDATE' &&
    typeof message.data === 'object' &&
    message.data !== null &&
    (message.data as Record<string, unknown>)[key] === value
  );
}

const FEATURES: Feature[] = [
  {
    name: 'registry trust lookup',
    named: /\bregistry (?:trust )?lookup\b/i,
    turnsOff: (m) => setsSetting(m, 'registryLookupEnabled', false),
    setting: 'registryLookupEnabled',
  },
  {
    name: 'anonymized contribution',
    named: /\bcontribution\b/i,
    turnsOff: (m) => m.type === 'CONTRIBUTE_DISABLE',
  },
  {
    name: 'site safety declarations',
    named: /\bsite safety declarations\b/i,
    turnsOff: (m) => setsSetting(m, 'aiSafetyTxtEnabled', false),
    setting: 'aiSafetyTxtEnabled',
  },
];

/** A sentence that says something is turned off, or opted out of, with one click. */
function isOneClickOptOut(sentence: string): boolean {
  return (
    /\bone[- ]click\b/i.test(sentence) &&
    /\bturn(?:s|ed|ing)?\b.*\boff\b|\bopt[- ]?out\b/i.test(sentence)
  );
}

const NO_SWITCH = /\bno switch in the popup\b/i;

/** The sentences of a surface, HTML tags removed. A line break also ends one. */
function sentences(text: string): string[] {
  return text
    .replace(/<[^>]+>/g, '')
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// The popup, rendered with every optional network feature on.
// ---------------------------------------------------------------------------

const POPUP_HTML = readFileSync(resolve(ROOT, 'src/popup/index.html'), 'utf8');
const originalChrome = (globalThis as Record<string, unknown>).chrome;

/** Every message the Settings panel's switches sent, one click each. */
let sentBySwitches: SentMessage[] = [];
let switchCount = 0;

beforeAll(async () => {
  const parsed = new DOMParser().parseFromString(POPUP_HTML, 'text/html');
  parsed.querySelectorAll('script').forEach((el) => el.remove());
  document.body.replaceChildren(...Array.from(parsed.body.childNodes).map((n) => document.importNode(n, true)));

  const sent: SentMessage[] = [];
  const storageReads: unknown[] = [];
  const responses: Record<string, unknown> = {
    STATUS_QUERY: {
      detectedAgents: [],
      activeDelegation: null,
      delegationRules: [],
      killSwitchActive: false,
      recentViolations: [],
      aiSafetyDeclarations: {},
    },
    SESSION_QUERY: { sessions: [] },
    REPORTS_QUERY: { reports: [] },
    CONTRIBUTE_STATS: { enabled: true, totalContributed: 0, queuedCount: 0, lastFlushedAt: null },
  };
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      id: 'test-extension',
      lastError: undefined,
      getManifest: () => ({ version: '0.0.0-test' }),
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: (msg: { type: string; data?: unknown }, cb?: (r: unknown) => void) => {
        sent.push({ type: msg.type, data: msg.data });
        setTimeout(() => cb?.(responses[msg.type] ?? {}), 0);
      },
    },
    storage: {
      local: {
        get: async (key: unknown) => {
          storageReads.push(key);
          return key === 'settings'
            ? { settings: { registryLookupEnabled: true, aiSafetyTxtEnabled: true } }
            : {};
        },
        set: async () => {},
        remove: async () => {},
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };

  await import('../popup/popup');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  // The popup reads the stored settings after the contribution state, then
  // renders every panel.
  await vi.waitFor(
    () => {
      if (!storageReads.includes('settings')) throw new Error('stored settings not read yet');
    },
    { timeout: 3000 },
  );
  await new Promise((r) => setTimeout(r, 0));

  document.getElementById('settings-btn')?.click();
  const switches = Array.from(
    document.querySelectorAll<HTMLInputElement>('#settings-content input[type="checkbox"]'),
  );
  switchCount = switches.length;
  const before = sent.length;
  for (const input of switches) input.click();
  sentBySwitches = sent.slice(before);
  // Let the replies and the re-renders they cause finish inside this file.
  await new Promise((r) => setTimeout(r, 10));
});

afterAll(() => {
  (globalThis as Record<string, unknown>).chrome = originalChrome;
  document.body.replaceChildren();
});

function hasSwitch(feature: Feature): boolean {
  return sentBySwitches.some(feature.turnsOff);
}

describe('the popup Settings panel', () => {
  it('was rendered with switches to click', () => {
    expect(switchCount).toBeGreaterThan(0);
  });
});

describe.each(SURFACES)('%s', (path) => {
  const text = sentences(read(path));

  it('names, in a one-click opt-out claim, only features the popup has a switch for', () => {
    for (const claim of text.filter(isOneClickOptOut)) {
      const named = FEATURES.filter((f) => f.named.test(claim));
      expect(named.map((f) => f.name), `"${claim}" does not name the features it covers`).not.toEqual([]);
      expect(
        named.filter((f) => !hasSwitch(f)).map((f) => f.name),
        `"${claim}" promises a one-click switch the popup does not have`,
      ).toEqual([]);
    }
  });

  it('says of a feature with no switch that it has none, and names the stored setting that changes it', () => {
    for (const feature of FEATURES.filter((f) => !hasSwitch(f))) {
      const statement = text.find((s) => feature.named.test(s) && NO_SWITCH.test(s));
      expect(statement, `${path} does not say the ${feature.name} has no switch in the popup`).toBeDefined();
      if (feature.setting) expect(statement).toContain(feature.setting);
    }
  });

  it('does not say a feature with a switch has none', () => {
    for (const feature of FEATURES.filter(hasSwitch)) {
      expect(text.filter((s) => feature.named.test(s) && NO_SWITCH.test(s))).toEqual([]);
    }
  });
});
