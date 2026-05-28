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

export interface AIMResult {
  /** Trust score between 0.0 and 1.0. */
  trustScore: number;
  /** Human-readable display name for the agent. */
  label: string;
  /** Whether the agent is registered in AIM. */
  registered: boolean;
}

interface CacheEntry {
  result: AIMResult;
  expiresAt: number;
}

const DEFAULT_AIM_BASE_URL = 'https://aim.opena2a.org';
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Non-HTTPS AIM endpoints are rejected outside of tests. A trustScore of 1.0
// returned from an attacker-controlled localhost endpoint would otherwise
// bypass detection escalation.
function isAllowedBaseUrl(url: string): boolean {
  if (url.startsWith('https://')) return true;
  // Permit http only for localhost in test/development. We detect the test
  // environment via process.env.NODE_ENV when available; otherwise we accept
  // localhost http exclusively (covers self-hosted AIM during development).
  if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) {
    return typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';
  }
  return false;
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
 * Returns null on any failure (network error, timeout, non-200
 * response) so callers can fall back gracefully. A 404 means the
 * agent is not registered; the result reflects that.
 */
export async function lookupAgentIdentity(
  agentType: string,
  origin: string,
  options?: { baseUrl?: string; cacheTtlMs?: number }
): Promise<AIMResult | null> {
  const baseUrl = options?.baseUrl ?? DEFAULT_AIM_BASE_URL;
  const ttl = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  if (!isAllowedBaseUrl(baseUrl)) {
    return null;
  }

  const key = cacheKey(agentType, origin);

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
      // Agent not registered in AIM
      const result: AIMResult = {
        trustScore: 0,
        label: agentType,
        registered: false,
      };
      cache.set(key, { result, expiresAt: Date.now() + ttl });
      return result;
    }

    if (!response.ok) {
      return null;
    }

    // AIM Agent response shape: { trustScore: number, displayName: string, name: string, ... }
    const data = await response.json() as {
      trustScore?: number;
      displayName?: string;
      name?: string;
    };

    const result: AIMResult = {
      trustScore: typeof data.trustScore === 'number' ? data.trustScore : 0,
      label: typeof data.displayName === 'string' ? data.displayName
        : typeof data.name === 'string' ? data.name
        : agentType,
      registered: true,
    };

    // Store in cache
    cache.set(key, {
      result,
      expiresAt: Date.now() + ttl,
    });

    return result;
  } catch {
    // Network error, timeout, or parse failure
    return null;
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
