import { describe, it, expect } from 'vitest';
import { sanitizeDownloadFilename, buildReportDownloadArgs } from './report-download';

describe('sanitizeDownloadFilename', () => {
  it('keeps a normal report filename', () => {
    expect(sanitizeDownloadFilename('report-abcd1234.json')).toBe('report-abcd1234.json');
  });

  it('strips directory components (no path traversal)', () => {
    expect(sanitizeDownloadFilename('../../etc/passwd.json')).toBe('passwd.json');
    expect(sanitizeDownloadFilename('/abs/path/report.json')).toBe('report.json');
    expect(sanitizeDownloadFilename('a\\b\\c.json')).toBe('c.json');
  });

  it('strips leading dots so it cannot become a dotfile', () => {
    expect(sanitizeDownloadFilename('...json').startsWith('.')).toBe(false);
  });

  it('replaces unsafe characters', () => {
    expect(sanitizeDownloadFilename('re port:*?.json')).toBe('re_port___.json');
  });

  it('guarantees a .json extension', () => {
    expect(sanitizeDownloadFilename('report')).toBe('report.json');
    expect(sanitizeDownloadFilename('report.JSON')).toBe('report.JSON');
  });

  it('falls back to a default when empty', () => {
    expect(sanitizeDownloadFilename('')).toBe('report.json');
    expect(sanitizeDownloadFilename(undefined)).toBe('report.json');
    expect(sanitizeDownloadFilename('////')).toBe('report.json');
  });

  it('keeps a .json suffix on a double-extension input (OS sees .json last)', () => {
    // Documents actual behavior: a non-.json tail gets .json appended, so the
    // effective extension the OS honors is always .json.
    expect(sanitizeDownloadFilename('report.json.exe')).toBe('report.json.exe.json');
    expect(sanitizeDownloadFilename('evil.sh')).toBe('evil.sh.json');
  });

  it('caps very long basenames', () => {
    const long = 'a'.repeat(500);
    const out = sanitizeDownloadFilename(`${long}.json`);
    expect(out.length).toBeLessThanOrEqual(120 + '.json'.length);
    expect(out.endsWith('.json')).toBe(true);
  });

  it('a leading-dots-only name does not become a dotfile', () => {
    // '...json' -> strip leading dots -> 'json' -> already ends with json? no
    // ('json' !== '*.json') -> 'json.json'. The point: never starts with '.'.
    const out = sanitizeDownloadFilename('...json');
    expect(out.startsWith('.')).toBe(false);
    expect(out).toBe('json.json');
  });
});

describe('buildReportDownloadArgs', () => {
  it('produces a base64 application/json data URL that round-trips', () => {
    const json = '{"sessionId":"abcd","note":"hello"}';
    const { url, filename } = buildReportDownloadArgs('report-abcd.json', json);
    expect(filename).toBe('report-abcd.json');
    expect(url.startsWith('data:application/json;base64,')).toBe(true);
    const decoded = decodeURIComponent(escape(atob(url.split(',')[1])));
    expect(decoded).toBe(json);
  });

  it('preserves non-ASCII content through the UTF-8 safe base64 path', () => {
    const json = JSON.stringify({ domain: 'münchen.de', agent: 'café-bot', emojiInData: '🛡' });
    const { url } = buildReportDownloadArgs('r.json', json);
    const decoded = decodeURIComponent(escape(atob(url.split(',')[1])));
    expect(decoded).toBe(json);
  });

  it('sanitizes the filename it returns', () => {
    const { filename } = buildReportDownloadArgs('../../../evil', '{}');
    expect(filename).toBe('evil.json');
  });

  it('does not throw on a lone surrogate in report content (worker fallback must survive)', () => {
    // JSON.stringify passes raw lone surrogates through; the old
    // encodeURIComponent path threw URIError and silently killed the fallback.
    const json = '{"originUrl":"https://x.test/\uD83D","ok":true}';
    expect(() => buildReportDownloadArgs('r.json', json)).not.toThrow();
    const { url } = buildReportDownloadArgs('r.json', json);
    expect(url.startsWith('data:application/json;base64,')).toBe(true);
    // It still decodes to valid JSON (lone surrogate replaced with U+FFFD).
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0))
    );
    expect(() => JSON.parse(decoded)).not.toThrow();
  });

  it('handles a large report without throwing (chunked base64)', () => {
    const json = JSON.stringify({ blob: 'x'.repeat(200_000) });
    expect(() => buildReportDownloadArgs('big.json', json)).not.toThrow();
  });
});
