/**
 * Pause, Take over, Resume, ask_user and finish.
 * Docs/planning/phase_5_agent_loop.md §11 tasks 5.13, 5.14.
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

function snapshot(): PerceptionSnapshot {
  return {
    runId: 'r', tabId: TAB, epoch: 1, url: `${ORIGIN}/`, origin: ORIGIN, title: '', settled: true,
    settleWaitedMs: 0, settleCalibration: 'visible', epochSuspect: false, elements: [CONTINUE],
    excludedCount: 0, regions: [], unreachableRegions: [], buildMs: 1,
  };
}

const CLICK_PLAN: Plan = {
  restatement: 'click continue', willNotDo: [],
  steps: [{ n: 1, intent: 'click continue', action: { verb: 'click', handle: 'e5' }, expectation: 'x', targetHint: { role: 'button', name: 'Continue' } }],
};

// Two steps — Pause/Take over need a SECOND step still pending to actually
// block anything; a one-step plan has nothing left to pause before.
const TWO_CLICK_PLAN: Plan = {
  restatement: 'click continue twice', willNotDo: [],
  steps: [
    { n: 1, intent: 'click continue', action: { verb: 'click', handle: 'e5' }, expectation: 'x', targetHint: { role: 'button', name: 'Continue' } },
    { n: 2, intent: 'click continue again', action: { verb: 'click', handle: 'e5' }, expectation: 'x', targetHint: { role: 'button', name: 'Continue' } },
  ],
};

const ASK_PLAN: Plan = {
  restatement: 'ask then finish', willNotDo: [],
  steps: [
    { n: 1, intent: 'ask a question', action: { verb: 'ask_user', question: 'Which one?', reason: 'AMBIGUOUS_TARGET' }, expectation: 'x' },
    { n: 2, intent: 'finish', action: { verb: 'finish', outcome: 'completed', summary: 'model-authored, ignored' }, expectation: 'x' },
  ],
};

async function admit(planForThisRun: Plan): Promise<RunAdmitted> {
  const record: RunRecord = {
    goal: 'x', state: 'planning', mode: 'supervised', posture: 'local-only', backend: 'dom',
    origin: ORIGIN, scope: [ORIGIN], roster: [TAB],
    budgets: { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 },
    startedAt: Date.now(),
  };
  const runId = await db.runs.add(record);
  (mockedPlan as any).mockResolvedValue(Ok(planForThisRun));
  return { runId, tabId: TAB, goal: 'x', mode: 'supervised', posture: 'local-only', origin: ORIGIN };
}

beforeEach(async () => {
  (mockedPlan as any).mockReset();   // see plan-edit.spec.ts's beforeEach comment
  await db.sitePolicy.clear();
  await db.runs.clear();
  (chrome.permissions as any).__granted.add(`${ORIGIN}/*`);
  chrome.tabs.__setTab(TAB, `${ORIGIN}/`);
  await db.sitePolicy.put({
    origin: ORIGIN, capabilities: ['click', 'ask_user', 'finish', 'read_page', 'read_structure'],
    defaultMode: 'supervised', grantedAt: Date.now(),
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
});

/** Deterministically parks a run mid-step: the FIRST ACTUATE call hangs
 *  until release() is called; every later ACTUATE call resolves
 *  immediately. Everything else races through microtasks too fast for a
 *  real await-based window to observe 'running' reliably — this is the
 *  only reliable way to catch a run genuinely still in flight. */
function armActuateGate(): { armed: Promise<void>; release: () => void } {
  let notifyArmed!: () => void;
  const armed = new Promise<void>((resolve) => { notifyArmed = resolve; });
  let releaseActuate: (() => void) | null = null;
  let first = true;
  (chrome.tabs.sendMessage as any).mockImplementation(async (_tabId: number, msg: any) => {
    if (msg.type === 'PERCEIVE_STRUCTURE' || msg.type === 'PERCEIVE_PAGE') return { status: 'success', data: snapshot() };
    if (msg.type === 'ACTUATE') {
      if (!first) return { ok: true, value: { dispatched: true, elapsedMs: 5 } };
      first = false;
      const held = new Promise<void>((resolve) => { releaseActuate = resolve; });
      notifyArmed();
      await held;
      return { ok: true, value: { dispatched: true, elapsedMs: 5 } };
    }
    return undefined;
  });
  return { armed, release: () => releaseActuate?.() };
}

describe('Pause / Resume', () => {
  it('Pause refuses every action with RUN_STATE, and Resume re-snapshots before the next step', async () => {
    const gateHandle = armActuateGate();
    const admitted = await admit(TWO_CLICK_PLAN);
    const sup = new Supervisor(admitted);
    const running = sup.run();

    await vi.waitFor(async () => expect((await db.runs.get(admitted.runId))?.state).toBe('awaiting_plan_approval'));
    sup.respondPlanApproval(true);

    await gateHandle.armed;   // step 1's ACTUATE is genuinely in flight — state is definitely 'running'
    expect((await db.runs.get(admitted.runId))?.state).toBe('running');
    await sup.pause();
    gateHandle.release();     // let step 1 finish; the loop must block BEFORE step 2

    await vi.waitFor(async () => expect((await db.runs.get(admitted.runId))?.state).toBe('paused'));
    expect(await journal.query(admitted.runId, 'run.paused')).toHaveLength(1);
    expect(await journal.query(admitted.runId, 'action.dispatched')).toHaveLength(1);   // only step 1 ran

    // While paused, a direct gate check for this run is refused RUN_STATE —
    // the backstop task 5.13 names, independent of the Supervisor's own loop.
    const decision = await gate({
      requestId: '9c858901-8a57-4791-81fe-4c455b099bc9', runId: admitted.runId, tabId: TAB, epoch: 1,
      action: { verb: 'click', handle: 'e5' }, reason: 't',
    });
    expect(decision).toEqual({ permitted: false, code: 'RUN_STATE' });

    const perceiveCallsBeforeResume = (chrome.tabs.sendMessage as any).mock.calls
      .filter((c: any[]) => c[1]?.type?.startsWith('PERCEIVE')).length;
    await sup.resume();
    await running;

    const perceiveCallsAfter = (chrome.tabs.sendMessage as any).mock.calls
      .filter((c: any[]) => c[1]?.type?.startsWith('PERCEIVE')).length;
    expect(perceiveCallsAfter).toBeGreaterThan(perceiveCallsBeforeResume);   // re-snapshotted (§9.4)
    expect(await journal.query(admitted.runId, 'run.resumed')).toHaveLength(1);
    expect(await journal.query(admitted.runId, 'action.dispatched')).toHaveLength(2);   // step 2 ran after resume
    const run = await db.runs.get(admitted.runId);
    expect(run?.state).toBe('completed');
  });
});

describe('Take over / Resume', () => {
  it('Take over refuses every action and shows the driving state; Resume hands control back', async () => {
    const gateHandle = armActuateGate();
    const admitted = await admit(TWO_CLICK_PLAN);
    const sup = new Supervisor(admitted);
    const running = sup.run();

    await vi.waitFor(async () => expect((await db.runs.get(admitted.runId))?.state).toBe('awaiting_plan_approval'));
    sup.respondPlanApproval(true);

    await gateHandle.armed;
    await sup.takeOver();
    gateHandle.release();

    await vi.waitFor(async () => expect((await db.runs.get(admitted.runId))?.state).toBe('taken_over'));
    expect(await journal.query(admitted.runId, 'run.taken_over')).toHaveLength(1);
    expect(await journal.query(admitted.runId, 'action.dispatched')).toHaveLength(1);

    await sup.resume();
    await running;

    expect(await journal.query(admitted.runId, 'action.dispatched')).toHaveLength(2);
    const run = await db.runs.get(admitted.runId);
    expect(run?.state).toBe('completed');
  });
});

describe('ask_user and finish (§10)', () => {
  it('ask_user pauses the wall clock, journals its reason code, and answering resumes the run', async () => {
    const admitted = await admit(ASK_PLAN);
    const sup = new Supervisor(admitted);
    const running = sup.run();

    await vi.waitFor(async () => expect((await db.runs.get(admitted.runId))?.state).toBe('awaiting_plan_approval'));
    sup.respondPlanApproval(true);

    // The plan's own ask_user step drives the run to awaiting_user — there
    // is no explicit state transition call needed; executeStep() surfaces
    // it and act() blocks on the answer.
    await vi.waitFor(async () => {
      const events = await journal.query(admitted.runId, 'ask_user.asked');
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({ question: 'Which one?', reason: 'AMBIGUOUS_TARGET' });
    });

    sup.respondAskUser('the first one');
    await running;

    const answered = await journal.query(admitted.runId, 'ask_user.answered');
    expect(answered).toHaveLength(1);
    expect(answered[0].data).toEqual({ answer: 'the first one' });

    // finish's outcome/state are journaled — the SUMMARY is composed from
    // the journal (reporter.ts), never trusted verbatim from the model's
    // own `summary` field on the finish action (§10).
    const completed = await journal.query(admitted.runId, 'run.completed');
    expect(completed).toHaveLength(1);
    expect((completed[0].data as any).summary).not.toBe('model-authored, ignored');
    const run = await db.runs.get(admitted.runId);
    expect(run?.state).toBe('completed');
    expect(run?.outcome).toBe('completed');
  });
});
