/**
 * @vitest-environment jsdom
 *
 * Regression (#109): the in-page toast offered "Allow once" for every block,
 * so a critical form submission on a banking site could be let through from
 * the page while the Chrome notification for the same block correctly offered
 * no override. Only medium and low severity blocks may be overridden once;
 * the toast now offers the button exactly when the notification does.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../__tests__/setup';
import { showBlockedToast } from './toast';
import { createBoundaryAlert, classifyViolationSeverity } from '../alerts/boundary';
import { createRuleFromPreset } from '../delegation/rules';
import type { AgentCapability } from '../types/agent';
import type { BoundaryViolation } from '../types/events';

/** The toast's closed shadow root keeps its inner element on the host. */
function toastButtons(): string[] {
  const host = document.getElementById('abg-toast-container') as
    | (HTMLElement & { _inner?: HTMLElement })
    | null;
  const inner = host?._inner;
  if (!inner) return [];
  return Array.from(inner.querySelectorAll('button')).map((b) => b.textContent ?? '');
}

function allowOnceButton(): HTMLButtonElement | null {
  const host = document.getElementById('abg-toast-container') as
    | (HTMLElement & { _inner?: HTMLElement })
    | null;
  return host?._inner?.querySelector<HTMLButtonElement>('.abg-toast-btn-allow') ?? null;
}

const CAPABILITIES: AgentCapability[] = [
  'navigate',
  'read-dom',
  'click',
  'type-text',
  'submit-form',
  'download-file',
  'open-tab',
  'close-tab',
  'screenshot',
  'execute-script',
  'modify-dom',
  'network-request',
];

const URLS = ['https://example.com/page', 'https://online.bank.example/transfer'];

describe('toast "Allow once" follows block severity (#109)', () => {
  beforeEach(() => {
    document.getElementById('abg-toast-container')?.remove();
  });

  it('offers no "Allow once" for a critical form submission on a banking site', () => {
    const url = 'https://online.bank.example/transfer';
    expect(classifyViolationSeverity('submit-form', url)).toBe('critical');
    const onAllowOnce = vi.fn();

    showBlockedToast({
      capability: 'submit-form',
      url,
      reason: 'Delegation does not permit form submission',
      onAllowOnce,
      onOpenSettings: () => {},
    });

    expect(allowOnceButton()).toBeNull();
    expect(toastButtons()).not.toContain('Allow once');
    // The user still has a way forward: Settings opens the popup.
    expect(toastButtons()).toContain('Settings');
    expect(onAllowOnce).not.toHaveBeenCalled();
  });

  it('offers no "Allow once" for a high-severity click', () => {
    const url = 'https://example.com/page';
    expect(classifyViolationSeverity('click', url)).toBe('high');

    showBlockedToast({ capability: 'click', url, reason: '', onAllowOnce: vi.fn() });

    expect(allowOnceButton()).toBeNull();
  });

  it('offers a working "Allow once" for a medium-severity text input', () => {
    const url = 'https://example.com/page';
    expect(classifyViolationSeverity('type-text', url)).toBe('medium');
    const onAllowOnce = vi.fn();

    showBlockedToast({ capability: 'type-text', url, reason: '', onAllowOnce });

    const btn = allowOnceButton();
    expect(btn).not.toBeNull();
    btn!.click();
    expect(onAllowOnce).toHaveBeenCalledTimes(1);
  });

  it('offers "Allow once" for a low-severity new tab', () => {
    const url = 'https://example.com/page';
    expect(classifyViolationSeverity('open-tab', url)).toBe('low');

    showBlockedToast({ capability: 'open-tab', url, reason: '', onAllowOnce: vi.fn() });

    expect(allowOnceButton()).not.toBeNull();
  });

  it('offers "Allow once" exactly when the Chrome notification does, for every capability', () => {
    const rule = createRuleFromPreset('readOnly');
    for (const capability of CAPABILITIES) {
      for (const url of URLS) {
        document.getElementById('abg-toast-container')?.remove();
        const violation: BoundaryViolation = {
          id: 'v',
          timestamp: new Date(0).toISOString(),
          agentId: '',
          attemptedAction: capability,
          url,
          targetSelector: undefined,
          blockingRuleId: rule.id,
          reason: '',
          userOverride: false,
        };
        const notificationOffers = createBoundaryAlert(violation, rule).allowOneTimeOverride;

        showBlockedToast({ capability, url, reason: '', onAllowOnce: () => {} });

        expect({ capability, url, toastOffers: allowOnceButton() !== null }).toEqual({
          capability,
          url,
          toastOffers: notificationOffers,
        });
      }
    }
  });

  it('offers no "Allow once" when the caller passes no handler, whatever the severity', () => {
    showBlockedToast({ capability: 'open-tab', url: 'https://example.com/page', reason: '' });

    expect(allowOnceButton()).toBeNull();
  });
});
