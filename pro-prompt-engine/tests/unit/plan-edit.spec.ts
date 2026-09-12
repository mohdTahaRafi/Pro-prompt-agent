/**
 * The plan event chain — plan.proposed -> plan.edited -> plan.approved.
 * Docs/planning/phase_5_agent_loop.md §8, §11 task 5.9.
 *
 * The constrained editor itself (verb x target-from-snapshot x value, no
 * free-form step text) lives in entrypoints/sidepanel/Cockpit.tsx — a UI
 * concern exercised by tests/e2e/form-fill.spec.ts against the real panel.
 * This covers the part reachable without a browser: an edited plan is
 * journaled as the user's version and IS what `run.plan` ends up storing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Supervisor, type RunAdmitted } from '@lib/agent/supervisor';
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

const CONTINUE = {
  handle: 'e5', role: 'button', name: 'Continue', nameSource: 'content' as const, tag: 'button',
  inputType: 'button', enabled: true, visible: true, inViewport: true, actionable: true,
  sensitiveKind: null as const, regionId: 'form:0', ordinal: 0, formId: 'form:1',
};
const NEXT = { ...CONTINUE, handle: 'e6', name: 'Next' };

function snapshot(): PerceptionSnapshot {
  return {
    runId: 'r', tabId: TAB, epoch: 1, url: `${ORIGIN}/`, origin: ORIGIN, title: '', settled: true,
    settleWaitedMs: 0, settleCalibration: 'visible', epochSuspect: false, elements: [CONTINUE, NEXT],
    excludedCount: 0, regions: [], unreachableRegions: [], buildMs: 1,
  };
}

const ORIGINAL_PLAN: Plan = {
  restatement: 'x', willNotDo: [],
  steps: [
    { n: 1, intent: 'click continue', action: { verb: 'click', handle: 'e5' }, expectation: 'x', targetHint: { role: 'button', name: 'Continue' } },
    { n: 2, intent: 'click next', action: { verb: 'click', handle: 'e6' }, expectation: 'x', targetHint: { role: 'button', name: 'Next' } },
  ],
};

async function admit(): Promise<RunAdmitted> {
  const record: RunRecord = {
    goal: 'x', state: 'planning', mode: 'supervised', posture: 'local-only', backend: 'dom',
    origin: ORIGIN, scope: [ORIGIN], roster: [TAB],
    budgets: { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 },
    startedAt: Date.now(),
  };
  const runId = await db.runs.add(record);
  return { runId, tabId: TAB, goal: 'x', mode: 'supervised', posture: 'local-only', origin: ORIGIN };
}

beforeEach(async () => {
  // A prior test's mockResolvedValueOnce() queue must never survive into
  // this one — a leaked "once" value (e.g. under a slow/loaded CI runner
  // where a test's OWN expected consuming call is delayed past the test
  // boundary) would silently answer a LATER test's planner call instead.
  (mockedPlan as any).mockReset();
  await db.sitePolicy.clear();
  await db.runs.clear();
  (chrome.permissions as any).__granted.add(`${ORIGIN}/*`);
  chrome.tabs.__setTab(TAB, `${ORIGIN}/`);
  await db.sitePolicy.put({
    origin: ORIGIN, capabilities: ['click', 'read_page', 'read_structure'], defaultMode: 'supervised', grantedAt: Date.now(),
  });
  chrome.runtime.onMessage.addListener((message: any, _s: any, sendResponse: (r: any) => void) => {
    if (message?.type !== 'AGENT_GATE_CHECK') return;
    (async () => {
      const validated = ActionRequestSchema.safeParse(message.payload);
      if (!validated.success) return sendResponse({ status: 'error', message: 'MALFORMED_ACTION' });
      sendResponse({ status: 'success', data: await gate(validated.data) });
    })();
    return true;
  });
  (chrome.tabs.sendMessage as any).mockImplementation(async (_tabId: number, msg: any) => {
    if (msg.type === 'PERCEIVE_STRUCTURE' || msg.type === 'PERCEIVE_PAGE') return { status: 'success', data: snapshot() };
    if (msg.type === 'ACTUATE') return { ok: true, value: { dispatched: true, elapsedMs: 5 } };
    return undefined;
  });
  (mockedPlan as any).mockResolvedValue(Ok(ORIGINAL_PLAN));
});

describe('editing and approving a plan', () => {
  it('removing a step journals plan.proposed -> plan.edited -> plan.approved, and stores the EDITED plan on the run row', async () => {
    const admitted = await admit();
    const sup = new Supervisor(admitted);
    const running = sup.run();

    await vi.waitFor(async () => {
      const run = await db.runs.get(admitted.runId);
      expect(run?.state).toBe('awaiting_plan_approval');
    });

    const edited: Plan = { ...ORIGINAL_PLAN, steps: [ORIGINAL_PLAN.steps[0]] };   // step 2 removed
    // Editing fires trigger 6 (user_edited_plan, §4.3) on the very next
    // step, which re-invokes the (real) planner — told about the edit via
    // priorPlanNote (lib/agent/prompts.ts). This mock simulates a planner
    // that respects that note and does not reintroduce the removed step.
    (mockedPlan as any).mockResolvedValueOnce(Ok(edited));
    sup.respondPlanApproval(true, edited);
    await running;

    const proposed = await journal.query(admitted.runId, 'plan.proposed');
    const editedEvents = await journal.query(admitted.runId, 'plan.edited');
    const approved = await journal.query(admitted.runId, 'plan.approved');
    expect(proposed).toHaveLength(1);
    expect(editedEvents).toHaveLength(1);
    expect(approved).toHaveLength(1);
    // Journal order — proposed, then edited, then approved.
    expect(proposed[0].seq).toBeLessThan(editedEvents[0].seq);
    expect(editedEvents[0].seq).toBeLessThan(approved[0].seq);

    const run = await db.runs.get(admitted.runId);
    expect(run?.plan?.steps).toHaveLength(1);   // the user's version, not the planner's original two
    expect(run?.plan?.steps[0].n).toBe(1);
  });

  it('approving WITHOUT edits journals no plan.edited event at all', async () => {
    const admitted = await admit();
    const sup = new Supervisor(admitted);
    const running = sup.run();

    await vi.waitFor(async () => {
      const run = await db.runs.get(admitted.runId);
      expect(run?.state).toBe('awaiting_plan_approval');
    });

    sup.respondPlanApproval(true);
    await running;

    expect(await journal.query(admitted.runId, 'plan.edited')).toHaveLength(0);
    const run = await db.runs.get(admitted.runId);
    expect(run?.plan?.steps).toHaveLength(2);   // the planner's original, unmodified
  });
});
