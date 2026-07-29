/**
 * Background message-sender validation.
 *
 * chrome.runtime.onMessage only fires for messages from this extension's own
 * scripts when externally_connectable is absent (the manifest omits it, which
 * is Chrome's default-closed posture: no external web page or extension can
 * connect). This module is defense in depth: every message handled by the
 * background must come from the expected sender class (content script vs
 * popup), and the sender's extension id must match ours.
 *
 * If a future manifest change adds externally_connectable matches, this gate
 * still rejects messages whose origin is not our own popup or content scripts.
 */

import type { MessageType } from '../types/events';

const CONTENT_ONLY_TYPES: ReadonlySet<MessageType> = new Set([
  'DETECTION_RESULT',
  'AGENT_ACTION',
  'BOUNDARY_CHECK_REQUEST',
  'NETWORK_EVENT',
  'CDP_DEBUGGER_CHECK',
  'OPEN_POPUP',
  // The per-tab state pull at content-script startup. Content scripts MUST be
  // able to learn their own tab's effective rule and the kill-switch latch on
  // every (re)injection — a navigation during an active kill switch re-arms
  // the MAIN-world sentinel through this, and a tab opened after a delegation
  // activates receives its rule through this. It deliberately returns ONLY
  // that tab's slice (least privilege), unlike the popup-only STATUS_QUERY.
  'TAB_STATE_QUERY',
]);

// Message types that must originate from the main frame (frameId === 0)
// even when content-only validation passes. The toast that emits OPEN_POPUP
// only renders in the main frame; a sub-iframe sending OPEN_POPUP is a
// spam / UX abuse vector.
const MAIN_FRAME_ONLY_TYPES: ReadonlySet<MessageType> = new Set([
  'OPEN_POPUP',
]);

const POPUP_ONLY_TYPES: ReadonlySet<MessageType> = new Set([
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
  'AI_SAFETY_CLEAR',
]);

export function isValidSender(
  type: MessageType,
  sender: chrome.runtime.MessageSender,
): boolean {
  // Same-extension only. sender.id is set for messages from any of this
  // extension's surfaces (background, content, popup, options).
  if (sender.id !== chrome.runtime.id) {
    return false;
  }

  if (CONTENT_ONLY_TYPES.has(type)) {
    // Content scripts always have sender.tab populated by Chrome — and their
    // sender.origin is the PAGE's origin (https://example.com), NOT our
    // chrome-extension:// origin. A previous "defense-in-depth" check here
    // required the extension origin for EVERY message, which rejected every
    // content-script message in the real browser and silently killed the
    // whole content -> background pipeline (in-page detections, action
    // reports, boundary violations) — invisible to the unit suite, whose
    // mock content sender carried the wrong, extension-origin shape. The
    // extension-origin requirement belongs to the popup class only, below.
    if (sender.tab === undefined) return false;
    // Some content-only types must additionally be in the main frame.
    if (MAIN_FRAME_ONLY_TYPES.has(type) && sender.frameId !== 0) {
      return false;
    }
    return true;
  }

  if (POPUP_ONLY_TYPES.has(type)) {
    // Popup messages have sender.url starting with the extension's
    // chrome-extension:// origin and no sender.tab. When sender.origin is
    // populated (Chrome 80+) it must also be our extension origin — this is
    // where the origin check is CORRECT, and it blocks any future
    // externally_connectable misconfiguration (web origins would carry
    // sender.origin === "https://...").
    if (typeof sender.origin === 'string') {
      const expectedOrigin = `chrome-extension://${chrome.runtime.id}`;
      if (sender.origin !== expectedOrigin) {
        return false;
      }
    }
    return (
      sender.tab === undefined
      && typeof sender.url === 'string'
      && sender.url.startsWith(chrome.runtime.getURL(''))
    );
  }

  // Unknown / unclassified message type. Reject so that adding a new type
  // without categorizing it here cannot bypass validation by default.
  return false;
}
