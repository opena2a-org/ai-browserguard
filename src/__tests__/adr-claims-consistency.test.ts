/**
 * Claims the ADRs and the release gate make about the code, checked against
 * the code.
 *
 * An ADR keeps the text it was accepted with. When the code later differs, the
 * ADR gains a dated correction note instead of a rewrite, as ADR-003 and
 * ADR-007 already do. Each test here reads a fact from the code and requires
 * the document that contradicts it to carry that note, so changing the fact
 * fails the test until the note changes with it. ADR-002 once gave the popup as
 * about 88 KB including a font that is larger than that on its own; ADR-003
 * named a Content Security Policy the popup HTML does not have; ADR-004
 * described Computer Use and Operator detection as action-sequence analysis
 * when it reads only the environment; ADR-009 and the release gate described
 * the store copy as pinned to v0.5.0 after 0.6.0 had rewritten it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'fs';
import { detectAnthropicComputerUse, detectOpenAIOperator } from '../detection/automation';

function read(relPath: string): string {
  return readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf-8');
}

/** The text of each dated `> **Correction (YYYY-MM-DD).**` blockquote, on one line. */
function correctionNotes(markdown: string): string[] {
  const blocks: string[][] = [];
  let open = false;
  for (const raw of markdown.split('\n')) {
    const quoted = /^\s*> ?(.*)$/.exec(raw);
    if (!quoted) {
      open = false;
      continue;
    }
    if (!open) blocks.push([]);
    open = true;
    blocks[blocks.length - 1].push(quoted[1]);
  }
  return blocks
    .map((lines) => lines.join(' ').replace(/\s+/g, ' ').trim())
    .filter((note) => /^\*\*Correction \(\d{4}-\d{2}-\d{2}\)/.test(note));
}

/** The one correction note that mentions `subject`. */
function noteAbout(markdown: string, subject: string): string {
  const found = correctionNotes(markdown).filter((note) => note.includes(subject));
  expect(found, `expected exactly one dated correction note mentioning "${subject}"`).toHaveLength(1);
  return found[0];
}

/** The single line of a Markdown file that contains `marker`. */
function line(markdown: string, marker: string): string {
  const found = markdown.split('\n').filter((l) => l.includes(marker));
  expect(found, `expected exactly one line containing "${marker}"`).toHaveLength(1);
  return found[0];
}

describe('ADR-002: popup bundle size', () => {
  const adr = read('docs/adr/002-vanilla-ts-no-framework.md');
  const note = () => noteAbout(adr, 'inter-latin.woff2');

  it('states the size of the font the build copies in', () => {
    const fontBytes = statSync(new URL('../../fonts/inter-latin.woff2', import.meta.url)).size;
    expect(note()).toContain(`${fontBytes.toLocaleString('en-US')} bytes`);
  });

  it('says popup.js ships with an inline source map, as vite.config.ts sets', () => {
    expect(read('vite.config.ts')).toMatch(/sourcemap:\s*'inline'/);
    expect(note()).toContain("sourcemap: 'inline'");
  });
});

describe('ADR-003: popup Content Security Policy', () => {
  it('says the popup declares no policy of its own and the Manifest V3 default applies', () => {
    expect(read('src/popup/index.html')).not.toMatch(/Content-Security-Policy/i);
    expect(JSON.parse(read('manifest.json'))).not.toHaveProperty('content_security_policy');

    const note = noteAbout(read('docs/adr/003-local-only-processing.md'), 'src/popup/index.html');
    expect(note).toContain('no Content Security Policy');
    expect(note).toContain('`content_security_policy`');
  });
});

describe('ADR-004: Computer Use and Operator detection', () => {
  const ENVIRONMENT_SIGNALS = [
    'webglRenderer',
    'screenWidth',
    'screenHeight',
    'platform',
    'userAgent',
    'pluginCount',
  ];

  it('says both detectors read only the environment', () => {
    for (const result of [detectAnthropicComputerUse(), detectOpenAIOperator()]) {
      for (const signal of Object.keys(result.signals)) {
        expect(ENVIRONMENT_SIGNALS).toContain(signal);
      }
    }

    const note = noteAbout(read('docs/adr/004-detection-pipeline-design.md'), 'src/detection/automation.ts');
    expect(note).toContain('No sequence or navigation-pattern analysis');
    expect(note).toContain('`detectAnthropicComputerUse`');
    expect(note).toContain('`detectOpenAIOperator`');
  });
});

describe('ADR-009 and the release gate: store copy', () => {
  it('describe the store copy as already disclosing site safety declarations', () => {
    for (const path of ['docs/chrome-web-store-description.md', 'docs/store-listing.md']) {
      expect(read(path), path).toContain('/.well-known/ai-safety.txt');
    }

    const note = noteAbout(read('docs/adr/009-ai-safety-txt-consumer.md'), '`docs/store-listing.md`');
    expect(note).toContain('0.6.0');

    const gate = read('docs/testing/release-smoke.md');
    expect(line(gate, '| Store listing |')).not.toMatch(/pinned to v0\.5\.0/);
    expect(noteAbout(gate, '`docs/store-listing.md`')).toContain('0.6.0');
  });
});
