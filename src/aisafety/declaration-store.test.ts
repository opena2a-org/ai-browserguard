/**
 * The in-memory declaration store, tested by outcome.
 *
 * It exists so the opt-out reconcile can empty it via an IMPORT rather than an
 * injected closure -- the `clearInMemory: () => {}` miswiring that shipped and
 * survived the whole suite. The reconcile's use of clearInMemoryDeclarations is
 * asserted in optout.test.ts; this file locks the store's own behaviour.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setDeclaration,
  deleteDeclaration,
  clearInMemoryDeclarations,
  getInMemoryDeclarations,
  inMemoryDeclarationCount,
} from './declaration-store';
import type { StoredDeclaration } from './attribution';

const A: StoredDeclaration = { origin: 'https://a.example', result: { status: 'ok', declaration: { aiSafe: true } } };
const B: StoredDeclaration = { origin: 'https://b.example', result: { status: 'none' } };

beforeEach(() => {
  // Module singleton: not reset by the global storage reset.
  clearInMemoryDeclarations();
});

describe('declaration-store', () => {
  it('stores and reads back an entry by tabId', () => {
    setDeclaration(1, A);
    expect(getInMemoryDeclarations().get(1)).toEqual(A);
    expect(inMemoryDeclarationCount()).toBe(1);
  });

  it('overwrites the entry for a reused tabId rather than duplicating', () => {
    setDeclaration(1, A);
    setDeclaration(1, B);
    expect(getInMemoryDeclarations().get(1)).toEqual(B);
    expect(inMemoryDeclarationCount()).toBe(1);
  });

  it('deletes a single tab without touching the others', () => {
    setDeclaration(1, A);
    setDeclaration(2, B);
    deleteDeclaration(1);
    expect(getInMemoryDeclarations().get(1)).toBeUndefined();
    expect(getInMemoryDeclarations().get(2)).toEqual(B);
    expect(inMemoryDeclarationCount()).toBe(1);
  });

  it('clearInMemoryDeclarations empties the whole store', () => {
    setDeclaration(1, A);
    setDeclaration(2, B);
    clearInMemoryDeclarations();
    expect(inMemoryDeclarationCount()).toBe(0);
    expect(getInMemoryDeclarations().size).toBe(0);
  });

  it('exposes the live map, so a reader sees later writes', () => {
    const live = getInMemoryDeclarations();
    setDeclaration(3, A);
    expect(live.get(3)).toEqual(A);
  });
});
