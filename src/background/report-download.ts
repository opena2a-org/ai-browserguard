/**
 * Service-worker side of the report export download.
 *
 * The popup hands us the report bytes when its in-popup anchor download is not
 * viable (transient popup teardown). MV3 service workers have no DOM and no
 * URL.createObjectURL, so we build a base64 data: URL and hand it to
 * chrome.downloads, which runs in the (non-transient) worker context.
 *
 * Kept as a pure, exported helper so the filename sanitization and UTF-8 safe
 * base64 encoding are unit-testable without a live download.
 */

export interface ReportDownloadArgs {
  url: string;
  filename: string;
}

/**
 * Coerce a popup-supplied filename into a safe, flat `.json` basename.
 * chrome.downloads rejects path separators and traversal, so we reduce to a
 * single sanitized basename and guarantee the `.json` extension. Defense in
 * depth even though the popup currently derives the name from internal ids.
 */
export function sanitizeDownloadFilename(name?: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  const safe = cleaned.length > 0 ? cleaned : 'report.json';
  return safe.toLowerCase().endsWith('.json') ? safe : `${safe}.json`;
}

/**
 * Build the chrome.downloads.download() arguments for a JSON report.
 * Encodes UTF-8 first so non-ASCII report content (domains, agent labels)
 * survives the base64 round-trip (btoa is Latin-1 only).
 */
export function buildReportDownloadArgs(filename: string, json: string): ReportDownloadArgs {
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return {
    url: `data:application/json;base64,${b64}`,
    filename: sanitizeDownloadFilename(filename),
  };
}
