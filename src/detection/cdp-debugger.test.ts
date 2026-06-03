import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectDebuggerAttachment, monitorDebuggerAttachment } from './cdp-debugger';

// Mock chrome.debugger API
const mockGetTargets = vi.fn();

beforeEach(() => {
  vi.stubGlobal('chrome', {
    debugger: {
      getTargets: mockGetTargets,
    },
    runtime: {
      lastError: null,
      id: 'self-extension-id',
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('detectDebuggerAttachment', () => {
  it('returns not detected when no debugger API is available', async () => {
    vi.stubGlobal('chrome', { runtime: {} });
    const result = await detectDebuggerAttachment();
    expect(result.detected).toBe(false);
    expect(result.detail).toContain('not available');
  });

  it('returns not detected when no targets have attached debuggers', async () => {
    mockGetTargets.mockImplementation((cb: (targets: unknown[]) => void) => {
      cb([
        { id: 'target-1', type: 'page', title: 'Example', url: 'https://example.com', attached: false },
        { id: 'target-2', type: 'page', title: 'Test', url: 'https://test.com', attached: false },
      ]);
    });

    const result = await detectDebuggerAttachment();
    expect(result.detected).toBe(false);
    expect(result.targets).toHaveLength(0);
  });

  it('detects a page-level attachment at high (not confirmed) confidence', async () => {
    mockGetTargets.mockImplementation((cb: (targets: unknown[]) => void) => {
      cb([
        { id: 'target-1', type: 'page', title: 'BofA', url: 'https://bankofamerica.com', attached: true, tabId: 42 },
        { id: 'target-2', type: 'page', title: 'CNN', url: 'https://cnn.com', attached: false },
      ]);
    });

    const result = await detectDebuggerAttachment();
    expect(result.detected).toBe(true);
    // Page-level attachment with no browser target, no vendor signature, and no
    // DevTools front end open: a real but not "confirmed" CDP signal.
    expect(result.confidence).toBe('high');
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].tabId).toBe(42);
    expect(result.targets[0].url).toBe('https://bankofamerica.com');
  });

  it('reports cdp-generic for page-only attachment without a vendor signature', async () => {
    mockGetTargets.mockImplementation((cb: (targets: unknown[]) => void) => {
      cb([
        { id: 't1', type: 'page', title: 'Test', url: 'https://test.com', attached: true, tabId: 1 },
      ]);
    });

    const result = await detectDebuggerAttachment();
    expect(result.detected).toBe(true);
    expect(result.inferredFramework).toBe('cdp-generic');
  });

  it('reserves confirmed for a browser-target attachment but still labels cdp-generic', async () => {
    mockGetTargets.mockImplementation((cb: (targets: unknown[]) => void) => {
      cb([
        { id: 't1', type: 'browser', title: 'Chrome', url: '', attached: true },
        { id: 't2', type: 'page', title: 'Test', url: 'https://test.com', attached: true, tabId: 1 },
      ]);
    });

    const result = await detectDebuggerAttachment();
    expect(result.detected).toBe(true);
    // Browser-target attachment is exclusive to external CDP clients -> confirmed.
    expect(result.confidence).toBe('confirmed');
    // But topology alone does not name a vendor.
    expect(result.inferredFramework).toBe('cdp-generic');
  });

  it('names a vendor only on a stack signature, at confirmed confidence', async () => {
    mockGetTargets.mockImplementation((cb: (targets: unknown[]) => void) => {
      cb([
        { id: 't1', type: 'page', title: 'Playwright runner', url: 'https://test.com', attached: true, tabId: 1 },
      ]);
    });

    const result = await detectDebuggerAttachment();
    expect(result.detected).toBe(true);
    expect(result.inferredFramework).toBe('playwright');
    expect(result.confidence).toBe('confirmed');
  });

  it('ignores attachments on chrome:// browser-chrome pages (false positive)', async () => {
    mockGetTargets.mockImplementation((cb: (targets: unknown[]) => void) => {
      cb([
        { id: 't1', type: 'page', title: 'Extensions', url: 'chrome://extensions/', attached: true, tabId: 5 },
      ]);
    });

    const result = await detectDebuggerAttachment();
    expect(result.detected).toBe(false);
    expect(result.targets).toHaveLength(0);
  });

  it("ignores attachments on this extension's own pages (false positive)", async () => {
    mockGetTargets.mockImplementation((cb: (targets: unknown[]) => void) => {
      cb([
        { id: 't1', type: 'page', title: 'Popup', url: 'chrome-extension://self-extension-id/popup.html', attached: true, tabId: 6 },
      ]);
    });

    const result = await detectDebuggerAttachment();
    expect(result.detected).toBe(false);
  });

  it('ignores devtools:// front-end targets and caps an inspected page at medium', async () => {
    mockGetTargets.mockImplementation((cb: (targets: unknown[]) => void) => {
      cb([
        // The built-in DevTools front end appears as its own target...
        { id: 't1', type: 'other', title: 'DevTools', url: 'devtools://devtools/bundled/devtools_app.html', attached: true },
        // ...and the inspected page reports attached === true as a side effect of F12.
        { id: 't2', type: 'page', title: 'Inspected', url: 'https://example.com', attached: true, tabId: 9 },
      ]);
    });

    const result = await detectDebuggerAttachment();
    expect(result.detected).toBe(true);
    // Only the real page survives the internal-URL filter...
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].url).toBe('https://example.com');
    // ...and the open DevTools front end means we do not claim "confirmed".
    expect(result.confidence).toBe('medium');
    expect(result.detail).toContain('DevTools');
  });

  it('detects multiple attached targets', async () => {
    mockGetTargets.mockImplementation((cb: (targets: unknown[]) => void) => {
      cb([
        { id: 't1', type: 'page', title: 'Tab 1', url: 'https://a.com', attached: true, tabId: 1 },
        { id: 't2', type: 'page', title: 'Tab 2', url: 'https://b.com', attached: true, tabId: 2 },
        { id: 't3', type: 'page', title: 'Tab 3', url: 'https://c.com', attached: false },
      ]);
    });

    const result = await detectDebuggerAttachment();
    expect(result.detected).toBe(true);
    expect(result.targets).toHaveLength(2);
    expect(result.detail).toContain('2 target(s)');
  });

  it('handles chrome.runtime.lastError gracefully', async () => {
    vi.stubGlobal('chrome', {
      debugger: {
        getTargets: (cb: (targets: unknown[]) => void) => {
          // Simulate lastError
          (chrome.runtime as Record<string, unknown>).lastError = { message: 'Permission denied' };
          cb([]);
        },
      },
      runtime: { lastError: null },
    });

    const result = await detectDebuggerAttachment();
    expect(result.detected).toBe(false);
  });
});

describe('monitorDebuggerAttachment', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls callback when debugger attachment is detected', async () => {
    let callCount = 0;
    mockGetTargets.mockImplementation((cb: (targets: unknown[]) => void) => {
      callCount++;
      if (callCount >= 2) {
        // Second call: simulate debugger attachment
        cb([
          { id: 't1', type: 'page', title: 'Test', url: 'https://test.com', attached: true, tabId: 1 },
        ]);
      } else {
        cb([]);
      }
    });

    const onDetection = vi.fn();
    const cleanup = monitorDebuggerAttachment(onDetection, 1000);

    // Initial check (no detection)
    await vi.advanceTimersByTimeAsync(100);
    expect(onDetection).not.toHaveBeenCalled();

    // After interval (detection)
    await vi.advanceTimersByTimeAsync(1000);
    expect(onDetection).toHaveBeenCalledTimes(1);
    expect(onDetection.mock.calls[0][0].detected).toBe(true);

    cleanup();
  });

  it('does not double-report the same detection', async () => {
    mockGetTargets.mockImplementation((cb: (targets: unknown[]) => void) => {
      cb([
        { id: 't1', type: 'page', title: 'Test', url: 'https://test.com', attached: true, tabId: 1 },
      ]);
    });

    const onDetection = vi.fn();
    const cleanup = monitorDebuggerAttachment(onDetection, 1000);

    await vi.advanceTimersByTimeAsync(100);
    expect(onDetection).toHaveBeenCalledTimes(1);

    // Same state, same count — should not re-report
    await vi.advanceTimersByTimeAsync(1000);
    expect(onDetection).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('stops monitoring when cleanup is called', async () => {
    mockGetTargets.mockImplementation((cb: (targets: unknown[]) => void) => {
      cb([]);
    });

    const onDetection = vi.fn();
    const cleanup = monitorDebuggerAttachment(onDetection, 1000);

    cleanup();

    await vi.advanceTimersByTimeAsync(5000);
    // Should have been called only for the initial check
    expect(mockGetTargets).toHaveBeenCalledTimes(1);
  });
});
