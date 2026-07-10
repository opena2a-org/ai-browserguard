/**
 * Enforceability contract for detected agents (ADR-007 / ADR-008).
 *
 * Regression guard: the v0.4.2 popup rendered "Managed" and a "Read-Only" grant
 * for external CDP frameworks (Playwright/Cowork) it cannot enforce against.
 * These tests pin the presentation to the agent's actual enforceability so the
 * incorrect label cannot return.
 */
import { describe, it, expect } from 'vitest';
import {
  isExternalDriver,
  enforcementReality,
  nativeInputObservable,
  presentAgent,
  type AgentLike,
} from './enforceability';
import type { DelegationRule } from '../types/delegation';
import type { AgentType, DetectionMethod } from '../types/agent';

const agent = (type: AgentType, detectionMethods: DetectionMethod[]): AgentLike => ({ type, detectionMethods });
const READ_ONLY = { preset: 'readOnly', isActive: true } as unknown as DelegationRule;

describe('isExternalDriver', () => {
  it('is true for every known external framework type', () => {
    for (const t of ['playwright', 'puppeteer', 'selenium', 'anthropic-computer-use', 'openai-operator', 'cdp-generic', 'webdriver-generic'] as AgentType[]) {
      expect(isExternalDriver(agent(t, []))).toBe(true);
    }
  });

  it('is true for unknown-type agents with any external-driver or native-input signal, or no signal', () => {
    expect(isExternalDriver(agent('unknown', ['cdp-connection']))).toBe(true);
    expect(isExternalDriver(agent('unknown', ['webdriver-flag']))).toBe(true);
    expect(isExternalDriver(agent('unknown', ['automation-flag']))).toBe(true);
    // behavioural methods are inferred from NATIVE input -> not observable -> external
    expect(isExternalDriver(agent('unknown', ['behavioral-timing']))).toBe(true);
    expect(isExternalDriver(agent('unknown', ['behavioral-typing']))).toBe(true);
    // no evidence at all -> fail safe to external
    expect(isExternalDriver(agent('unknown', []))).toBe(true);
    // a page-realm signal mixed with a non-page-realm one is still external
    expect(isExternalDriver(agent('unknown', ['synthetic-event', 'cdp-connection']))).toBe(true);
  });

  it('is false only for unknown-type agents whose signals are all page-realm', () => {
    expect(isExternalDriver(agent('unknown', ['synthetic-event']))).toBe(false);
    expect(isExternalDriver(agent('unknown', ['framework-fingerprint']))).toBe(false);
    expect(isExternalDriver(agent('unknown', ['synthetic-event', 'framework-fingerprint']))).toBe(false);
  });
});

describe('enforcementReality / nativeInputObservable', () => {
  it('reports none + unobservable for external drivers', () => {
    const a = agent('playwright', ['cdp-connection']);
    expect(enforcementReality(a)).toBe('none');
    expect(nativeInputObservable(a)).toBe(false);
  });
  it('reports page-realm-best-effort + observable for in-page agents', () => {
    const a = agent('unknown', ['synthetic-event']);
    expect(enforcementReality(a)).toBe('page-realm-best-effort');
    expect(nativeInputObservable(a)).toBe(true);
  });
});

describe('presentAgent — the enforceability contract', () => {
  it('regression: an external driver under a Read-Only rule is NEVER "Managed" and is not enforceable', () => {
    const p = presentAgent(agent('playwright', ['cdp-connection']), READ_ONLY);
    expect(p.enforceable).toBe(false);
    expect(p.badge).not.toBe('Managed');
    expect(p.badge).toBe('Monitor only');
    expect(p.ruleCaveat).toBeTruthy();
    expect(p.ruleCaveat).toMatch(/kill switch|not enforced/i);
  });

  it('external driver with no rule still shows monitor-only, no caveat', () => {
    const p = presentAgent(agent('cdp-generic', ['cdp-connection']), null);
    expect(p.enforceable).toBe(false);
    expect(p.badge).toBe('Monitor only');
    expect(p.ruleCaveat).toBeNull();
  });

  it('in-page agent under a rule may be best-effort managed (best-effort qualifier present)', () => {
    const p = presentAgent(agent('unknown', ['synthetic-event']), READ_ONLY);
    expect(p.enforceable).toBe(true);
    expect(p.badge).toMatch(/best-effort/i);
  });

  it('in-page agent with no rule is just "Detected"', () => {
    const p = presentAgent(agent('unknown', ['synthetic-event']), null);
    expect(p.badge).toBe('Detected');
  });
});
