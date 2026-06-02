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
});
