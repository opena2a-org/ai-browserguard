/**
 * AIM (Agent Identity Management) API client.
 *
 * Performs lightweight lookups against an AIM server to retrieve
 * trust scores and display names for detected agents. Results are
 * cached in memory with a configurable TTL (default 5 minutes).
 *
 * Uses the SDK API endpoint GET /api/v1/sdk-api/agents/:identifier
 * which accepts an agent name or UUID and returns the full agent
 * record including trustScore and displayName.
 */

/**
 * Discriminated result of an AIM identity lookup.
 *
 * - `ok`: AIM returned a registered agent record.
 * - `unregistered`: AIM is reachable but reports the agent is not registered (404).
 *   Informational only — does NOT contribute to trust score averaging.
 * - `unreachable`: any transport-level failure (network error, timeout, non-HTTPS
 *   base URL, non-2xx/non-404 status). Callers should treat this the same as
 *   "no signal" — not as low trust.
 */
export type AIMLookupResult =
  | { status: 'ok'; trustScore: number; label: string; registered: true }
  | { status: 'unregistered'; label: string; registered: false }
  | { status: 'unreachable' };

interface CacheEntry {
  result: AIMLookupResult;
  expiresAt: number;
}

const DEFAULT_AIM_BASE_URL = 'https://aim.opena2a.org';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// Short negative-cache for transport failures. Without this, every detected
// agent navigation re-issues a fetch when AIM is down, turning a brief
// partial outage into a layer-7 stampede. 30s is short enough to recover
// quickly when AIM comes back, long enough to absorb a burst.
const UNREACHABLE_CACHE_TTL_MS = 30 * 1000;

// Non-HTTPS AIM endpoints are rejected outside of tests. A trustScore of 1.0
// returned from an attacker-controlled localhost endpoint would otherwise
// bypass detection escalation.
//
// Parse the URL with `new URL()` rather than string-matching the prefix.
// `http://localhost@attacker.com` and `http://127.0.0.1.attacker.com`
// both pass a naive `startsWith` check but resolve to `attacker.com`.
function isAllowedBaseUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol !== 'http:') return false;
  // http:// only allowed for the exact localhost loopback hostname in
  // test mode. Anything that resolves elsewhere is rejected.
  const host = parsed.hostname.toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') {
    return false;
  }
  return typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';
}

const cache = new Map<string, CacheEntry>();

/**
 * Build a cache key from agent type and origin.
 */
function cacheKey(agentType: string, origin: string): string {
  return `${agentType}:${origin}`;
}

/**
 * Look up an agent's identity and trust score from AIM.
 *
 * Calls GET /api/v1/sdk-api/agents/:identifier where identifier
 * is the agent type (name). The AIM server returns a full Agent
 * object with trustScore (float64) and displayName (string).
 *
 * Returns a discriminated result so callers can distinguish
 * `unreachable` (no signal) from `unregistered` (informational only)
 * from `ok` (a real trust score). `ok` and `unregistered` use the full
 * cacheTtlMs; `unreachable` uses a much shorter negative-cache window
 * (UNREACHABLE_CACHE_TTL_MS) so a transient outage backs off the
 * network but recovers quickly when AIM returns.
 */
export async function lookupAgentIdentity(
  agentType: string,
  origin: string,
  options?: { baseUrl?: string; cacheTtlMs?: number }
): Promise<AIMLookupResult> {
  const baseUrl = options?.baseUrl ?? DEFAULT_AIM_BASE_URL;
  const ttl = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  const key = cacheKey(agentType, origin);

  // Cache unreachable (short TTL) the same as other outcomes so a brief
  // outage doesn't fire a fetch per page navigation.
  function rememberUnreachable(): AIMLookupResult {
    const result: AIMLookupResult = { status: 'unreachable' };
    cache.set(key, { result, expiresAt: Date.now() + UNREACHABLE_CACHE_TTL_MS });
    return result;
  }

  if (!isAllowedBaseUrl(baseUrl)) {
    // Misconfigured base URL is a permanent-until-settings-change condition.
    // Treat it as unreachable but don't cache — settings can change between
    // calls and we want the next read to re-evaluate.
    return { status: 'unreachable' };
  }

  // Check cache
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  try {
    const url = `${baseUrl}/api/v1/sdk-api/agents/${encodeURIComponent(agentType)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });

    if (response.status === 404) {
      const result: AIMLookupResult = {
        status: 'unregistered',
        label: agentType,
        registered: false,
      };
      cache.set(key, { result, expiresAt: Date.now() + ttl });
      return result;
    }

    if (!response.ok) {
      return rememberUnreachable();
    }

    // AIM Agent response shape: { trustScore: number, displayName: string, name: string, ... }
    const data = await response.json() as {
      trustScore?: number;
      displayName?: string;
      name?: string;
    };

    const result: AIMLookupResult = {
      status: 'ok',
      trustScore: typeof data.trustScore === 'number' ? data.trustScore : 0,
      label: typeof data.displayName === 'string' ? data.displayName
        : typeof data.name === 'string' ? data.name
        : agentType,
      registered: true,
    };

    cache.set(key, {
      result,
      expiresAt: Date.now() + ttl,
    });

    return result;
  } catch {
    // Network error, timeout, or parse failure
    return rememberUnreachable();
  }
}

/**
 * Clear the AIM lookup cache.
 * Useful for testing or when settings change.
 */
export function clearAIMCache(): void {
  cache.clear();
}

/**
 * Get the current cache size (for testing/debugging).
 */
export function getAIMCacheSize(): number {
  return cache.size;
}
