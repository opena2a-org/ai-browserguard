/**
 * The store copy must not claim more than the extension does.
 *
 * Both listings state the observation scope: only page-realm agent actions are
 * recorded, and an external agent's native input is not observable. A Session
 * Timeline item that promised "all agent actions" contradicted that scope
 * paragraph a few lines above it. The timeline also stores target URLs and
 * element selectors taken from the page, so "No page content is read" was
 * false; the paste-ready text says what is true: page content is analyzed
 * locally and never transmitted.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

function read(relPath: string): string {
  return readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf-8');
}

const LISTINGS = ['docs/store-listing.md', 'docs/chrome-web-store-description.md'];

const HOST_PERMISSION_PRIVACY_SENTENCE = 'Page content is analyzed locally and is never transmitted.';

describe.each(LISTINGS)('%s', (path) => {
  const text = read(path);

  it('describes the session timeline as logging only the agent actions it can observe', () => {
    expect(text).not.toMatch(/all agent actions/i);
    expect(text).toMatch(/log of the agent actions it can observe/i);
  });

  it('does not claim that no page content is read', () => {
    expect(text).not.toMatch(/no page content is read/i);
  });

  it('states the host permission privacy terms in the paste-ready wording', () => {
    expect(text).toContain(HOST_PERMISSION_PRIVACY_SENTENCE);
  });
});
