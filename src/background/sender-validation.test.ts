/**
 * Sender-validation gate tests.
 *
 * Regression test for P0-2: the background service worker must reject
 * messages that do not originate from this extension's own content scripts
 * (for content-only message types) or popup (for popup-only message types).
 */

import { describe, it, expect } from 'vitest';
import '../__tests__/setup';
import { isValidSender } from './sender-validation';
import type { MessageType } from '../types/events';

function contentSender(overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  return {
    id: 'test-id',
    tab: { id: 42 } as chrome.tabs.Tab,
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
