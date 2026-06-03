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
/** Max basename length (excluding the .json suffix) to keep the path sane. */
const MAX_BASENAME_LEN = 120;

export function sanitizeDownloadFilename(name?: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  let cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (cleaned.length > MAX_BASENAME_LEN) cleaned = cleaned.slice(0, MAX_BASENAME_LEN);
  const safe = cleaned.length > 0 ? cleaned : 'report.json';
  return safe.toLowerCase().endsWith('.json') ? safe : `${safe}.json`;
}

/**
 * UTF-8 safe base64 that never throws on malformed input.
 *
 * The previous `btoa(unescape(encodeURIComponent(s)))` idiom throws
 * `URIError: URI malformed` on a lone surrogate, and report content includes
 * page-derived strings (URLs, agent labels) that JSON.stringify passes through
 * as raw lone surrogates. TextEncoder substitutes U+FFFD instead of throwing,
 * so the worker fallback cannot be killed by adversarial page content. Chunked
 * to avoid a stack overflow from String.fromCharCode on very large reports.
 */
function utf8ToBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Build the chrome.downloads.download() arguments for a JSON report.
 */
export function buildReportDownloadArgs(filename: string, json: string): ReportDownloadArgs {
  return {
    url: `data:application/json;base64,${utf8ToBase64(json)}`,
    filename: sanitizeDownloadFilename(filename),
  };
}
