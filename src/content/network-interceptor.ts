/**
 * Privacy-preserving network activity interceptor.
 *
 * Wraps window.fetch and XMLHttpRequest in the MAIN world content script
 * to track network requests without requiring the webRequest permission.
 * This keeps the extension Chrome Web Store compliant.
 *
 * Distinguishes agent-initiated requests from user-initiated ones using
 * stack trace heuristics (automation framework signatures in the call stack).
 */

/**
 * A single observed network request event.
 */
export interface NetworkEvent {
  /** Target URL of the request. */
  url: string;
  /** HTTP method (GET, POST, etc.). */
  method: string;
  /** ISO 8601 timestamp when the request was initiated. */
  timestamp: string;
  /** Approximate request body size in bytes (0 if no body). */
  dataSize: number;
  /** Whether the request was likely initiated by an agent or user. */
  initiator: 'agent' | 'user' | 'unknown';
}

/** Known automation framework patterns in call stacks. */
const AGENT_STACK_PATTERNS = [
  /UtilityScript/,
  /__puppeteer_evaluation_script__/,
  /pptr:/,
  /ExecutionContext\._evaluateInternal/,
  /callFunction\b/,
  /Runtime\.evaluate/,
  /Runtime\.callFunctionOn/,
];

/**
 * Determine whether the current call stack suggests agent initiation.
 */
function detectAgentInitiation(): 'agent' | 'user' | 'unknown' {
  try {
    const stack = new Error('__network_probe__').stack ?? '';
    for (const pattern of AGENT_STACK_PATTERNS) {
      if (pattern.test(stack)) {
        return 'agent';
      }
    }
    return 'user';
  } catch {
    return 'unknown';
  }
}

/**
 * Estimate the byte size of a request body.
 */
function estimateBodySize(body: unknown): number {
  if (body === null || body === undefined) return 0;
  if (typeof body === 'string') return body.length;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof FormData) {
    // Rough estimate for FormData
    let size = 0;
    body.forEach((value) => {
      if (typeof value === 'string') {
        size += value.length;
      } else if (value instanceof Blob) {
        size += value.size;
      }
    });
    return size;
  }
  if (typeof body === 'object') {
    try {
      return JSON.stringify(body).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

export type NetworkEventCallback = (event: NetworkEvent) => void;

/** Metadata passed to the deny decider for one outgoing request. */
export interface NetworkRequestMeta {
  url: string;
  method: string;
  initiator: 'agent' | 'user' | 'unknown';
}

/** Verdict returned by the deny decider. */
export interface NetworkDecision {
  blocked: boolean;
  reason: string;
}

/**
 * Optional policy hook. Called for each outgoing request BEFORE it is sent.
 * Return `{ blocked: true }` to deny the request. The decider owns the policy
 * (capability check, agent-attribution scoping, reporting); the interceptor only
 * enforces the verdict. A blocked request is never observed (no NetworkEvent is
 * emitted for it) since nothing went out. Errors thrown by the decider fail OPEN
 * (the request proceeds) so a policy bug can never break the page.
 */
export type NetworkDecider = (meta: NetworkRequestMeta) => NetworkDecision;

/**
 * Install network interception on the current page.
 *
 * Wraps window.fetch and XMLHttpRequest.prototype.open to observe outgoing
 * requests and, when a `decide` hook is supplied, to deny them. Calls
 * `callback` for each observed (non-denied) network event.
 *
 * Deny mechanics:
 *   • fetch — a denied call returns a rejected Promise (`TypeError`), the same
 *     shape the page sees when a request is blocked by the browser.
 *   • XHR — a denied `open()` is skipped, so the agent's subsequent native
 *     `send()`/`setRequestHeader()` throws `InvalidStateError` and nothing is
 *     transmitted. We deliberately do NOT wrap `send()` (that would put our code
 *     in the send call chain and misattribute the page's own CSP violations to
 *     this extension in chrome://extensions).
 *   • sendBeacon — a denied beacon returns `false` (the spec "not queued"
 *     signal) without throwing.
 *
 * Egress paths NOT yet wrapped (a restricted agent can still use these):
 * `WebSocket`, `EventSource`, element-`src` injection (`new Image().src=`,
 * `<script>`/`<link>`), and a Worker/iframe that brings its own un-patched
 * `fetch`. Closing these is tracked with the CDP/debugger-layer move.
 *
 * Returns a cleanup function that restores original implementations.
 */
export function installNetworkInterceptor(
  callback: NetworkEventCallback,
  decide?: NetworkDecider
): () => void {
  const cleanups: Array<() => void> = [];

  // --- Intercept fetch ---
  const originalFetch = window.fetch.bind(window);

  const wrappedFetch: typeof window.fetch = function (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const initiator = detectAgentInitiation();

    let url: string;
    let method = 'GET';

    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else if (input instanceof Request) {
      url = input.url;
      method = input.method;
    } else {
      url = String(input);
    }

    if (init?.method) {
      method = init.method;
    }

    const dataSize = estimateBodySize(init?.body ?? null);

    const event: NetworkEvent = {
      url,
      method: method.toUpperCase(),
      timestamp: new Date().toISOString(),
      dataSize,
      initiator,
    };

    // Deny path (checked before observe — a denied request never went out, so it
    // is reported as a block by the decider, not observed as a NetworkEvent).
    if (decide) {
      let decision: NetworkDecision = { blocked: false, reason: '' };
      try {
        decision = decide({ url: event.url, method: event.method, initiator });
      } catch {
        // Fail open — a policy bug must never break the page's network.
        decision = { blocked: false, reason: '' };
      }
      if (decision.blocked) {
        return Promise.reject(
          new TypeError(decision.reason || 'Network request blocked by AI Browser Guard')
        );
      }
    }

    try {
      callback(event);
    } catch {
      // Never let callback errors affect the actual request
    }

    return originalFetch(input, init);
  };

  window.fetch = wrappedFetch;
  cleanups.push(() => {
    window.fetch = originalFetch;
  });

  // --- Intercept XMLHttpRequest ---
  // We only wrap `open` to capture method/URL metadata and attach a passive
  // `loadstart` event listener. We do NOT wrap `send` — wrapping send puts
  // our code in the call chain, so any CSP violations on the page's own
  // requests get attributed to our extension in chrome://extensions.
  const originalXHROpen = XMLHttpRequest.prototype.open;

  // Track method, URL and the OPEN-TIME initiator per XHR instance.
  const xhrMeta = new WeakMap<
    XMLHttpRequest,
    { method: string; url: string; initiator: 'agent' | 'user' | 'unknown' }
  >();

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    // Attribute at open() time: this runs synchronously in the caller's stack,
    // so the agent's CDP frames are visible. (Probing at loadstart instead — as
    // this did previously — sees only the event-dispatch stack and mis-labels
    // agent requests as user.)
    const meta = {
      method: method.toUpperCase(),
      url: typeof url === 'string' ? url : url.toString(),
      initiator: detectAgentInitiation(),
    };

    // Deny path: skip the native open() so the agent's subsequent native send()/
    // setRequestHeader() throws InvalidStateError and nothing is transmitted. We
    // never enter the send() call chain (preserves the no-send-wrap invariant).
    if (decide) {
      let decision: NetworkDecision = { blocked: false, reason: '' };
      try {
        decision = decide({ url: meta.url, method: meta.method, initiator: meta.initiator });
      } catch {
        decision = { blocked: false, reason: '' }; // fail open
      }
      if (decision.blocked) {
        xhrMeta.set(this, meta);
        return; // do NOT open — the request can never be sent
      }
    }

    xhrMeta.set(this, meta);

    // Observe the request passively via loadstart — fires when send() is
    // called but without us being in the send() call chain.
    this.addEventListener('loadstart', () => {
      const event: NetworkEvent = {
        url: meta.url,
        method: meta.method,
        timestamp: new Date().toISOString(),
        dataSize: 0, // body size not available from loadstart
        initiator: meta.initiator,
      };
      try {
        callback(event);
      } catch {
        // Never let callback errors affect the actual request
      }
    }, { once: true });

    return (originalXHROpen as Function).apply(this, [method, url, ...rest]);
  };

  cleanups.push(() => {
    XMLHttpRequest.prototype.open = originalXHROpen;
  });

  // --- Intercept navigator.sendBeacon ---
  // sendBeacon is a fire-and-forget POST and a prime exfiltration primitive — it
  // ignores the fetch/XHR wrappers entirely. Deny it on the same agent-scoped
  // policy: a denied beacon returns `false` (the spec's "not queued" signal)
  // without throwing. Guarded so it is a no-op where sendBeacon is unsupported.
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    const originalSendBeacon = navigator.sendBeacon.bind(navigator);
    const wrappedSendBeacon = function (url: string | URL, data?: BodyInit | null): boolean {
      const initiator = detectAgentInitiation();
      const urlStr = typeof url === 'string' ? url : url.toString();
      const event: NetworkEvent = {
        url: urlStr,
        method: 'POST', // sendBeacon is always POST
        timestamp: new Date().toISOString(),
        dataSize: estimateBodySize(data ?? null),
        initiator,
      };

      if (decide) {
        let decision: NetworkDecision = { blocked: false, reason: '' };
        try {
          decision = decide({ url: urlStr, method: 'POST', initiator });
        } catch {
          decision = { blocked: false, reason: '' }; // fail open
        }
        if (decision.blocked) {
          return false; // not queued — the beacon never leaves
        }
      }

      try {
        callback(event);
      } catch {
        // Never let callback errors affect the actual request
      }
      return originalSendBeacon(url, data);
    };

    navigator.sendBeacon = wrappedSendBeacon;
    cleanups.push(() => {
      navigator.sendBeacon = originalSendBeacon;
    });
  }

  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // Ignore cleanup errors
      }
    }
  };
}
