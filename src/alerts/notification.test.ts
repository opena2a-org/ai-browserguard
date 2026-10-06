import { describe, it, expect, vi, afterEach } from 'vitest';
import { chromeMock } from '../__tests__/setup';
import { showNoticeNotification } from './notification';

afterEach(() => {
  vi.useRealTimers();
});

describe('showNoticeNotification', () => {
  it('shows a notice with no buttons and clears it after 10,000 ms, not at 9,999', () => {
    vi.useFakeTimers();
    chromeMock.notifications.create.mockClear();
    chromeMock.notifications.clear.mockClear();

    const id = showNoticeNotification('Download not stopped', 'Left a download to finish.');

    expect(id).not.toBeNull();
    expect(chromeMock.notifications.create).toHaveBeenCalledTimes(1);
    const [createdId, options] = chromeMock.notifications.create.mock.calls[0] as [string, Record<string, unknown>];
    expect(createdId).toBe(id);
    expect(options).toEqual(expect.objectContaining({
      type: 'basic',
      title: 'AI Browser Guard - Download not stopped',
      message: 'Left a download to finish.',
      priority: 0,
    }));
    expect(options.buttons).toBeUndefined();
    expect(options.requireInteraction).toBeUndefined();

    vi.advanceTimersByTime(9_999);
    expect(chromeMock.notifications.clear).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(chromeMock.notifications.clear).toHaveBeenCalledWith(id);
  });

  it('shows nothing when notifications are turned off', () => {
    chromeMock.notifications.create.mockClear();
    expect(showNoticeNotification('Download not stopped', 'x', { enabled: false })).toBeNull();
    expect(chromeMock.notifications.create).not.toHaveBeenCalled();
  });
});
