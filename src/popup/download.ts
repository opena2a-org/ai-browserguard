/**
 * Client-side file download helper for the popup.
 *
 * Why this exists: the popup runs inside the MV3 extension action popup, a
 * transient window that can be torn down the moment it loses focus. The
 * original export code created an anchor, never attached it to the DOM, called
 * `a.click()`, then revoked the object URL *synchronously* on the next line.
 * That synchronous revoke races the browser's async read of the blob, and in
 * the action-popup context the download silently never lands. (In a normal
 * page the same code happens to work, which is why it passed casual testing.)
 *
 * The fix has two layers, matching the product decision to keep the cheap path
 * but guarantee delivery:
 *   1. Hardened anchor: attach to the DOM, click, and defer the revoke + node
 *      removal to a later task so the browser can start the download first.
 *   2. Service-worker fallback: if the anchor path throws (e.g. blob URLs are
 *      unavailable in the context), hand the bytes to the background service
 *      worker, which is non-transient and downloads via chrome.downloads.
 *
 * The function is dependency-injected so the revoke timing and the fallback can
 * be asserted deterministically in jsdom without a real browser download.
 */

export type DownloadMethod = 'anchor' | 'service-worker';

export interface DownloadDeps {
  /** Document to create/attach the anchor in. Defaults to the global document. */
  doc?: Document;
  /** Defaults to URL.createObjectURL. */
  createObjectURL?: (blob: Blob) => string;
  /** Defaults to URL.revokeObjectURL. */
  revokeObjectURL?: (url: string) => void;
  /** Defer callback (revoke + cleanup). Defaults to setTimeout(..., 0). */
  defer?: (fn: () => void) => void;
  /**
   * Service-worker fallback, invoked only if the anchor path throws. Receives
   * the same filename + JSON so the worker can download via chrome.downloads.
   */
  fallback?: (filename: string, json: string) => Promise<void>;
}

/**
 * Trigger a JSON file download. Returns which path was used.
 * Throws only if the anchor path fails and no fallback is provided (or the
 * fallback itself rejects).
 */
export async function triggerJsonDownload(
  filename: string,
  json: string,
  deps: DownloadDeps = {}
): Promise<DownloadMethod> {
  const doc = deps.doc ?? document;
  const createObjectURL =
    deps.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectURL =
    deps.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
  const defer =
    deps.defer ?? ((fn: () => void) => { setTimeout(fn, 0); });

  try {
    const blob = new Blob([json], { type: 'application/json' });
    const url = createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    // Attach before click: some engines ignore .click() on a detached anchor.
    doc.body.appendChild(a);
    a.click();
    // Defer revoke + removal so the browser can begin reading the blob.
    // Revoking synchronously here is the original bug.
    defer(() => {
      revokeObjectURL(url);
      a.remove();
    });
    return 'anchor';
  } catch (err) {
    if (deps.fallback) {
      await deps.fallback(filename, json);
      return 'service-worker';
    }
    throw err;
  }
}
