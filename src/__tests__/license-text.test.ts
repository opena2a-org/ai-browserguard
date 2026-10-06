/**
 * LICENSE text.
 *
 * LICENSE is the Apache License 2.0 as published, including the appendix on
 * applying the license, with the boilerplate notice's copyright line filled in.
 * Edits to the terms or a dropped appendix make the file differ from the
 * published text, so this test hashes LICENSE against it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

// SHA-256 of https://www.apache.org/licenses/LICENSE-2.0.txt. That file opens
// with one blank line that LICENSE leaves out, so the test adds it back.
const PUBLISHED_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
const PLACEHOLDER_LINE = '   Copyright [yyyy] [name of copyright owner]';
const COPYRIGHT_LINE = /^ {3}Copyright .+$/gm;

describe('LICENSE', () => {
  const text = readFileSync(new URL('../../LICENSE', import.meta.url), 'utf-8');

  it('keeps the appendix on applying the license', () => {
    expect(text).toContain('\n   APPENDIX: How to apply the Apache License to your work.\n');
  });

  it('has one copyright line, in the boilerplate notice', () => {
    expect(text.match(COPYRIGHT_LINE)).toHaveLength(1);
  });

  it('matches the published Apache-2.0 text apart from the copyright line', () => {
    const published = '\n' + text.replace(COPYRIGHT_LINE, PLACEHOLDER_LINE);
    expect(createHash('sha256').update(published).digest('hex')).toBe(PUBLISHED_SHA256);
  });
});
