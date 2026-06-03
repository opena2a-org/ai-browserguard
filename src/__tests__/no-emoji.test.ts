import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve, extname } from 'path';

/**
 * Lock-in: no emoji in shipped UI source.
 *
 * House style bans emoji in product code (use SVG / CSS / icons instead). This
 * guard exists because two emoji shipped undetected in v0.4.0 -- a shield
 * (\u{1F6E1}) in the block toast and a gear (&#9881;) on the settings button --
 * each in a *different* encoding, which is why an ad-hoc grep missed one. This
 * test catches all three encodings: raw codepoint, JS \u escape, and HTML
 * numeric entity.
 *
 * Scope: src/, excluding test files (which legitimately reference emoji to
 * assert their absence) and *.snap. Monochrome typographic glyphs that are not
 * emoji are allowed (e.g. the multiplication-sign close glyph U+00D7 and the
 * U+21B3 downwards-arrow-with-tip used for the session-event tree).
 */

const SRC = resolve(__dirname, '..');

// Emoji / pictograph codepoint ranges. Deliberately excludes the Arrows block
// (U+2190-U+21FF) and Latin-1 punctuation so non-emoji glyphs stay allowed.
const EMOJI_RANGES: Array<[number, number]> = [
  [0x2600, 0x26ff], // Misc Symbols (gear, warning, etc.)
  [0x2700, 0x27bf], // Dingbats (check marks, crosses)
  [0x2b00, 0x2bff], // Misc Symbols and Arrows (stars)
  [0x1f000, 0x1faff], // emoji / pictographs / supplemental
  [0xfe0f, 0xfe0f], // emoji variation selector
];

function isEmojiCodepoint(cp: number): boolean {
  return EMOJI_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!['.ts', '.html', '.css'].includes(extname(entry))) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) continue;
    out.push(full);
  }
  return out;
}

// Raw-codepoint emoji matcher, expressed as a Unicode-range regex (mirrors
// EMOJI_RANGES). Using a range regex instead of per-character codePointAt()
// keeps this scanner free of the runtime-decode shape that static analyzers
// (correctly) flag in invisible-Unicode payload decoders.
const RAW_EMOJI_RE = /[\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1FAFF}\u{FE0F}]/gu;

function findEmoji(content: string): Array<{ line: number; kind: string; match: string }> {
  const hits: Array<{ line: number; kind: string; match: string }> = [];
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    // 1. Raw codepoints
    for (const m of line.matchAll(RAW_EMOJI_RE)) {
      hits.push({ line: i + 1, kind: 'raw', match: m[0] });
    }
    // 2. JS \u{XXXXX} and \uXXXX escapes
    for (const m of line.matchAll(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g)) {
      const cp = parseInt(m[1] ?? m[2], 16);
      if (isEmojiCodepoint(cp)) hits.push({ line: i + 1, kind: 'js-escape', match: m[0] });
    }
    // 3. HTML numeric entities &#NNNN; and &#xHHHH;
    for (const m of line.matchAll(/&#(\d+);|&#x([0-9a-fA-F]+);/g)) {
      const cp = m[1] ? parseInt(m[1], 10) : parseInt(m[2], 16);
      if (isEmojiCodepoint(cp)) hits.push({ line: i + 1, kind: 'html-entity', match: m[0] });
    }
  });
  return hits;
}

describe('no emoji in shipped UI source', () => {
  const files = listSourceFiles(SRC);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('contains no emoji in any encoding (raw / \\u escape / HTML entity)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(SRC.length + 1);
      for (const hit of findEmoji(readFileSync(file, 'utf-8'))) {
        offenders.push(`  ${rel}:${hit.line} [${hit.kind}] ${JSON.stringify(hit.match)}`);
      }
    }
    expect(
      offenders,
      `Emoji found in shipped source. Use an inline SVG / CSS mark instead.\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
