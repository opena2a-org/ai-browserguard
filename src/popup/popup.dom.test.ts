/**
 * @vitest-environment jsdom
 *
 * P1-1 lock-in: enforce that popup.ts never re-introduces an HTML-injection sink.
 *
 * The popup renders user-controllable data (URLs, agent labels, settings
 * the user types). A regression that switches a `textContent` write back
 * to `innerHTML` (or any sibling sink that parses HTML strings) would re-
 * open XSS in the popup. We lock the no-sink rule in at test time because
 * this repo's "lint" step is `tsc --noEmit --strict`, not ESLint, so
 * there's no native config to host the rule.
 *
 * The banned-token list covers the full DOM-injection sink family the
 * popup might plausibly reach for, not just `innerHTML`:
 *
 *   - innerHTML        — assignment parses HTML
 *   - outerHTML        — same, replaces the element itself
 *   - insertAdjacentHTML — same, at a relative position
 *   - setHTMLUnsafe    — the explicit-opt-in raw-HTML sink (Trusted Types era)
 *   - document.write   — legacy HTML parser entry point
 *
 * The match runs after comment-stripping so future "// don't use innerHTML"
 * documentation does not trip it. The popup has no legitimate need to
 * touch any of these — `replaceChildren()`, `textContent`, and
 * `createElement` cover every use case observed in the audit.
 *
 * The grep-style assertion below is the load-bearing guarantee for the
 * no-sink rule; manual XSS testing remains the secondary check.
 *
 * The render tests at the end drive the real popup module in jsdom with a
 * mocked background: the download-block recovery block (one per screen,
 * never in a title) and the external-driver pill and caveat (#69).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import {
  CAPABILITY_BLOCK_HINT,
  CAPABILITY_BLOCK_DETAIL_BODY,
  CAPABILITY_BLOCK_DETAIL_LABEL,
} from './block-actions';
import { EXTERNAL_DRIVER_DOWNLOADS_ENFORCED_LABEL } from '../delegation/enforceability';
import { createRuleFromPreset } from '../delegation/rules';
import type { DelegationPreset, DelegationRule } from '../types/delegation';

const BANNED_SINK_PATTERN = /\b(innerHTML|outerHTML|insertAdjacentHTML|setHTMLUnsafe)\b|\bdocument\.write\b/;

/**
 * EVERY renderer in this directory, not just popup.ts.
 *
 * This was originally pinned to popup.ts alone. That was safe only while
 * popup.ts was the sole renderer; the moment a second one appeared the rule
 * silently stopped covering the popup. `ai-safety-row.ts` renders strings taken
 * verbatim from a hostile origin's /.well-known/ai-safety.txt (a site-supplied
 * Contact or Attestation URI), which is exactly the input this rule exists to
 * keep away from an HTML parser — and it would have been outside the guard.
 *
 * Enumerated from disk rather than listed, so a renderer added tomorrow is
 * covered without anyone remembering to add it here.
 */
const POPUP_SOURCES = readdirSync(__dirname)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .sort();

describe('popup HTML-injection sink lock-in (P1-1)', () => {
  it('covers every renderer in src/popup (not just popup.ts)', () => {
    expect(POPUP_SOURCES).toContain('popup.ts');
    expect(POPUP_SOURCES).toContain('ai-safety-row.ts');
  });

  it.each(POPUP_SOURCES)(
    '%s contains no innerHTML / outerHTML / insertAdjacentHTML / setHTMLUnsafe / document.write',
    (filename) => {
      const source = readFileSync(resolve(__dirname, filename), 'utf-8');
      const lines = source.split('\n');
      const offenders: { line: number; text: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const stripped = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
        if (BANNED_SINK_PATTERN.test(stripped)) {
          offenders.push({ line: i + 1, text: line.trim() });
        }
      }
      expect(
        offenders,
        `${filename} must use textContent / createElement / replaceChildren — not innerHTML, outerHTML, insertAdjacentHTML, setHTMLUnsafe, or document.write.\nOffenders:\n${offenders.map((o) => `  ${o.line}: ${o.text}`).join('\n')}`
      ).toEqual([]);
    }
  );

  const source = readFileSync(resolve(__dirname, 'popup.ts'), 'utf-8');

  it('uses replaceChildren() for container clearing (sanity check)', () => {
    // Sanity: confirm the migration target is actually present, so a
    // future "rewrite popup.ts" PR that accidentally removes both
    // doesn't pass this lock-in.
    expect(source).toContain('.replaceChildren()');
  });
});

/**
 * The same no-sink rule for the content-script toast. The toast injects DOM
 * into pages the extension does not control, so an innerHTML regression here is
 * strictly worse than in the popup. The shield icon is built via
 * createElementNS, never an HTML string.
 */
describe('toast.ts HTML-injection sink lock-in', () => {
  const source = readFileSync(resolve(__dirname, '../content/toast.ts'), 'utf-8');

  it('contains no innerHTML / outerHTML / insertAdjacentHTML / setHTMLUnsafe / document.write', () => {
    const lines = source.split('\n');
    const offenders: { line: number; text: string }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (BANNED_SINK_PATTERN.test(stripped)) {
        offenders.push({ line: i + 1, text: lines[i].trim() });
      }
    }
    expect(
      offenders,
      `toast.ts must build DOM via createElement / createElementNS / textContent — not HTML-string sinks.\nOffenders:\n${offenders.map((o) => `  ${o.line}: ${o.text}`).join('\n')}`
    ).toEqual([]);
  });

  it('builds the shield icon via createElementNS (not an HTML string)', () => {
    expect(source).toContain("createElementNS");
  });
});

// ---------------------------------------------------------------------------
// Render tests: the real popup module, a mocked background.
// ---------------------------------------------------------------------------

const POPUP_HTML = readFileSync(resolve(__dirname, 'index.html'), 'utf8');
const originalChrome = (globalThis as Record<string, unknown>).chrome;

afterEach(() => {
  (globalThis as Record<string, unknown>).chrome = originalChrome;
});

interface PopupStatus {
  detectedAgents: unknown[];
  downloadWatchedAgentIds?: string[];
  activeDelegation: DelegationRule | null;
  delegationRules: DelegationRule[];
  killSwitchActive: boolean;
  recentViolations: unknown[];
  aiSafetyDeclarations: Record<string, unknown>;
}

/** Every message the popup sent to the background in the current render test. */
let sentMessages: Array<{ type: string; data: unknown }> = [];

async function renderPopup(status: PopupStatus): Promise<void> {
  vi.resetModules();
  sentMessages = [];
  const parsed = new DOMParser().parseFromString(POPUP_HTML, 'text/html');
  parsed.querySelectorAll('script').forEach((el) => el.remove());
  document.body.replaceChildren(...Array.from(parsed.body.childNodes).map((n) => document.importNode(n, true)));
  const responses: Record<string, unknown> = {
    STATUS_QUERY: status,
    SESSION_QUERY: { sessions: [] },
    REPORTS_QUERY: { reports: [] },
    CONTRIBUTE_STATS: {},
  };
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      id: 'test-extension',
      lastError: undefined,
      getManifest: () => ({ version: '0.0.0-test' }),
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage: (msg: { type: string; data?: unknown }, cb?: (r: unknown) => void) => {
        sentMessages.push({ type: msg.type, data: msg.data });
        setTimeout(() => cb?.(responses[msg.type] ?? {}), 0);
      },
    },
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
  await import('./popup');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await vi.waitFor(
    () => {
      if (!document.querySelector('.detection-card')) throw new Error('popup not rendered');
    },
    { timeout: 3000 },
  );
}

const AGENT_ORIGIN = 'https://shop.example.com/cart';

function agentRule(preset: DelegationPreset, agentId: string | null): DelegationRule {
  return createRuleFromPreset(preset, { agentId });
}

function blockAlert(id: string, action: string, url: string, agoMs: number): unknown {
  return {
    violation: {
      id,
      timestamp: new Date(Date.now() - agoMs).toISOString(),
      agentId: 'a1',
      attemptedAction: action,
      url,
      blockingRuleId: 'r-agent',
      reason: 'test',
      userOverride: false,
    },
    severity: 'high',
    title: 'Blocked',
    message: 'test',
    allowOneTimeOverride: false,
    acknowledged: false,
  };
}

function status(opts: {
  origin?: string;
  rule?: DelegationRule | null;
  violations?: unknown[];
  /** Whether the agent's tab holds the extension's debugger session (default: yes). */
  watched?: boolean;
}): PopupStatus {
  const rule = opts.rule === undefined ? agentRule('readOnly', 'a1') : opts.rule;
  return {
    downloadWatchedAgentIds: opts.watched === false ? [] : ['a1'],
    detectedAgents: [
      {
        id: 'a1',
        type: 'anthropic-computer-use',
        detectionMethods: ['cdp-connection'],
        confidence: 'high',
        detectedAt: new Date().toISOString(),
        originUrl: opts.origin ?? AGENT_ORIGIN,
        observedCapabilities: [],
      },
    ],
    activeDelegation: rule,
    delegationRules: rule ? [rule] : [],
    killSwitchActive: false,
    recentViolations: opts.violations ?? [],
    aiSafetyDeclarations: {},
  };
}

const CARD_GRANT_HINT =
  "Cancelled: the grant on Anthropic Computer Use's card (Read-Only) blocks downloads started in its tab, yours included, and a site Allow cannot change that. To get the file, close that agent's tab, then retry. Revoke on its card also frees them, and leaves that agent with no delegation.";

function recoveryBlocks(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll('.capability-recovery'));
}

function titlesOnPage(): string[] {
  return Array.from(document.querySelectorAll('[title]')).map((el) => el.getAttribute('title') ?? '');
}

describe('popup render: download-block recovery (#69)', () => {
  it('renders ONE recovery block in the callout when any shown alert is a capability block', async () => {
    await renderPopup(
      status({
        violations: [
          blockAlert('v1', 'download-file', 'https://shop.example.com/files/invoice-123.pdf', 9_000),
          blockAlert('v2', 'click', 'https://shop.example.com/checkout', 7_000),
          blockAlert('v3', 'download-file', 'https://shop.example.com/files/receipt-77.pdf', 3_000),
        ],
      }),
    );
    const callout = document.getElementById('recent-block-callout')!;
    expect(callout.classList.contains('hidden')).toBe(false);
    expect(recoveryBlocks(document)).toHaveLength(1);
    expect(recoveryBlocks(callout)).toHaveLength(1);

    const block = recoveryBlocks(callout)[0];
    // The blocking rule is the grant on a1's card, so the hint names Revoke.
    const hint = block.querySelector('.capability-recovery-hint')?.textContent ?? '';
    expect(hint).toBe(CARD_GRANT_HINT);
    const details = block.querySelector('details.capability-recovery-more') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe(CAPABILITY_BLOCK_DETAIL_LABEL);
    expect(details.querySelector('p')?.textContent).toBe(CAPABILITY_BLOCK_DETAIL_BODY);

    // Download rows carry no action column, so their meta keeps the full width;
    // the click row keeps its Whitelist button.
    const rows = Array.from(callout.querySelectorAll('.recent-block-row'));
    expect(rows).toHaveLength(3);
    const withActions = rows.filter((r) => r.querySelector('.recent-block-actions'));
    expect(withActions).toHaveLength(1);
    expect(withActions[0].querySelector('button')?.textContent).toMatch(/^Whitelist /);

    // Recovery text is never carried in a tooltip.
    for (const title of titlesOnPage()) {
      expect(title).not.toContain(hint.slice(0, 40));
      expect(title).not.toContain(CAPABILITY_BLOCK_DETAIL_BODY.slice(0, 40));
    }
  });

  it('falls back to the Violations panel only when the callout shows no capability block', async () => {
    await renderPopup(
      status({
        violations: [blockAlert('v1', 'download-file', 'https://shop.example.com/files/invoice-123.pdf', 10 * 60_000)],
      }),
    );
    const callout = document.getElementById('recent-block-callout')!;
    expect(callout.classList.contains('hidden')).toBe(true);
    expect(recoveryBlocks(document)).toHaveLength(1);
    expect(recoveryBlocks(document.getElementById('violations-list')!)).toHaveLength(1);
  });

  it('does not fall back while the callout shows the block (still exactly one)', async () => {
    await renderPopup(
      status({
        violations: [
          blockAlert('v0', 'download-file', 'https://shop.example.com/files/old.pdf', 10 * 60_000),
          blockAlert('v1', 'download-file', 'https://shop.example.com/files/new.pdf', 2_000),
        ],
      }),
    );
    expect(recoveryBlocks(document)).toHaveLength(1);
    expect(recoveryBlocks(document.getElementById('violations-list')!)).toHaveLength(0);
  });

  it('renders no recovery block when no alert is a capability block', async () => {
    await renderPopup(
      status({ violations: [blockAlert('v2', 'click', 'https://shop.example.com/checkout', 2_000)] }),
    );
    expect(recoveryBlocks(document)).toHaveLength(0);
  });
});

describe('popup render: external-driver pill and caveat (#69)', () => {
  function pillAndCaveat(): { pill: string; caveat: string | null; caveatAfterGrant: boolean } {
    const card = document.querySelector('.detection-card')!;
    const pill = card.querySelector('.detection-card-header .agent-pill');
    const caveat = card.querySelector('.agent-scope-caveat');
    return {
      pill: pill?.textContent ?? '',
      caveat: caveat?.textContent ?? null,
      caveatAfterGrant: !!caveat?.previousElementSibling?.classList.contains('agent-grant-row'),
    };
  }

  it('shows the downloads state exactly when the caveat says downloads in its tab are cancelled (Read-Only, watched tab)', async () => {
    await renderPopup(status({}));
    const r = pillAndCaveat();
    expect(r.pill).toBe(EXTERNAL_DRIVER_DOWNLOADS_ENFORCED_LABEL);
    expect(r.caveat).toContain("downloads started in this agent's tab (detected on shop.example.com) are cancelled, yours included");
    expect(r.caveatAfterGrant).toBe(true);
  });

  it('agent tab without the extension\'s debugger session: "Monitor only" with the short caveat under the grant row', async () => {
    await renderPopup(status({ watched: false }));
    const r = pillAndCaveat();
    expect(r.pill).toBe('Monitor only');
    expect(r.caveat).not.toContain('downloads');
    expect(r.caveatAfterGrant).toBe(true);
  });

  it('Full Access: "Monitor only" with the short caveat', async () => {
    await renderPopup(status({ rule: agentRule('fullAccess', 'a1') }));
    const r = pillAndCaveat();
    expect(r.pill).toBe('Monitor only');
    expect(r.caveat).not.toContain('downloads');
  });

  it('no rule: "Monitor only" and no caveat', async () => {
    await renderPopup(status({ rule: null }));
    const r = pillAndCaveat();
    expect(r.pill).toBe('Monitor only');
    expect(r.caveat).toBeNull();
  });
});

describe('popup render: ending the session delegation without Full Access', () => {
  function sessionPanel(): HTMLElement {
    return document.getElementById('delegation-content')!;
  }

  function endButton(): HTMLButtonElement | null {
    return sessionPanel().querySelector<HTMLButtonElement>('#delegation-end-btn');
  }

  function shadowNote(): string | null {
    return sessionPanel().querySelector('.delegation-shadow-note')?.textContent ?? null;
  }

  it('offers End next to Change for an active session delegation, and End turns it off without granting anything', async () => {
    const session = agentRule('readOnly', null);
    await renderPopup(status({ rule: session }));
    const end = endButton();
    expect(end?.textContent).toBe('End');
    expect(end?.getAttribute('aria-label')).toBe('End the session delegation');
    expect(sessionPanel().querySelector('#delegation-wizard-btn')?.textContent).toBe('Change');

    end!.click();

    const updates = sentMessages.filter((m) => m.type === 'DELEGATION_UPDATE');
    expect(updates).toHaveLength(1);
    const sent = updates[0].data as DelegationRule;
    expect(sent.id).toBe(session.id);
    expect(sent.agentId).toBeNull();
    expect(sent.isActive).toBe(false);
    // Ending changes nothing else about the rule: no capability is granted.
    expect(sent.preset).toBe('readOnly');
    expect(sent.scope).toEqual(session.scope);

    expect(sessionPanel().textContent).toContain('No delegation active');
    expect(endButton()).toBeNull();
    // The agent card no longer reports the session grant.
    expect(document.querySelector('.agent-grant-row')?.textContent).not.toContain('Session:');
  });

  it('offers no End when no session delegation is active', async () => {
    await renderPopup(status({ rule: null }));
    expect(endButton()).toBeNull();
    expect(sessionPanel().textContent).toContain('No delegation active');
  });

  it("names the agents whose own card grant overrides the session delegation, where the session rule is changed", async () => {
    const session = agentRule('readOnly', null);
    const card = agentRule('fullAccess', 'a1');
    await renderPopup({ ...status({ rule: session }), delegationRules: [session, card] });
    expect(shadowNote()).toBe(
      "A grant on an agent's card overrides the session delegation for that agent: Anthropic Computer Use.",
    );
  });

  it('names the overriding card grant when no session delegation is active too', async () => {
    const card = agentRule('readOnly', 'a1');
    await renderPopup({ ...status({ rule: card }), activeDelegation: null });
    expect(shadowNote()).toBe(
      "A grant on an agent's card overrides the session delegation for that agent: Anthropic Computer Use.",
    );
  });

  it('shows no override note when no detected agent holds its own grant', async () => {
    const session = agentRule('readOnly', null);
    const revokedCard = { ...agentRule('readOnly', 'a1'), isActive: false };
    const otherAgentsCard = agentRule('readOnly', 'a-gone');
    await renderPopup({ ...status({ rule: session }), delegationRules: [session, revokedCard, otherAgentsCard] });
    expect(shadowNote()).toBeNull();
  });
});

describe('popup render: the download-block hint follows the rule that blocks downloads in the agent\'s tab (#69)', () => {
  const DOWNLOAD = 'https://shop.example.com/files/invoice-123.pdf';

  function hintText(): string {
    const blocks = recoveryBlocks(document);
    expect(blocks).toHaveLength(1);
    return blocks[0].querySelector('.capability-recovery-hint')?.textContent ?? '';
  }

  function otherControls(): Element | null {
    return recoveryBlocks(document)[0].querySelector('details.capability-recovery-more');
  }

  it("names Revoke for a grant on the agent's card, and says to retry once Revoke is pressed", async () => {
    const card = agentRule('readOnly', 'a1');
    await renderPopup({
      ...status({ rule: card, violations: [blockAlert('v1', 'download-file', DOWNLOAD, 2_000)] }),
      activeDelegation: null,
    });
    expect(hintText()).toBe(CARD_GRANT_HINT);
    expect(otherControls()?.querySelector('p')?.textContent).toBe(CAPABILITY_BLOCK_DETAIL_BODY);

    const revoke = Array.from(document.querySelectorAll<HTMLButtonElement>('.agent-grant-row button'))
      .find((b) => b.textContent === 'Revoke');
    revoke!.click();

    expect(hintText()).toBe(
      "Cancelled under a delegation that no longer blocks downloads in Anthropic Computer Use's tab. Retry the download.",
    );
    expect(otherControls()).toBeNull();
  });

  it('names End for a session delegation, and says to retry once End is pressed', async () => {
    const session = agentRule('readOnly', null);
    await renderPopup(status({ rule: session, violations: [blockAlert('v1', 'download-file', DOWNLOAD, 2_000)] }));
    expect(hintText()).toBe(
      "Cancelled: the session delegation (Read-Only) blocks downloads started in Anthropic Computer Use's tab, yours included, and a site Allow cannot change that. To get the file, close that agent's tab, then retry. End on the session delegation also frees them, and leaves every agent without a grant of its own with no delegation.",
    );

    document.querySelector<HTMLButtonElement>('#delegation-end-btn')!.click();

    expect(hintText()).toBe(
      "Cancelled under a delegation that no longer blocks downloads in Anthropic Computer Use's tab. Retry the download.",
    );
  });

  it('names Revoke together with End when both the card grant and the session delegation block downloads', async () => {
    const session = agentRule('readOnly', null);
    const card = agentRule('readOnly', 'a1');
    await renderPopup({
      ...status({ rule: session, violations: [blockAlert('v1', 'download-file', DOWNLOAD, 2_000)] }),
      delegationRules: [session, card],
    });
    expect(hintText()).toMatch(
      /Revoke on its card frees them only together with End on the session delegation \(Read-Only\), which blocks them too\.$/,
    );

    // End alone leaves the card grant in force, so the hint still names Revoke.
    document.querySelector<HTMLButtonElement>('#delegation-end-btn')!.click();
    expect(hintText()).toBe(CARD_GRANT_HINT);
  });

  it('shows the general hint once the agent behind the block is no longer detected', async () => {
    const session = agentRule('readOnly', null);
    const fromGoneAgent = blockAlert('v1', 'download-file', DOWNLOAD, 2_000) as { violation: Record<string, unknown> };
    fromGoneAgent.violation.agentId = 'a-gone';
    await renderPopup(status({ rule: session, violations: [fromGoneAgent] }));
    expect(hintText()).toBe(CAPABILITY_BLOCK_HINT);
    expect(otherControls()?.querySelector('p')?.textContent).toBe(CAPABILITY_BLOCK_DETAIL_BODY);
  });
});
