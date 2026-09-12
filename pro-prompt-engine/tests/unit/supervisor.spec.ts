/**
 * lib/agent/supervisor.ts — the five-phase run driver.
 * Docs/planning/phase_5_agent_loop.md §4.1, §11 task 5.1.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { legalPhaseTransition, advancePhase, Supervisor, type RunPhase, type RunAdmitted } from '@lib/agent/supervisor';
import { gate } from '@lib/policy/gate';
import { ActionRequestSchema } from '@lib/schemas/action.schema';
import * as journal from '@lib/agent/journal';
import { db } from '@lib/db/dexie-db';
import type { RunRecord } from '@lib/types/run.types';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import type { Plan } from '@lib/schemas/plan.schema';
import { Ok } from '@lib/utils/result';

vi.mock('@lib/agent/planner', () => ({ plan: vi.fn() }));
import { plan as mockedPlan } from '@lib/agent/planner';

const ORIGIN = 'https://practice.example.org';
const TAB = 42;

// ── §4.1's phase table — the ACTUAL acceptance criterion: all legal phase
//    transitions succeed and illegal ones throw, driven against a synthetic
//    multi-agent roster even though production (roster of one) only ever
//    walks survey -> act -> end. ──

describe('phase table (supervisor.spec.ts task 5.1)', () => {
  const ALL: RunPhase[] = ['survey', 'read', 'synthesise', 'act', 'end'];
  const LEGAL: Record<RunPhase, RunPhase[]> = {
    survey: ['read', 'act', 'end'], read: ['synthesise', 'end'],
    synthesise: ['act', 'end'], act: ['read', 'end'], end: [],
  };

  it('every legal edge succeeds', () => {
    for (const from of ALL) {
      for (const to of LEGAL[from]) {
        expect(legalPhaseTransition(from, to), `${from} -> ${to}`).toBe(true);
        expect(advancePhase(from, to)).toBe(to);
      }
    }
  });

  it('every illegal edge throws', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        if (LEGAL[from].includes(to)) continue;
        expect(legalPhaseTransition(from, to), `${from} -> ${to}`).toBe(false);
        expect(() => advancePhase(from, to)).toThrow(/ILLEGAL_PHASE_TRANSITION/);
      }
    }
  });

  it('drives a synthetic TWO-AGENT roster through the full survey -> read -> synthesise -> act -> end walk', () => {
    // Production (roster of one) collapses read/synthesise into act (§4.1's
    // header). A roster of two — [Phase 7] raises the cap — would fan out
    // through every phase; this exercises exactly that walk now, on the
    // same table production uses, so Phase 7 instantiates rather than
    // introduces it.
    let phase: RunPhase = 'survey';
    for (const next of ['read', 'synthesise', 'act', 'end'] as const) {
      phase = advancePhase(phase, next);
    }
    expect(phase).toBe('end');
  });

  it('the terminal phase accepts no further transition', () => {
    for (const to of ALL) expect(legalPhaseTransition('end', to)).toBe(false);
  });
});

// ── Integration: a real run() walk against mocked planner + mocked page
//    messaging, through the REAL gate. ──

function snapshot(elements: PerceptionSnapshot['elements'], epoch = 1): PerceptionSnapshot {
  return {
    runId: 'r', tabId: TAB, epoch, url: `${ORIGIN}/`, origin: ORIGIN, title: '', settled: true,
    settleWaitedMs: 0, settleCalibration: 'visible', epochSuspect: false, elements, excludedCount: 0,
    regions: [], unreachableRegions: [], buildMs: 1,
  };
}

const CONTINUE = {
  handle: 'e5', role: 'button', name: 'Continue', nameSource: 'content' as const, tag: 'button',
  inputType: 'button', enabled: true, visible: true, inViewport: true, actionable: true,
  sensitiveKind: null as const, regionId: 'form:0', ordinal: 0, formId: 'form:1',
};

const PLAN: Plan = {
  restatement: 'click continue', willNotDo: [],
  steps: [{ n: 1, intent: 'click continue', action: { verb: 'click', handle: 'e5' }, expectation: 'moves on', targetHint: { role: 'button', name: 'Continue' } }],
};

async function admit(mode: RunRecord['mode'] = 'supervised'): Promise<RunAdmitted> {
  const record: RunRecord = {
    goal: 'click continue', state: 'planning', mode, posture: 'local-only', backend: 'dom',
    origin: ORIGIN, scope: [ORIGIN], roster: [TAB],
    budgets: { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 },
    startedAt: Date.now(),
  };
  const runId = await db.runs.add(record);
  return { runId, tabId: TAB, goal: record.goal, mode, posture: 'local-only', origin: ORIGIN };
}

beforeEach(async () => {
  (mockedPlan as any).mockReset();   // see tests/unit/plan-edit.spec.ts's beforeEach comment
  await db.sitePolicy.clear();
  await db.runs.clear();
  (chrome.permissions as any).__granted.add(`${ORIGIN}/*`);
  chrome.tabs.__setTab(TAB, `${ORIGIN}/`);
  await db.sitePolicy.put({
    origin: ORIGIN, capabilities: ['click', 'read_page', 'read_structure', 'read_element', 'wait_for_settle'],
    defaultMode: 'supervised', grantedAt: Date.now(),
  });

  // The real gate, reached the same way lib/agent/gate-client.ts reaches it
  // in production — over chrome.runtime.sendMessage — so this test exercises
  // the REAL boundary, not a stubbed-out permission.
  chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (r: any) => void) => {
    if (message?.type !== 'AGENT_GATE_CHECK') return;
    (async () => {
      const validated = ActionRequestSchema.safeParse(message.payload);
      if (!validated.success) return sendResponse({ status: 'error', message: 'MALFORMED_ACTION' });
      sendResponse({ status: 'success', data: await gate(validated.data) });
    })();
    return true;
  });

  const snap = snapshot([CONTINUE]);
  (chrome.tabs.sendMessage as any).mockImplementation(async (_tabId: number, msg: any) => {
    if (msg.type === 'PERCEIVE_STRUCTURE' || msg.type === 'PERCEIVE_PAGE') return { status: 'success', data: snap };
    if (msg.type === 'ACTUATE') return { ok: true, value: { dispatched: true, elapsedMs: 5 } };
    return undefined;
  });

  (mockedPlan as any).mockResolvedValue(Ok(PLAN));
});

describe('Supervisor.run() — an end-to-end walk against mocks', () => {
  it('plans, holds for plan approval, executes the one step, and completes', async () => {
    const admitted = await admit();
    const sup = new Supervisor(admitted);
    const running = sup.run();

    // Let survey()+planStep() run (they are pure microtask chains against
    // the mocks above — no real timers involved).
    await vi.waitFor(async () => {
      const run = await db.runs.get(admitted.runId);
      expect(run?.state).toBe('awaiting_plan_approval');
    });

    const proposed = await journal.query(admitted.runId, 'plan.proposed');
    expect(proposed).toHaveLength(1);

    sup.respondPlanApproval(true);
    await running;

    const run = await db.runs.get(admitted.runId);
    expect(run?.state).toBe('completed');
    expect(run?.outcome).toBe('completed');

    const approved = await journal.query(admitted.runId, 'plan.approved');
    expect(approved).toHaveLength(1);
    const observed = await journal.query(admitted.runId, 'action.observed');
    expect(observed.length).toBeGreaterThan(0);
    const completed = await journal.query(admitted.runId, 'run.completed');
    expect(completed).toHaveLength(1);
  });

  it('a plan rejection ends the run without executing any step', async () => {
    const admitted = await admit();
    const sup = new Supervisor(admitted);
    const running = sup.run();

    await vi.waitFor(async () => {
      const run = await db.runs.get(admitted.runId);
      expect(run?.state).toBe('awaiting_plan_approval');
    });

    sup.respondPlanApproval(false);
    await running;

    const run = await db.runs.get(admitted.runId);
    expect(run?.state).toBe('stopped');
    const dispatched = await journal.query(admitted.runId, 'action.dispatched');
    expect(dispatched).toHaveLength(0);
  });

  it('Stop, pressed while blocked awaiting plan approval, halts the run within the same tick', async () => {
    const admitted = await admit();
    const sup = new Supervisor(admitted);
    const running = sup.run();

    await vi.waitFor(async () => {
      const run = await db.runs.get(admitted.runId);
      expect(run?.state).toBe('awaiting_plan_approval');
    });

    await chrome.storage.session.set({ [`stop:${admitted.runId}`]: true });
    await running;

    const run = await db.runs.get(admitted.runId);
    expect(run?.state).toBe('stopped');
  });
});
