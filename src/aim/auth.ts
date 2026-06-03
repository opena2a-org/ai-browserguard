/**
 * AIM auth state persistence for the extension.
 *
 * Stores a read-only AIM auth state in chrome.storage.local. The interactive
 * OAuth login (chrome.identity.launchWebAuthFlow) was removed: the extension
 * declares no `identity` permission and ships no login UI, so requesting it
 * would be an unused permission (the v0.3.0 Web Store rejection). Contribution
 * flush degrades to anonymous when no token is present.
 */

export interface AIMAuthState {
  isLoggedIn: boolean;
  accessToken: string | null;
  userEmail: string | null;
  expiresAt: string | null;
}

const AUTH_STORAGE_KEY = 'aimAuth';
const DEFAULT_AUTH_STATE: AIMAuthState = {
  isLoggedIn: false,
  accessToken: null,
  userEmail: null,
  expiresAt: null,
};

/**
 * Get the current AIM auth state from chrome.storage.local.
 */
export async function getAIMAuthState(): Promise<AIMAuthState> {
  try {
    const result = await chrome.storage.local.get(AUTH_STORAGE_KEY);
    return { ...DEFAULT_AUTH_STATE, ...(result[AUTH_STORAGE_KEY] ?? {}) };
  } catch {
    return { ...DEFAULT_AUTH_STATE };
  }
}

/**
 * Save AIM auth state to chrome.storage.local.
 */
export async function saveAIMAuthState(state: AIMAuthState): Promise<void> {
  await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: state });
}

/**
 * Log out of AIM and clear stored auth state.
 */
export async function logoutFromAIM(): Promise<void> {
  await saveAIMAuthState(DEFAULT_AUTH_STATE);
}

/**
 * Check if the current auth token is still valid.
 */
export function isTokenExpired(state: AIMAuthState): boolean {
  if (!state.expiresAt) return false;
  return new Date(state.expiresAt).getTime() < Date.now();
}
