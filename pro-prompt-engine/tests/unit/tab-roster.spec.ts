/**
 * lib/agent/tab-roster.ts — TabStatus, onRemoved.
 * Docs/planning/phase_5_agent_loop.md §11 task 5.2.
 */
import { describe, it, expect } from 'vitest';
import { TabRoster, MAX_ROSTER_SIZE } from '@lib/agent/tab-roster';

describe('TabRoster', () => {
  it('a roster of one reports the full TabStatus shape', () => {
    const roster = new TabRoster();
    const r = roster.add(1, 'https://example.com', 'Example');
    expect(r.ok).toBe(true);
    expect(roster.get(1)).toEqual({
      tabId: 1, origin: 'https://example.com', title: 'Example',
      state: 'pending', epoch: 0, actionsDrawn: 0, localRecoveries: 0,
    });
  });

  it('is capped at MAX_ROSTER_SIZE (1 this phase) — a second distinct tab is refused', () => {
    expect(MAX_ROSTER_SIZE).toBe(1);
    const roster = new TabRoster();
    expect(roster.add(1, 'https://a.example', '').ok).toBe(true);
    expect(roster.add(2, 'https://b.example', '')).toEqual({ ok: false, error: 'ROSTER_FULL' });
  });

  it('re-adding the SAME tab (e.g. Resume re-survey) is not blocked by the cap', () => {
    const roster = new TabRoster();
    roster.add(1, 'https://a.example', '');
    expect(roster.add(1, 'https://a.example', 'renamed').ok).toBe(true);
  });

  it('chrome.tabs.onRemoved for the roster tab sets state failed:TAB_CLOSED', () => {
    chrome.tabs.__setTab(9, 'https://a.example/');
    const roster = new TabRoster();
    roster.add(9, 'https://a.example', '');
    let notified: number | null = null;
    roster.watch((tabId) => { notified = tabId; });

    chrome.tabs.__removeTab(9);

    expect(notified).toBe(9);
    expect(roster.get(9)?.state).toBe('failed');
    roster.unwatch();
  });

  it('watch() ignores onRemoved for a tab not in this roster', () => {
    chrome.tabs.__setTab(5, 'https://a.example/');
    const roster = new TabRoster();
    roster.add(1, 'https://a.example', '');
    let called = false;
    roster.watch(() => { called = true; });
    chrome.tabs.__removeTab(5);
    expect(called).toBe(false);
    roster.unwatch();
  });
});
