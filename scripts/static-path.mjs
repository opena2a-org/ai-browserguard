/**
 * Request URL to file path for the smoke scripts' local static servers.
 *
 * Containment is decided by path.relative, not by a string prefix: with root
 * `/repo/dist`, the prefix test `file.startsWith(root)` also accepts
 * `/repo/dist.zip` and `/repo/dist-archive/...`, which share the name but sit
 * outside the directory being served.
 */
import { isAbsolute, join, normalize, relative, sep } from 'path';

/**
 * Resolve the path part of `requestUrl` under `root`.
 *
 * Returns the absolute file path, or null when the URL is not valid
 * percent-encoding or the path resolves outside `root`. The returned path may
 * not exist and may be `root` itself; the caller checks both.
 *
 * @param {string} root absolute directory being served
 * @param {string | undefined} requestUrl `req.url` as received
 * @returns {string | null}
 */
export function resolveStaticPath(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent((requestUrl ?? '/').split('?')[0]);
  } catch {
    return null;
  }
  const file = join(root, normalize(pathname).replace(/^([/\\])+/, ''));
  const fromRoot = relative(root, file);
  if (fromRoot.split(sep)[0] === '..' || isAbsolute(fromRoot)) return null;
  return file;
}
