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
 * never in a title), the external-driver pill and caveat (#69) and the
 * detection confidence on the agent card (#104).
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
  browserLayerByAgentId?: Record<string, unknown>;
  activeDelegation: DelegationRule | null;
  delegationRules: DelegationRule[];
  killSwitchActive: boolean;
  recentViolations: unknown[];
  aiSafetyDeclarations: Record<string, unknown>;
  guardPauses?: unknown[];
  pausedAgentIds?: string[];
}

/** Every message the popup sent to the background in the current render test. */
let sentMessages: Array<{ type: string; data: unknown }> = [];

async function renderPopup(status: PopupStatus, extraResponses: Record<string, unknown> = {}): Promise<void> {
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
    ...extraResponses,
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
  /** The agent's detection confidence as the background reports it (default: high). */
  confidence?: unknown;
  /** What Browser-layer blocking reports for the agent's tab (default: nothing). */
  browserLayer?: unknown;
}): PopupStatus {
  const rule = opts.rule === undefined ? agentRule('readOnly', 'a1') : opts.rule;
  return {
    downloadWatchedAgentIds: opts.watched === false ? [] : ['a1'],
    browserLayerByAgentId: opts.browserLayer === undefined ? {} : { a1: opts.browserLayer },
    detectedAgents: [
      {
        id: 'a1',
        type: 'anthropic-computer-use',
        detectionMethods: ['cdp-connection'],
        confidence: 'confidence' in opts ? opts.confidence : 'high',
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

describe('popup render: detection confidence on the agent card (#104)', () => {
  function confidenceRow(): Element | null {
    return document.querySelector('.detection-card .detection-confidence');
  }

  it.each([
    ['low', 'Confidence: Low'],
    ['medium', 'Confidence: Medium'],
    ['high', 'Confidence: High'],
    ['confirmed', 'Confidence: Confirmed'],
  ])('shows a %s detection as "%s"', async (confidence, text) => {
    await renderPopup(status({ confidence }));
    expect(confidenceRow()?.textContent).toBe(text);
  });

  it('sits between the card header and the row of detection methods', async () => {
    await renderPopup(status({}));
    const row = confidenceRow()!;
    expect(row.previousElementSibling?.classList.contains('detection-card-header')).toBe(true);
    expect(row.nextElementSibling?.querySelector('.method-tag')?.textContent).toBe('cdp-connection');
  });

  it('lists the four levels in rising order in its tooltip', async () => {
    await renderPopup(status({}));
    expect(confidenceRow()?.getAttribute('title')).toContain('lowest to highest: Low, Medium, High, Confirmed');
  });

  it.each([[undefined], [null], ['certain'], [3]])(
    'shows no confidence row for a value that is not a known level (%s)',
    async (confidence) => {
      await renderPopup(status({ confidence }));
      expect(confidenceRow()).toBeNull();
      expect(document.querySelector('.detection-card')!.textContent).not.toMatch(/Confidence/);
    },
  );
});

describe('popup render: what Browser-layer blocking is doing in the agent tab (#110)', () => {
  function layerNotes(): Element[] {
    return Array.from(document.querySelectorAll('.detection-card .agent-layer-note'));
  }

  it('shows nothing on a card whose tab the layer does not apply to', async () => {
    await renderPopup(status({}));
    expect(layerNotes()).toHaveLength(0);
  });

  it('attached: the card says why the debugging banner is showing, under the grant row and its caveat', async () => {
    await renderPopup(status({ browserLayer: { state: 'attached' } }));
    const notes = layerNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].classList.contains('agent-layer-note-active')).toBe(true);
    expect(notes[0].textContent).toContain('That is why Chrome shows its "debugging this browser" banner.');
    expect(notes[0].previousElementSibling?.classList.contains('agent-scope-caveat')).toBe(true);
  });

  it('attached under Read-Only with no blocked site: the card says the session is there for downloads, not for sites', async () => {
    await renderPopup(status({ browserLayer: { state: 'attached' } }));
    const text = layerNotes()[0].textContent ?? '';
    expect(text).toMatch(/^Browser-layer blocking is attached to this tab to cancel downloads started in it\. /);
    expect(text).not.toContain('sites');
  });

  it('attached under a delegation with a blocked site: the card names the sites and the downloads', async () => {
    const readOnly = agentRule('readOnly', 'a1');
    const rule: DelegationRule = {
      ...readOnly,
      scope: { ...readOnly.scope, sitePatterns: [{ pattern: 'blocked.example', action: 'block' }] },
    };
    await renderPopup(status({ rule, browserLayer: { state: 'attached' } }));
    expect(layerNotes()[0].textContent).toMatch(
      /^Browser-layer blocking is attached to this tab to enforce the sites your delegation blocks and to cancel downloads started in it\. /,
    );
  });

  it('refused attach: the card says the layer could not attach, with the reason Chrome gave', async () => {
    await renderPopup(
      status({
        watched: false,
        browserLayer: { state: 'unavailable', cause: 'attach-failed', detail: 'Another debugger is already attached to the tab with id: 7.' },
      }),
    );
    const notes = layerNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].classList.contains('agent-layer-note-unavailable')).toBe(true);
    expect(notes[0].textContent).toContain('Browser-layer blocking could not attach to this tab. Chrome reported: Another debugger is already attached to the tab with id: 7.');
    // Read-Only with no blocked site: downloads are what is lost, and no site is named.
    expect(notes[0].textContent).toContain('Until it attaches, downloads started in this tab are not cancelled.');
    expect(notes[0].textContent).not.toContain('sites');
    // The pill agrees: nothing is cancelled in a tab that holds no session.
    expect(document.querySelector('.detection-card-header .agent-pill')?.textContent).toBe('Monitor only');
  });

  it('session ended by Chrome: the card says so', async () => {
    await renderPopup(
      status({ watched: false, browserLayer: { state: 'unavailable', cause: 'detached', detail: 'canceled_by_user' } }),
    );
    expect(layerNotes()[0].textContent).toContain(
      "Chrome ended Browser-layer blocking's debugger session on this tab when its debugging banner was cancelled.",
    );
  });

  it('renders text from Chrome as text, never as markup', async () => {
    await renderPopup(
      status({ watched: false, browserLayer: { state: 'unavailable', cause: 'attach-failed', detail: '<img src=x onerror=alert(1)>' } }),
    );
    const note = layerNotes()[0];
    expect(note.querySelector('img')).toBeNull();
    expect(note.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('a state reported for another agent is not shown on this card', async () => {
    const s = status({});
    s.browserLayerByAgentId = { 'someone-else': { state: 'attached' } };
    await renderPopup(s);
    expect(layerNotes()).toHaveLength(0);
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

  it("says to retry while a site pause covers the agent's tab, and offers no other controls", async () => {
    const card = agentRule('readOnly', 'a1');
    const sitePause = { id: 'p1', scope: 'site', host: 'shop.example.com', startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
    await renderPopup({
      ...status({ rule: card, violations: [blockAlert('v1', 'download-file', DOWNLOAD, 2_000)] }),
      activeDelegation: null,
      guardPauses: [sitePause],
      pausedAgentIds: ['a1'],
    });
    expect(hintText()).toBe(
      "Cancelled, but the guard is now paused in Anthropic Computer Use's tab, so no delegation blocks downloads there until the pause ends. Retry the download.",
    );
    expect(otherControls()).toBeNull();
  });

  it('says to retry once Pause everywhere is pressed', async () => {
    const card = agentRule('readOnly', 'a1');
    const current: PopupStatus = {
      ...status({ rule: card, violations: [blockAlert('v1', 'download-file', DOWNLOAD, 2_000)] }),
      activeDelegation: null,
    };
    await renderPopup(current, { GUARD_PAUSE: { success: true } });
    expect(hintText()).toBe(CARD_GRANT_HINT);

    // What the background reports once the pause is in force.
    current.guardPauses = [{ id: 'p1', scope: 'all', host: null, startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }];
    current.pausedAgentIds = ['a1'];
    Array.from(document.querySelectorAll<HTMLButtonElement>('#pause-content button'))
      .find((b) => b.textContent === 'Pause everywhere')!.click();

    await vi.waitFor(() => {
      expect(hintText()).toBe(
        'Cancelled, but the guard is now paused everywhere, so no delegation blocks downloads until the pause ends. Retry the download.',
      );
    });
    expect(sentMessages.map((m) => m.type)).toContain('GUARD_PAUSE');
    expect(otherControls()).toBeNull();
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

describe('popup render: the report the export smoke opens (#134)', () => {
  // scripts/smoke-export.mjs opens the real action popup, clicks in the
  // reports list, then looks for Export JSON. What it clicks has to open the
  // report's detail view, or the smoke fails whenever it gets a window to open
  // the popup in.
  const smoke = readFileSync(resolve(__dirname, '../../scripts/smoke-export.mjs'), 'utf8');

  /** The selectors the smoke clicks in the popup before it looks for Export JSON. */
  function clickedBeforeExport(): string[] {
    const exportAt = smoke.indexOf("'text=Export JSON'");
    expect(exportAt, 'the smoke must look for Export JSON').toBeGreaterThan(0);
    return Array.from(smoke.slice(0, exportAt).matchAll(/popup\.\$\('([^']+)'\)/g), (m) => m[1]);
  }

  it('shows Export JSON after the smoke clicks a listed report', async () => {
    const report = {
      id: 'rep-smoke-1', sessionId: 'smoke1234abcd5678', agentType: 'openai-operator',
      durationSeconds: 42, endReason: 'tab-closed',
      actionSummary: { total: 5, allowed: 3, blocked: 2 }, totalEvents: 9,
      violationsByCapability: { 'download-file': 2 },
      createdAt: new Date(0).toISOString(), startedAt: new Date(0).toISOString(),
      endedAt: new Date(1000).toISOString(),
    };
    await renderPopup(status({}), { REPORTS_QUERY: { reports: [report] } });
    await vi.waitFor(() => {
      if (!document.querySelector('#reports-list .event-item')) throw new Error('report not listed');
    });

    const selectors = clickedBeforeExport();
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      const target = document.querySelector<HTMLElement>(selector);
      expect(target, selector).not.toBeNull();
      target!.click();
    }

    const buttons = Array.from(document.querySelectorAll('#reports-list button'), (b) => b.textContent);
    expect(buttons).toContain('Export JSON');
  });
});
