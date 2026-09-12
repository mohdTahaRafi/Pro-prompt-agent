/**
 * Tab roster — the Supervisor's view of the tabs it drives. §16 forward
 * dependency: length-capped at 1 by MAX_ROSTER_SIZE this phase; Phase 7
 * raises the cap to 8 and adds `open_tab`.
 * Docs/planning/phase_5_agent_loop.md §4, §11 task 5.2.
 */
import { Ok, Err, type Result } from '@lib/utils/result';

export const MAX_ROSTER_SIZE = 1;

export type TabRosterState = 'pending' | 'running' | 'done' | 'failed';

export interface TabStatus {
  tabId: number;
  origin: string;
  title: string;
  state: TabRosterState;
  epoch: number;
  actionsDrawn: number;
  localRecoveries: number;   // [Phase 6] always 0 this phase — no adaptation yet
}

export class TabRoster {
  private readonly tabs = new Map<number, TabStatus>();
  private removedListener: ((tabId: number) => void) | null = null;

  /** Registers the chrome.tabs.onRemoved listener for every tab this roster
   *  ever admits — called once by the Supervisor at survey time. */
  watch(onClosed: (tabId: number) => void): void {
    this.removedListener = onClosed;
    chrome.tabs.onRemoved.addListener(this.handleRemoved);
  }

  unwatch(): void {
    chrome.tabs.onRemoved.removeListener(this.handleRemoved);
  }

  private handleRemoved = (tabId: number): void => {
    if (!this.tabs.has(tabId)) return;
    this.markFailed(tabId, 'TAB_CLOSED');
    this.removedListener?.(tabId);
  };

  add(tabId: number, origin: string, title: string): Result<TabStatus, 'ROSTER_FULL'> {
    if (this.tabs.size >= MAX_ROSTER_SIZE && !this.tabs.has(tabId)) return Err('ROSTER_FULL');
    const status: TabStatus = { tabId, origin, title, state: 'pending', epoch: 0, actionsDrawn: 0, localRecoveries: 0 };
    this.tabs.set(tabId, status);
    return Ok(status);
  }

  get(tabId: number): TabStatus | undefined {
    return this.tabs.get(tabId);
  }

  all(): TabStatus[] {
    return [...this.tabs.values()];
  }

  update(tabId: number, patch: Partial<Omit<TabStatus, 'tabId'>>): void {
    const existing = this.tabs.get(tabId);
    if (!existing) return;
    this.tabs.set(tabId, { ...existing, ...patch });
  }

  markFailed(tabId: number, _reason: 'TAB_CLOSED'): void {
    this.update(tabId, { state: 'failed' });
  }

  isEmpty(): boolean {
    return this.tabs.size === 0;
  }
}
