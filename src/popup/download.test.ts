import { describe, it, expect, vi } from 'vitest';
import { triggerJsonDownload } from './download';

/**
 * Regression coverage for the popup report-export download.
 *
 * The original bug: the anchor was never attached to the DOM and the object
 * URL was revoked *synchronously* right after click(), which races the
 * browser's async blob read and silently drops the download in the MV3 action
 * popup. These tests lock in the two fixes (attach-before-click, deferred
 * revoke) and the service-worker fallback.
 */

interface FakeAnchor {
  href: string;
  download: string;
  rel: string;
  style: { display: string };
  click: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  _appended: boolean;
}

function makeFakeDoc() {
  const order: string[] = [];
  const anchor: FakeAnchor = {
    href: '',
    download: '',
    rel: '',
    style: { display: '' },
    click: vi.fn(() => order.push('click')),
    remove: vi.fn(() => order.push('remove')),
    _appended: false,
  };
  const doc = {
    createElement: vi.fn(() => anchor),
    body: {
      appendChild: vi.fn((el: FakeAnchor) => { el._appended = true; order.push('append'); return el; }),
    },
  } as unknown as Document;
  return { doc, anchor, order };
}

describe('triggerJsonDownload (popup export)', () => {
  it('attaches the anchor to the DOM before clicking it', async () => {
    const { doc, anchor, order } = makeFakeDoc();
    await triggerJsonDownload('report-abcd1234.json', '{"a":1}', {
      doc,
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: vi.fn(),
      defer: () => { /* never run synchronously in this test */ },
    });
    expect(anchor._appended).toBe(true);
    expect(anchor.click).toHaveBeenCalledTimes(1);
    // append must come before click
    expect(order.indexOf('append')).toBeLessThan(order.indexOf('click'));
    expect(anchor.download).toBe('report-abcd1234.json');
    expect(anchor.href).toBe('blob:fake');
  });

  it('does NOT revoke the object URL synchronously (the original bug)', async () => {
    const { doc } = makeFakeDoc();
    const revokeObjectURL = vi.fn();
    let deferred: (() => void) | null = null;
    await triggerJsonDownload('r.json', '{}', {
      doc,
      createObjectURL: () => 'blob:fake',
      revokeObjectURL,
      defer: (fn) => { deferred = fn; },
    });
    // At this point the click has fired but revoke must not have run yet.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(deferred).toBeTypeOf('function');
    // Running the deferred task performs the cleanup.
    deferred!();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('removes the anchor node on the deferred cleanup tick', async () => {
    const { doc, anchor } = makeFakeDoc();
    let deferred: (() => void) | null = null;
    await triggerJsonDownload('r.json', '{}', {
      doc,
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: vi.fn(),
      defer: (fn) => { deferred = fn; },
    });
    expect(anchor.remove).not.toHaveBeenCalled();
    deferred!();
    expect(anchor.remove).toHaveBeenCalledTimes(1);
  });

  it('returns "anchor" when the in-popup path succeeds', async () => {
    const { doc } = makeFakeDoc();
    const method = await triggerJsonDownload('r.json', '{}', {
      doc,
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: vi.fn(),
      defer: () => {},
    });
    expect(method).toBe('anchor');
  });

  it('falls back to the service worker when the anchor path throws', async () => {
    const { doc } = makeFakeDoc();
    const fallback = vi.fn(() => Promise.resolve());
    const method = await triggerJsonDownload('report-x.json', '{"k":"v"}', {
      doc,
      createObjectURL: () => { throw new Error('blob URLs unavailable'); },
      revokeObjectURL: vi.fn(),
      fallback,
    });
    expect(method).toBe('service-worker');
    expect(fallback).toHaveBeenCalledWith('report-x.json', '{"k":"v"}');
  });

  it('rejects when the anchor path throws and there is no fallback', async () => {
    const { doc } = makeFakeDoc();
    await expect(
      triggerJsonDownload('r.json', '{}', {
        doc,
        createObjectURL: () => { throw new Error('boom'); },
        revokeObjectURL: vi.fn(),
      })
    ).rejects.toThrow('boom');
  });

  it('rejects when the anchor path throws and the fallback also rejects', async () => {
    // Guards the "success-on-failure" defect: a fallback that signals failure
    // (e.g. worker returned {ok:false}, which the popup turns into a throw)
    // must propagate, not resolve as a successful download.
    const { doc } = makeFakeDoc();
    await expect(
      triggerJsonDownload('r.json', '{}', {
        doc,
        createObjectURL: () => { throw new Error('blob unavailable'); },
        revokeObjectURL: vi.fn(),
        fallback: () => Promise.reject(new Error('service worker download failed')),
      })
    ).rejects.toThrow('service worker download failed');
  });
});
