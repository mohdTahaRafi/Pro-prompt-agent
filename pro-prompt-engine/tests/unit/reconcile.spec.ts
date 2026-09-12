/**
 * lib/agent/reconcile.ts — interrupted runs halt.
 * Docs/planning/phase_5_agent_loop.md §3.1, §11 task 5.15.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { reconcileRuns, relayRunControl } from '@lib/agent/reconcile';
import * as journal from '@lib/agent/journal';
import { db } from '@lib/db/dexie-db';
import type { RunRecord } from '@lib/types/run.types';

const ORIGIN = 'https://practice.example.org';

async function makeRun(state: RunRecord['state']): Promise<number> {
  return db.runs.add({
    goal: '', state, mode: 'supervised', posture: 'local-only', backend: 'dom',
    origin: ORIGIN, scope: [ORIGIN], roster: [1],
    budgets: { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 },
    startedAt: Date.now(),
  });
}

beforeEach(async () => {
  await db.runs.clear();
});

describe('reconcileRuns', () => {
  it('a non-terminal run whose Supervisor answers LIST_RUNS is left untouched', async () => {
    const runId = await makeRun('running');
    // The offscreen double answers RUN_ADMITTED/LIST_RUNS through the same
    // chrome.runtime.sendMessage plumbing askOffscreen() uses in production.
    chrome.runtime.onMessage.addListener((message: any, _s: any, sendResponse: (r: any) => void) => {
      if (message?.target !== 'offscreen' || message.type !== 'LIST_RUNS') return;
      sendResponse({ data: [runId] });
      return true;
    });

    await reconcileRuns();

    const run = await db.runs.get(runId);
    expect(run?.state).toBe('running');
    expect(await journal.query(runId, 'run.interrupted')).toHaveLength(0);
  });

  it('a non-terminal run absent from LIST_RUNS is journaled run.interrupted and moved to halted', async () => {
    const runId = await makeRun('running');
    chrome.runtime.onMessage.addListener((message: any, _s: any, sendResponse: (r: any) => void) => {
      if (message?.target !== 'offscreen' || message.type !== 'LIST_RUNS') return;
      sendResponse({ data: [] });   // this run's Supervisor did not survive
      return true;
    });

    await reconcileRuns();

    const run = await db.runs.get(runId);
    expect(run?.state).toBe('halted');
    expect(run?.outcome).toBe('failed');
    const events = await journal.query(runId, 'run.interrupted');
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ atState: 'running', reason: 'AGENT_RUNTIME_LOST' });
  });

  it('never touches an already-terminal run, even if absent from LIST_RUNS', async () => {
    const runId = await makeRun('completed');
    chrome.runtime.onMessage.addListener((message: any, _s: any, sendResponse: (r: any) => void) => {
      if (message?.target !== 'offscreen' || message.type !== 'LIST_RUNS') return;
      sendResponse({ data: [] });
      return true;
    });

    await reconcileRuns();

    expect(await journal.query(runId, 'run.interrupted')).toHaveLength(0);
  });

  it('does nothing (no offscreen round trip) when there are no non-terminal runs', async () => {
    await makeRun('completed');
    let called = false;
    chrome.runtime.onMessage.addListener((message: any) => { if (message?.type === 'LIST_RUNS') called = true; });

    await reconcileRuns();

    expect(called).toBe(false);
  });
});

describe('relayRunControl (2026-09-13 audit)', () => {
  it('reports success when the offscreen Supervisor acknowledges (found: true)', async () => {
    chrome.runtime.onMessage.addListener((message: any, _s: any, sendResponse: (r: any) => void) => {
      if (message?.target !== 'offscreen' || message.type !== 'PAUSE_RUN') return;
      sendResponse({ data: { found: true } });
      return true;
    });

    const res = await relayRunControl('PAUSE_RUN', { runId: 1 });
    expect(res).toEqual({ status: 'success' });
  });

  // The real bug this closes: entrypoints/offscreen/main.ts's cases used
  // `supervisors.get(runId)?.pause()` and returned `{status:'success'}`
  // unconditionally, so a runId the registry didn't have (run already
  // ended, or the offscreen document never actually got RUN_ADMITTED —
  // lib/model/offscreen-bridge.ts's header) was reported as a successful
  // pause/resume/take-over/approval/answer with nothing having happened.
  it('reports a real error, not false success, when the Supervisor was never found (found: false)', async () => {
    chrome.runtime.onMessage.addListener((message: any, _s: any, sendResponse: (r: any) => void) => {
      if (message?.target !== 'offscreen' || message.type !== 'TAKE_OVER_RUN') return;
      sendResponse({ data: { found: false } });
      return true;
    });

    const res = await relayRunControl('TAKE_OVER_RUN', { runId: 999 });
    expect(res.status).toBe('error');
    expect((res as any).message).toMatch(/couldn't be reached/);
  });

  it('reports a real error, not false success, when offscreen never answers at all', async () => {
    // No listener registered at all — askOffscreen()'s own .catch(() =>
    // undefined) is exactly the silent-failure path this whole fix exists
    // to stop leaking as a false "success" to the caller.
    const res = await relayRunControl('RESUME_RUN', { runId: 1 });
    expect(res.status).toBe('error');
  });
});
