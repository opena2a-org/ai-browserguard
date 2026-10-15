/**
 * @vitest-environment jsdom
 *
 * Regression (#122): the in-page block notice was wider than a phone viewport.
 * `.abg-toast` was `width: 340px; max-width: 90vw` under the default
 * content-box sizing, so its 12px side padding and 1px border were added to
 * the capped width, and the container holding it sits 16px from the right
 * edge. At a 375px viewport that put the notice's left edge at x = -4.5.
 *
 * jsdom lays nothing out, so this test reads the declarations the notice is
 * styled with and works out the box from them by the CSS box model.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import '../__tests__/setup';
import { showBlockedToast } from './toast';

/** The declarations of the rule for exactly `selector` in the notice's stylesheet. */
function declarations(selector: string): Record<string, string> {
  document.getElementById('abg-toast-container')?.remove();
  showBlockedToast({ capability: 'type-text', url: 'https://example.com/page', reason: '' });
  const host = document.getElementById('abg-toast-container') as (HTMLElement & { _inner?: HTMLElement }) | null;
  const css = (host?._inner?.parentNode as ShadowRoot | null)?.querySelector('style')?.textContent ?? '';
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  expect(body, `the stylesheet must have a rule for ${selector}`).toBeDefined();
  const out: Record<string, string> = {};
  for (const declaration of body!.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon > 0) out[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
  }
  return out;
}

const px = (value: string): number => {
  expect(value).toMatch(/^\d+(\.\d+)?px$/);
  return parseFloat(value);
};

/**
 * The notice's left and right edge in a viewport `viewport` px wide whose page
 * shows a classic scrollbar `scrollbar` px wide. `100vw` counts the scrollbar;
 * the side offsets of the fixed container, and so a percentage of its width,
 * are measured inside it.
 */
function noticeEdges(viewport: number, scrollbar = 0): { left: number; right: number } {
  const toast = declarations('.abg-toast');
  const container = declarations('.abg-toast-inner');
  const content = viewport - scrollbar;

  const calc = toast['max-width'].match(/^calc\(100vw - (\d+)px\)$/);
  const vw = toast['max-width'].match(/^(\d+)vw$/);
  const percent = toast['max-width'].match(/^(\d+)%$/);
  expect(calc ?? vw ?? percent, `max-width "${toast['max-width']}" must be N%, Nvw or calc(100vw - Npx)`).not.toBeNull();
  let cap: number;
  if (percent) {
    // A percentage of the container's width, which is definite only when
    // both of its side offsets are set.
    expect(container.left, 'a percentage max-width needs the container\'s left offset').toBeDefined();
    cap = ((content - px(container.left) - px(container.right)) * Number(percent[1])) / 100;
  } else {
    cap = calc ? viewport - Number(calc[1]) : (viewport * Number(vw![1])) / 100;
  }

  const sized = Math.min(px(toast.width), cap);
  const [, sidePadding] = toast.padding.split(/\s+/);
  const extras = 2 * px(sidePadding) + 2 * px(toast.border.split(/\s+/)[0]);
  const outer = toast['box-sizing'] === 'border-box' ? sized : sized + extras;

  // A container wider than the notice holds it at its right edge only when
  // its items are aligned to the end.
  if (container.left !== undefined) expect(container['align-items']).toBe('flex-end');
  const right = content - px(container.right);
  return { left: right - outer, right };
}

describe('in-page block notice width', () => {
  beforeEach(() => {
    document.getElementById('abg-toast-container')?.remove();
  });

  it.each([320, 375])('fits a %ipx viewport with 16px to spare on each side', (viewport) => {
    expect(noticeEdges(viewport)).toEqual({ left: 16, right: viewport - 16 });
  });

  it('is 366px wide where the viewport has room for it', () => {
    const { left, right } = noticeEdges(1280);
    expect(right - left).toBe(366);
  });

  // Regression (#126): capped at calc(100vw - 32px), the notice spanned
  // x = -1 to 342 at a 375px viewport whose page shows a 17px scrollbar.
  it.each([320, 375])('fits a %ipx viewport with a 17px scrollbar with 16px to spare on each side', (viewport) => {
    expect(noticeEdges(viewport, 17)).toEqual({ left: 16, right: viewport - 17 - 16 });
  });

  it('is 366px wide beside a 17px scrollbar where the viewport has room for it', () => {
    const { left, right } = noticeEdges(1280, 17);
    expect(right - left).toBe(366);
  });
});
