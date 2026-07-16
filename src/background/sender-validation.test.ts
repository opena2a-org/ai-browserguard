/**
 * Sender-validation gate tests.
 *
 * Regression test for P0-2: the background service worker must reject
 * messages that do not originate from this extension's own content scripts
 * (for content-only message types) or popup (for popup-only message types).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import '../__tests__/setup';
import { isValidSender } from './sender-validation';
import { ALL_MESSAGE_TYPES } from '../types/events';
import type { MessageType } from '../types/events';

function contentSender(overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  return {
    id: 'test-id',
    tab: { id: 42 } as chrome.tabs.Tab,
    frameId: 0,
    ...overrides,
  };
}

function popupSender(overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  return {
    id: 'test-id',
    url: 'chrome-extension://test-id/dist/popup/index.html',
    ...overrides,
  };
}

/**
 * Types the background SENDS but never receives, so they are correctly absent
 * from both inbound sets. Responses and pushes, not requests.
 *
 * Listed explicitly rather than inferred, so that adding a new message type
 * forces a deliberate choice: inbound (classify it) or outbound (say so here).
 */
const OUTBOUND_ONLY_TYPES: readonly MessageType[] = [
  'BOUNDARY_CHECK_RESPONSE',
  'KILL_SWITCH_RESULT',
  'SESSION_DATA',
  'STATUS_RESPONSE',
  'ALLOW_ONCE',
];

describe('every inbound message type is classified', () => {
  // isValidSender fails CLOSED on an unclassified type — "adding a new type
  // without categorizing it here cannot bypass validation by default". That is
  // the right default, and it has a sharp edge: a type added to the union but
  // not to a set is silently REJECTED at runtime. No error, no crash, nothing
  // red — the feature that sends it is simply dead.
  //
  // Not hypothetical. AI_SAFETY_CLEAR was added without being classified, so
  // the "Delete stored declarations" button — itself added to fix a dead end —
  // did nothing at all when clicked, and every test still passed.
  //
  // Asserted by outcome rather than by reading the sets: a routable type is one
  // some legitimate sender can actually get through.
  const inboundTypes = ALL_MESSAGE_TYPES.filter((t) => !OUTBOUND_ONLY_TYPES.includes(t));

  it.each(inboundTypes)('%s is routable by a legitimate sender', (type) => {
    const routable =
      isValidSender(type, contentSender()) || isValidSender(type, popupSender());

    expect(
      routable,
      `Message type "${type}" is accepted from neither a content script nor the popup, ` +
        'so every message of this type is silently rejected and whatever sends it is ' +
        'dead code. Add it to CONTENT_ONLY_TYPES or POPUP_ONLY_TYPES in ' +
        'sender-validation.ts — or to OUTBOUND_ONLY_TYPES in this file if the ' +
        'background only ever sends it.',
    ).toBe(true);
  });

  it.each(OUTBOUND_ONLY_TYPES)('%s is genuinely outbound-only (no handler exists)', (type) => {
    // Keeps the list above honest, and catches the dangerous direction: adding
    // a background handler for a type declared outbound-only would mean every
    // message to it is rejected, and nothing else would notice.
    const backgroundSource = readFileSync(resolve(__dirname, 'index.ts'), 'utf-8');
    expect(
      backgroundSource.includes(`case '${type}'`),
      `"${type}" is listed as outbound-only, but background/index.ts now handles it. ` +
        'An inbound type must be classified in sender-validation.ts or every such ' +
        'message is silently dropped.',
    ).toBe(false);
  });

  it('still rejects a type that is not a real message type', () => {
    // The fail-closed default must survive the tests above: proving every real
    // inbound type is routable must not tempt anyone into defaulting to accept.
    expect(isValidSender('NOT_A_REAL_TYPE' as MessageType, popupSender())).toBe(false);
    expect(isValidSender('NOT_A_REAL_TYPE' as MessageType, contentSender())).toBe(false);
  });
});

describe('isValidSender', () => {
  describe('content-only message types', () => {
    const contentOnly: MessageType[] = [
      'DETECTION_RESULT',
      'AGENT_ACTION',
      'BOUNDARY_CHECK_REQUEST',
      'NETWORK_EVENT',
      'CDP_DEBUGGER_CHECK',
      'OPEN_POPUP',
    ];

    for (const type of contentOnly) {
      it(`${type} accepts a content-script sender`, () => {
        expect(isValidSender(type, contentSender())).toBe(true);
      });

      it(`${type} rejects a popup sender (tab is undefined)`, () => {
        expect(isValidSender(type, popupSender())).toBe(false);
      });

      it(`${type} rejects a sender with a foreign extension id`, () => {
        expect(isValidSender(type, contentSender({ id: 'hostile-extension-id' }))).toBe(false);
      });
    }
  });

  describe('popup-only message types', () => {
    const popupOnly: MessageType[] = [
      'KILL_SWITCH_ACTIVATE',
      'KILL_SWITCH_RESET',
      'DELEGATION_UPDATE',
      'SESSION_QUERY',
      'STATUS_QUERY',
      'SETTINGS_UPDATE',
      'REPORTS_QUERY',
      'REPORT_EXPORT',
      'REPORT_DOWNLOAD',
      'CONTRIBUTE_STATS',
      'CONTRIBUTE_ENABLE',
      'CONTRIBUTE_DISABLE',
      'CONTRIBUTE_FLUSH',
      'CONTRIBUTE_TIP_DISMISS',
      'DOMAIN_WHITELIST',
    ];

    for (const type of popupOnly) {
      it(`${type} accepts a popup sender`, () => {
        expect(isValidSender(type, popupSender())).toBe(true);
      });

      it(`${type} rejects a content-script sender (has sender.tab)`, () => {
        expect(isValidSender(type, contentSender())).toBe(false);
      });

      it(`${type} rejects a sender whose url is not our extension origin`, () => {
        expect(
          isValidSender(type, popupSender({ url: 'https://hostile.example.com/' })),
        ).toBe(false);
      });

      it(`${type} rejects a sender with a foreign extension id`, () => {
        expect(isValidSender(type, popupSender({ id: 'hostile-extension-id' }))).toBe(false);
      });
    }
  });

  describe('main-frame-only message types', () => {
    // Defense-in-depth: OPEN_POPUP is the only main-frame-only type today.
    // The toast that emits it only renders in the main frame; a sub-iframe
    // sending OPEN_POPUP is a UX abuse vector (popup spam), not a privilege
    // escalation, but the gate is still cheap.

    it('OPEN_POPUP accepts a main-frame content sender (frameId === 0)', () => {
      expect(isValidSender('OPEN_POPUP', contentSender({ frameId: 0 }))).toBe(true);
    });

    it('OPEN_POPUP rejects a sub-iframe sender (frameId > 0)', () => {
      expect(isValidSender('OPEN_POPUP', contentSender({ frameId: 1 }))).toBe(false);
      expect(isValidSender('OPEN_POPUP', contentSender({ frameId: 42 }))).toBe(false);
    });

    it('OPEN_POPUP rejects a sender with missing frameId (defensive default)', () => {
      // Real Chrome always populates frameId on content-script messages,
      // but if it's ever missing we default-reject rather than default-allow.
      const sender = contentSender();
      delete (sender as { frameId?: number }).frameId;
      expect(isValidSender('OPEN_POPUP', sender)).toBe(false);
    });

    it('non-OPEN_POPUP content-only types accept any frameId', () => {
      // DETECTION_RESULT et al. legitimately fire from sub-iframes that
      // contain agent activity — we must not regress that.
      expect(isValidSender('DETECTION_RESULT', contentSender({ frameId: 7 }))).toBe(true);
      expect(isValidSender('AGENT_ACTION', contentSender({ frameId: 99 }))).toBe(true);
      expect(isValidSender('NETWORK_EVENT', contentSender({ frameId: 1 }))).toBe(true);
    });
  });

  describe('sender.origin defense-in-depth', () => {
    // Chrome 80+ populates sender.origin. We require it to match our
    // chrome-extension origin if present, so a future externally_connectable
    // misconfiguration (matches added) can't smuggle a web origin through
    // the id check alone.

    it('accepts a content sender with the correct chrome-extension origin', () => {
      expect(isValidSender('DETECTION_RESULT', contentSender({
        origin: 'chrome-extension://test-id',
      }))).toBe(true);
    });

    it('rejects a sender claiming a web origin even with our extension id', () => {
      expect(isValidSender('DETECTION_RESULT', contentSender({
        origin: 'https://attacker.com',
      }))).toBe(false);
    });

    it('rejects a popup sender with a foreign chrome-extension origin', () => {
      expect(isValidSender('STATUS_QUERY', popupSender({
        origin: 'chrome-extension://hostile-id',
      }))).toBe(false);
    });

    it('accepts when sender.origin is undefined (older Chrome compat)', () => {
      // Backwards compat: sender.origin was added in Chrome 80. Older
      // versions populate everything else. The id check is the load-bearing
      // gate when origin is missing.
      expect(isValidSender('DETECTION_RESULT', contentSender())).toBe(true);
    });
  });

  describe('uncategorized message types', () => {
    it('rejects an unknown type even from our own extension', () => {
      // Cast through unknown to feed an unclassified value.
      const unknown = 'NEW_FEATURE_NOT_YET_CATEGORIZED' as unknown as MessageType;
      expect(isValidSender(unknown, contentSender())).toBe(false);
      expect(isValidSender(unknown, popupSender())).toBe(false);
    });

    it('rejects response-shape types that originate from background only', () => {
      // STATUS_RESPONSE / SESSION_DATA / KILL_SWITCH_RESULT are responses
      // the background sends OUT — they should never be received here.
      expect(isValidSender('STATUS_RESPONSE', popupSender())).toBe(false);
      expect(isValidSender('SESSION_DATA', popupSender())).toBe(false);
      expect(isValidSender('KILL_SWITCH_RESULT', contentSender())).toBe(false);
      expect(isValidSender('BOUNDARY_CHECK_RESPONSE', contentSender())).toBe(false);
    });
  });
});
