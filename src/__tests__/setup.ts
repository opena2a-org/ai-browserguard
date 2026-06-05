/**
 * Vitest global setup: mock Chrome extension APIs.
 */
import { vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

function createEventMock() {
  const listeners: Listener[] = [];
  return {
    addListener: vi.fn((fn: Listener) => { listeners.push(fn); }),
    removeListener: vi.fn((fn: Listener) => {
      const idx = listeners.indexOf(fn);
      if (idx >= 0) listeners.splice(idx, 1);
    }),
    hasListener: vi.fn((fn: Listener) => listeners.includes(fn)),
    _fire: (...args: unknown[]) => {
      for (const fn of listeners) fn(...args);
    },
    _listeners: listeners,
  };
}

// In-memory storage backend
let storageData: Record<string, unknown> = {};

const chromeMock = {
  storage: {
    local: {
      get: vi.fn((keys: string | string[] | Record<string, unknown> | null, callback?: (items: Record<string, unknown>) => void) => {
        let result: Record<string, unknown> = {};
        if (keys === null || keys === undefined) {
          result = { ...storageData };
        } else if (typeof keys === 'string') {
          result = { [keys]: storageData[keys] };
        } else if (Array.isArray(keys)) {
          for (const key of keys) {
            if (key in storageData) result[key] = storageData[key];
          }
        } else {
          // Object with defaults
          for (const key of Object.keys(keys)) {
            result[key] = key in storageData ? storageData[key] : (keys as Record<string, unknown>)[key];
          }
        }
        if (callback) {
          callback(result);
          return;
        }
        return Promise.resolve(result);
      }),
      set: vi.fn((items: Record<string, unknown>, callback?: () => void) => {
        Object.assign(storageData, items);
        if (callback) {
          callback();
          return;
        }
        return Promise.resolve();
      }),
      remove: vi.fn((keys: string | string[], callback?: () => void) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const key of keyList) delete storageData[key];
        if (callback) {
          callback();
          return;
        }
        return Promise.resolve();
      }),
      clear: vi.fn((callback?: () => void) => {
        storageData = {};
        if (callback) {
          callback();
          return;
        }
        return Promise.resolve();
      }),
    },
  },
  runtime: {
    id: 'test-id',
    onMessage: createEventMock(),
    sendMessage: vi.fn((_message: unknown, callback?: (response: unknown) => void) => {
      if (callback) callback(undefined);
      return Promise.resolve(undefined);
    }),
    getURL: vi.fn((path: string) => `chrome-extension://test-id/${path}`),
    lastError: null as { message: string } | null,
  },
  tabs: {
    query: vi.fn(() => Promise.resolve([])),
    sendMessage: vi.fn(() => Promise.resolve(undefined)),
    create: vi.fn(() => Promise.resolve({ id: 1 })),
    onRemoved: createEventMock(),
  },
  notifications: {
    create: vi.fn((_id: string, _options: unknown, callback?: (id: string) => void) => {
      if (callback) callback(_id as string);
    }),
    clear: vi.fn((_id: string, callback?: (wasCleared: boolean) => void) => {
      if (callback) callback(true);
    }),
    getAll: vi.fn((callback: (notifications: Record<string, boolean>) => void) => {
      callback({});
    }),
    onButtonClicked: createEventMock(),
  },
  action: {
    setBadgeText: vi.fn(() => Promise.resolve()),
    setBadgeBackgroundColor: vi.fn(() => Promise.resolve()),
  },
  identity: {
    getRedirectURL: vi.fn((path?: string) => `https://test-id.chromiumapp.org/${path ?? ''}`),
    launchWebAuthFlow: vi.fn(() => Promise.resolve(undefined)),
  },
  alarms: {
    create: vi.fn(),
    onAlarm: createEventMock(),
  },
  commands: {
    onCommand: createEventMock(),
  },
  downloads: {
    download: vi.fn((_options: unknown) => Promise.resolve(1)),
  },
};

// Install chrome mock globally
(globalThis as Record<string, unknown>).chrome = chromeMock;

// Mock document and window for content-script code running in Node
if (typeof document === 'undefined') {
  const docProxy = new Proxy({} as Record<string, unknown>, {
    ownKeys() { return []; },
    get(_target, prop) {
      if (prop === 'addEventListener') return vi.fn();
      if (prop === 'removeEventListener') return vi.fn();
      if (prop === 'querySelectorAll') return vi.fn(() => []);
      if (prop === 'createElement') return vi.fn(() => ({}));
      return undefined;
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (['addEventListener', 'removeEventListener', 'querySelectorAll', 'createElement'].includes(String(prop))) {
        return { configurable: true, enumerable: true, value: vi.fn() };
      }
      return undefined;
    },
  });
  (globalThis as Record<string, unknown>).document = docProxy;
}

if (typeof window === 'undefined') {
  (globalThis as Record<string, unknown>).window = globalThis;
}

if (typeof navigator === 'undefined') {
  (globalThis as Record<string, unknown>).navigator = {
    webdriver: false,
    plugins: { length: 2 },
    languages: ['en-US', 'en'],
    userAgent: 'Mozilla/5.0 Test',
  };
}

// Also mock crypto.randomUUID for node environment
if (!globalThis.crypto?.randomUUID) {
  let counter = 0;
  const originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...originalCrypto,
      randomUUID: () => `test-uuid-${++counter}`,
    },
    writable: true,
    configurable: true,
  });
}

// Reset state between tests
beforeEach(() => {
  storageData = {};
  vi.clearAllMocks();
  // Re-bind mock implementations after clearAllMocks
  chromeMock.storage.local.get.mockImplementation((keys: string | string[] | Record<string, unknown> | null, callback?: (items: Record<string, unknown>) => void) => {
    let result: Record<string, unknown> = {};
    if (keys === null || keys === undefined) {
      result = { ...storageData };
    } else if (typeof keys === 'string') {
      result = { [keys]: storageData[keys] };
    } else if (Array.isArray(keys)) {
      for (const key of keys) {
        if (key in storageData) result[key] = storageData[key];
      }
    } else {
      for (const key of Object.keys(keys)) {
        result[key] = key in storageData ? storageData[key] : (keys as Record<string, unknown>)[key];
      }
    }
    if (callback) {
      callback(result);
      return;
    }
    return Promise.resolve(result);
  });
  chromeMock.storage.local.set.mockImplementation((items: Record<string, unknown>, callback?: () => void) => {
    Object.assign(storageData, items);
    if (callback) {
      callback();
      return;
    }
    return Promise.resolve();
  });
  chromeMock.storage.local.remove.mockImplementation((keys: string | string[], callback?: () => void) => {
    const keyList = Array.isArray(keys) ? keys : [keys];
    for (const key of keyList) delete storageData[key];
    if (callback) {
      callback();
      return;
    }
    return Promise.resolve();
  });
  chromeMock.storage.local.clear.mockImplementation((callback?: () => void) => {
    storageData = {};
    if (callback) {
      callback();
      return;
    }
    return Promise.resolve();
  });
  chromeMock.runtime.getURL.mockImplementation((path: string) => `chrome-extension://test-id/${path}`);
  chromeMock.notifications.getAll.mockImplementation((callback: (notifications: Record<string, boolean>) => void) => {
    callback({});
  });
});

export { chromeMock, storageData };
