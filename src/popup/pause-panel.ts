/**
 * Popup panel for pausing the guard on this site or everywhere (#71).
 *
 * Builds DOM only; the background owns the pause state and the popup renders
 * what it confirmed. Shows every live pause with its countdown and a Resume
 * button, the two ways to start one, and the recent pause history so the owner
 * can see afterwards what was unguarded and when.
 *
 * Hostnames come from the active tab's URL, which a page controls, so every
 * string is written with `textContent` (locked in by popup.dom.test.ts).
 */

import type { GuardPause, PauseLogEntry, PauseScope } from '../delegation/pause';
import {
  SITE_PAUSE_MINUTES,
  ALL_PAUSE_MINUTES,
  pauseEndReasonLabel,
  describePauseScope,
} from '../delegation/pause';

export interface PausePanelInput {
  /** Hostname of the page in the active tab, or null when it is not a website. */
  currentHost: string | null;
  /** Live pauses, as the background reported them. */
  pauses: GuardPause[];
  /** Pause history, newest first. */
  log: PauseLogEntry[];
  killSwitchActive: boolean;
  /** Why the last pause or resume request failed, if it did. */
  error: string | null;
  now: number;
}

export interface PauseRequest {
  scope: PauseScope;
  host: string | null;
  minutes: number | null;
}

export interface PausePanelActions {
  onPause(request: PauseRequest): void;
  onResume(pauseId: string): void;
}

/** Pause history rows shown in the popup. */
const PAUSE_HISTORY_ROWS = 5;

/** "14:59 left", or "until you resume" for an open-ended site pause. */
export function formatPauseRemaining(expiresAt: string | null, now: number): string {
  if (expiresAt === null) return 'until you resume';
  const remaining = Math.max(0, Date.parse(expiresAt) - now);
  const totalSeconds = Math.floor(remaining / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = (totalSeconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs} left`;
}

function durationLabel(minutes: number | null): string {
  return minutes === null ? 'Until I resume' : `${minutes} minutes`;
}

/** True when `iso` falls on the same local calendar day as `now`. */
function isSameDay(iso: string, now: number): boolean {
  const d = new Date(iso);
  const today = new Date(now);
  return d.getFullYear() === today.getFullYear()
    && d.getMonth() === today.getMonth()
    && d.getDate() === today.getDate();
}

/**
 * "09:10", or "Oct 4, 09:10" with `withDate` for a time outside today, with the
 * year added for a time outside the current year.
 */
function clockTime(iso: string, withDate: boolean, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '?';
  if (!withDate) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const year = d.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric';
  return d.toLocaleString([], { year, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function durationSelect(options: readonly (number | null)[], selected: number | null, label: string): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'form-input pause-duration';
  select.setAttribute('aria-label', label);
  for (const minutes of options) {
    const option = document.createElement('option');
    option.value = minutes === null ? 'resume' : String(minutes);
    option.textContent = durationLabel(minutes);
    option.selected = minutes === selected;
    select.appendChild(option);
  }
  return select;
}

function selectedMinutes(select: HTMLSelectElement): number | null {
  return select.value === 'resume' ? null : Number(select.value);
}

function pauseRow(pause: GuardPause, now: number, actions: PausePanelActions): HTMLElement {
  const row = document.createElement('div');
  row.className = 'pause-row pause-active';

  const label = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = pause.scope === 'all' ? 'Paused everywhere' : `Paused on ${pause.host}`;
  label.appendChild(strong);
  const countdown = document.createElement('span');
  countdown.className = 'pause-countdown';
  if (pause.expiresAt !== null) countdown.dataset.expiresAt = pause.expiresAt;
  countdown.textContent = ` · ${formatPauseRemaining(pause.expiresAt, now)}`;
  label.appendChild(countdown);

  const resume = document.createElement('button');
  resume.className = 'btn btn-secondary btn-sm pause-resume-btn';
  resume.textContent = 'Resume';
  resume.setAttribute('aria-label', `Resume the guard ${describePauseScope(pause)}`);
  resume.addEventListener('click', () => {
    resume.disabled = true;
    actions.onResume(pause.id);
  });

  row.appendChild(label);
  row.appendChild(resume);
  return row;
}

function startRow(
  text: string,
  select: HTMLSelectElement,
  buttonText: string,
  onClick: (button: HTMLButtonElement) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'pause-row';
  const label = document.createElement('span');
  label.className = 'pause-label';
  label.textContent = text;
  const button = document.createElement('button');
  button.className = 'btn btn-secondary btn-sm';
  button.textContent = buttonText;
  button.addEventListener('click', () => onClick(button));
  row.appendChild(label);
  row.appendChild(select);
  row.appendChild(button);
  return row;
}

/** Render the pause panel into `container`, replacing what was there. */
export function renderPausePanel(
  container: HTMLElement,
  input: PausePanelInput,
  actions: PausePanelActions,
): void {
  container.replaceChildren();

  // Live pauses first: everywhere, then this site, then other sites.
  const ordered = [...input.pauses].sort((a, b) => {
    const rank = (p: GuardPause) => (p.scope === 'all' ? 0 : p.host === input.currentHost ? 1 : 2);
    return rank(a) - rank(b);
  });
  for (const pause of ordered) {
    container.appendChild(pauseRow(pause, input.now, actions));
  }
  if (ordered.length > 0) {
    const note = document.createElement('p');
    note.className = 'pause-note';
    note.textContent =
      'While paused, agent actions there are not blocked. Detection, the timeline and the kill switch keep working.';
    container.appendChild(note);
  }

  if (input.killSwitchActive) {
    const blocked = document.createElement('p');
    blocked.className = 'pause-note';
    blocked.textContent = 'Pausing is unavailable while the kill switch is on.';
    container.appendChild(blocked);
  } else {
    const sitePaused = input.currentHost !== null
      && input.pauses.some((p) => p.scope === 'site' && p.host === input.currentHost);
    if (input.currentHost === null) {
      const hint = document.createElement('p');
      hint.className = 'pause-note';
      hint.textContent = 'Open a website in this tab to pause the guard on it.';
      container.appendChild(hint);
    } else if (!sitePaused) {
      const host = input.currentHost;
      const select = durationSelect(SITE_PAUSE_MINUTES, 60, `How long to pause on ${host}`);
      container.appendChild(startRow(`On ${host}`, select, 'Pause on this site', (button) => {
        button.disabled = true;
        actions.onPause({ scope: 'site', host, minutes: selectedMinutes(select) });
      }));
    }
    if (!input.pauses.some((p) => p.scope === 'all')) {
      const select = durationSelect(ALL_PAUSE_MINUTES, 15, 'How long to pause everywhere');
      container.appendChild(startRow('Every site', select, 'Pause everywhere', (button) => {
        button.disabled = true;
        actions.onPause({ scope: 'all', host: null, minutes: selectedMinutes(select) });
      }));
    }
  }

  if (input.error) {
    const error = document.createElement('p');
    error.className = 'pause-error';
    error.setAttribute('role', 'alert');
    error.textContent = input.error;
    container.appendChild(error);
  }

  const history = input.log.slice(0, PAUSE_HISTORY_ROWS);
  if (history.length > 0) {
    const heading = document.createElement('div');
    heading.className = 'pause-history-title';
    heading.textContent = 'Recent pauses';
    container.appendChild(heading);
    const list = document.createElement('ul');
    list.className = 'pause-history';
    for (const entry of history) {
      const item = document.createElement('li');
      const reach = entry.scope === 'all' ? 'Everywhere' : entry.host ?? '';
      // A row that reaches outside today is dated at both ends, so a pause
      // from another day does not read as one from today.
      const withDate = !isSameDay(entry.startedAt, input.now)
        || (entry.endedAt !== null && !isSameDay(entry.endedAt, input.now));
      const end = entry.endedAt === null ? 'now' : clockTime(entry.endedAt, withDate, input.now);
      const outcome = entry.endReason === null ? 'still paused' : pauseEndReasonLabel(entry.endReason);
      item.textContent = `${reach} · ${clockTime(entry.startedAt, withDate, input.now)} to ${end} · ${outcome}`;
      list.appendChild(item);
    }
    container.appendChild(list);
  }
}

/**
 * Refresh every countdown in `container`. Returns true when one has reached
 * zero, so the caller can ask the background for the resumed state.
 */
export function updatePauseCountdowns(container: HTMLElement, now: number): boolean {
  let ended = false;
  container.querySelectorAll<HTMLElement>('.pause-countdown[data-expires-at]').forEach((el) => {
    const expiresAt = el.dataset.expiresAt ?? '';
    if (Date.parse(expiresAt) <= now) ended = true;
    el.textContent = ` · ${formatPauseRemaining(expiresAt, now)}`;
  });
  return ended;
}
