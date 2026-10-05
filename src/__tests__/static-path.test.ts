/**
 * Static server path containment for the smoke scripts.
 *
 * The popup layout smoke serves dist/ over HTTP. Its containment check was a
 * string prefix, so files next to dist/ whose names start with "dist"
 * (dist.zip, dist-archive/) were served too. These cases pin the
 * segment-based check in scripts/static-path.mjs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, sep } from 'path';
import { resolveStaticPath } from '../../scripts/static-path.mjs';

const ROOT = join(sep, 'srv', 'repo', 'dist');

describe('resolveStaticPath', () => {
  it('resolves a file under the root and drops the query string', () => {
    expect(resolveStaticPath(ROOT, '/popup/index.html')).toBe(join(ROOT, 'popup', 'index.html'));
    expect(resolveStaticPath(ROOT, '/popup/index.html?scenario=fresh')).toBe(join(ROOT, 'popup', 'index.html'));
  });

  it('returns the root itself for "/" so the caller can reject the directory', () => {
    expect(resolveStaticPath(ROOT, '/')).toBe(ROOT);
    expect(resolveStaticPath(ROOT, undefined)).toBe(ROOT);
  });

  it('rejects a sibling of the root that shares its name as a prefix', () => {
    expect(resolveStaticPath(ROOT, 'http://h/../../../dist.zip')).toBeNull();
    expect(resolveStaticPath(ROOT, '../dist.zip')).toBeNull();
    expect(resolveStaticPath(ROOT, '../dist-archive/dist-v0.7.0.zip')).toBeNull();
  });

  it('rejects paths that leave the root', () => {
    expect(resolveStaticPath(ROOT, '../package.json')).toBeNull();
    expect(resolveStaticPath(ROOT, '..')).toBeNull();
  });

  it('keeps encoded parent segments of an absolute path inside the root', () => {
    expect(resolveStaticPath(ROOT, '/%2e%2e/%2e%2e/dist.zip')).toBe(join(ROOT, 'dist.zip'));
  });

  it('accepts a name that only starts with two dots', () => {
    expect(resolveStaticPath(ROOT, '/..notes.txt')).toBe(join(ROOT, '..notes.txt'));
  });

  it('returns null for malformed percent-encoding instead of throwing', () => {
    expect(resolveStaticPath(ROOT, '/%E0%A4%A')).toBeNull();
  });
});

describe('smoke-popup-layout static server', () => {
  const src = readFileSync(new URL('../../scripts/smoke-popup-layout.mjs', import.meta.url), 'utf-8');

  it('resolves request paths through resolveStaticPath, not a string prefix', () => {
    expect(src).toMatch(/resolveStaticPath\(DIST, req\.url\)/);
    expect(src).not.toMatch(/\.startsWith\(DIST\)/);
  });
});
