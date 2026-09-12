/**
 * lib/agent/budget.ts — shared draws, wall clock, stuck detection.
 * Docs/planning/phase_5_agent_loop.md §11 task 5.3.
 */
import { describe, it, expect, vi } from 'vitest';
import { Budget, actionKey, readMirror, checkMirror } from '@lib/agent/budget';
import type { RunBudgets } from '@lib/types/run.types';

const LIMITS: RunBudgets = { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 };

describe('Budget — action draws', () => {
  it('the 41st action draw fails BUDGET_ACTIONS', async () => {
    const b = new Budget(LIMITS, 1);
    for (let i = 0; i < 40; i++) {
      const r = await b.drawAction();
      expect(r.ok, `draw ${i + 1} should succeed`).toBe(true);
    }
    const r41 = await b.drawAction();
    expect(r41).toEqual({ ok: false, error: 'BUDGET_ACTIONS' });
  });

  it('a draw after the wall clock is exhausted fails BUDGET_WALLCLOCK', async () => {
    const b = new Budget(LIMITS, 1, Date.now() - 720_001);
    const r = await b.drawAction();
    expect(r).toEqual({ ok: false, error: 'BUDGET_WALLCLOCK' });
  });

  it('planner calls draw from their own separate pool', async () => {
    const b = new Budget({ ...LIMITS, maxPlannerCalls: 2 }, 1);
    expect((await b.drawPlannerCall()).ok).toBe(true);
    expect((await b.drawPlannerCall()).ok).toBe(true);
    expect(await b.drawPlannerCall()).toEqual({ ok: false, error: 'BUDGET_PLANNER' });
  });

  it('two agents drawing from ONE Budget share the pool (§4.2 — never per-tab)', async () => {
    const shared = new Budget({ ...LIMITS, maxActions: 3 }, 1);
    expect((await shared.drawAction()).ok).toBe(true);   // "agent A"
    expect((await shared.drawAction()).ok).toBe(true);   // "agent B"
    expect((await shared.drawAction()).ok).toBe(true);   // "agent A" again
    expect(await shared.drawAction()).toEqual({ ok: false, error: 'BUDGET_ACTIONS' });
  });

  it('pauseClock/resumeClock exclude the paused interval from the wall-clock check', async () => {
    const started = Date.now() - 719_000;   // 1s of real budget left
    const b = new Budget(LIMITS, 1, started);
    b.pauseClock();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5_000);   // would have blown the budget if counted
    await b.resumeClock();
    vi.useRealTimers();
    const r = await b.drawAction();
    expect(r.ok).toBe(true);
  });
});

describe('Budget — stuck detection', () => {
  it('three identical (verb, handle, args) with identical outcomes returns "stuck"', () => {
    const b = new Budget(LIMITS, 1);
    const key = actionKey({ verb: 'click', handle: 'e5' });
    expect(b.noteOutcome(key, 'unconfirmed')).toBe('ok');
    expect(b.noteOutcome(key, 'unconfirmed')).toBe('ok');
    expect(b.noteOutcome(key, 'unconfirmed')).toBe('stuck');
  });

  it('a different outcome for the same key resets the count', () => {
    const b = new Budget(LIMITS, 1);
    const key = actionKey({ verb: 'click', handle: 'e5' });
    expect(b.noteOutcome(key, 'unconfirmed')).toBe('ok');
    expect(b.noteOutcome(key, 'unconfirmed')).toBe('ok');
    expect(b.noteOutcome(key, 'confirmed')).toBe('ok');   // different outcome — its own counter
    expect(b.noteOutcome(key, 'confirmed')).toBe('ok');
  });

  it('actionKey ignores requestId/reason and is stable across identical args', () => {
    const a = actionKey({ verb: 'type', handle: 'e5', text: 'Mohd', mode: 'replace' });
    const c = actionKey({ verb: 'type', handle: 'e5', text: 'Mohd', mode: 'replace' });
    const d = actionKey({ verb: 'type', handle: 'e5', text: 'Taha', mode: 'replace' });
    expect(a).toBe(c);
    expect(a).not.toBe(d);
  });
});

describe('Budget — the gate-side mirror (task 5.4)', () => {
  it('mirrors action/planner counts into chrome.storage.session on every draw', async () => {
    const b = new Budget(LIMITS, 7);
    await b.drawAction();
    const snap = await readMirror(7);
    expect(snap?.actions).toBe(1);
  });

  it('a Supervisor that ignores drawAction() still cannot exceed the budget: the gate refuses at 41', async () => {
    // Simulates a wedged/dishonest Supervisor: the mirror is seeded to 40
    // directly, bypassing drawAction() entirely for the 41st attempt.
    await chrome.storage.session.set({
      'budget:9': { actions: 40, plannerCalls: 0, startedAt: Date.now(), pausedMs: 0, limits: LIMITS },
    });
    const snap = await readMirror(9);
    expect(snap).not.toBeNull();
    const check = checkMirror(snap!);
    expect(check).toEqual({ ok: false, error: 'BUDGET_ACTIONS' });
  });

  it('no mirror row (nothing drawn yet) reads as null, not a refusal', async () => {
    expect(await readMirror(123)).toBeNull();
  });
});
