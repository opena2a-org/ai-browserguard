export interface PopupRuntimeState {
  /** The key shown beside the Kill Switch button. */
  shortcut: string;
  /** Hostname of the page in the active tab, or null when it is not a website. */
  currentHost: string | null;
  killSwitchActive?: boolean;
}
export function drawPopupRuntimeParts(state: PopupRuntimeState): void;
