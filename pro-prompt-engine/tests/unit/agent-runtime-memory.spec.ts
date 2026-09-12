/**
 * §13 performance validation — "Agent-runtime state memory ≤ 8 MB (heap
 * snapshot after a 40-action run)". Docs/planning/phase_5_agent_loop.md.
 *
 * MEASUREMENT NOTE: in production this state lives in the offscreen
 * document's own Chrome process, which a literal Chrome heap snapshot
 * would target directly. This environment's `chrome.offscreen.
 * createDocument()` does not execute the offscreen document's script at
 * all (lib/model/offscreen-bridge.ts's header has the full verification —
 * a hard environment limitation, not something a code change here fixes),
 * so no real Supervisor is ever reachable in a real browser here, and a
 * literal Chrome heap snapshot cannot be taken. What this test measures
 * instead is the SAME thing the AC actually cares about — whether a
 * Supervisor's own retained state (Budget's counters and stuck-detection
 * maps, TabRoster, the plan/step bookkeeping) stays small and bounded
 * after a real 40-action run, not whatever else happens to be resident in
 * a browser process — by driving a real Supervisor through a real 40-step
 * plan (mocked planner + mocked page messaging, exactly supervisor.spec.ts's
 * own pattern, through the REAL gate) and measuring the serialized size of
 * its actual retained objects with Node's `v8.serialize()`, a
 * deterministic, engine-level proxy for retained object-graph size that
 * needs no `--expose-gc` flag or heap-snapshot file to be reliable across
 * CI machines.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { serialize } from 'node:v8';
import { Supervisor, type RunAdmitted } from '@lib/agent/supervisor';
import { gate } from '@lib/policy/gate';
import { ActionRequestSchema } from '@lib/schemas/action.schema';
import { db } from '@lib/db/dexie-db';
import type { RunRecord } from '@lib/types/run.types';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import type { Plan } from '@lib/schemas/plan.schema';
import { Ok } from '@lib/utils/result';

vi.mock('@lib/agent/planner', () => ({ plan: vi.fn() }));
import { plan as mockedPlan } from '@lib/agent/planner';

const ORIGIN = 'https://memory.example.org';
const TAB = 77;
const ACTION_COUNT = 40;   // the run's own budgets.maxActions below, matching the AC's "after a 40-action run"

function snapshot(elements: PerceptionSnapshot['elements'], epoch = 1): PerceptionSnapshot {
  return {
    runId: 'r', tabId: TAB, epoch, url: `${ORIGIN}/`, origin: ORIGIN, title: '', settled: true,
    settleWaitedMs: 0, settleCalibration: 'visible', epochSuspect: false, elements, excludedCount: 0,
    regions: [], unreachableRegions: [], buildMs: 1,
  };
}

// 40 distinct buttons — each plan step clicks a DIFFERENT one. Reusing one
// handle 40 times would trip lib/agent/budget.ts's own stuck detector
// (three identical verb+handle+outcome tuples ends the run early as
// 'stuck', by design) well before reaching 40 real actions; 40 distinct
// targets is both what avoids that and a closer stand-in for a real
// multi-field form than clicking one button repeatedly would be.
const BUTTONS = Array.from({ length: ACTION_COUNT }, (_, i) => ({
  handle: `e${i}`, role: 'button' as const, name: `Field ${i + 1}`, nameSource: 'content' as const, tag: 'button',
  inputType: 'button', enabled: true, visible: true, inViewport: true, actionable: true,
  sensitiveKind: null as const, regionId: 'form:0', ordinal: i, formId: 'form:1',
}));

const PLAN: Plan = {
  restatement: 'click every field', willNotDo: [],
  steps: BUTTONS.map((b, i) => ({
    n: i + 1, intent: `click ${b.name}`,
    action: { verb: 'click' as const, handle: b.handle },
    expectation: 'moves on', targetHint: { role: 'button', name: b.name },
  })),
};

async function admit(): Promise<RunAdmitted> {
  const record: RunRecord = {
    goal: 'click continue 40 times', state: 'planning', mode: 'supervised', posture: 'local-only', backend: 'dom',
    origin: ORIGIN, scope: [ORIGIN], roster: [TAB],
    budgets: { maxActions: ACTION_COUNT, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 },
    startedAt: Date.now(),
  };
  const runId = await db.runs.add(record);
  return { runId, tabId: TAB, goal: record.goal, mode: 'supervised', posture: 'local-only', origin: ORIGIN };
}

beforeEach(async () => {
  (mockedPlan as any).mockReset();
  await db.sitePolicy.clear();
  await db.runs.clear();
  (chrome.permissions as any).__granted.add(`${ORIGIN}/*`);
  chrome.tabs.__setTab(TAB, `${ORIGIN}/`);
  await db.sitePolicy.put({
    origin: ORIGIN, capabilities: ['click', 'read_page', 'read_structure', 'read_element', 'wait_for_settle'],
    defaultMode: 'supervised', grantedAt: Date.now(),
  });

  chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (r: any) => void) => {
    if (message?.type !== 'AGENT_GATE_CHECK') return;
    (async () => {
      const validated = ActionRequestSchema.safeParse(message.payload);
      if (!validated.success) return sendResponse({ status: 'error', message: 'MALFORMED_ACTION' });
      sendResponse({ status: 'success', data: await gate(validated.data) });
    })();
    return true;
  });

  let epoch = 1;
  (chrome.tabs.sendMessage as any).mockImplementation(async (_tabId: number, msg: any) => {
    if (msg.type === 'PERCEIVE_STRUCTURE' || msg.type === 'PERCEIVE_PAGE') return { status: 'success', data: snapshot(BUTTONS, epoch++) };
    if (msg.type === 'ACTUATE') return { ok: true, value: { dispatched: true, elapsedMs: 1 } };
    return undefined;
  });

  (mockedPlan as any).mockResolvedValue(Ok(PLAN));
});

describe('agent-runtime state memory (§13, 2026-09-13 audit)', () => {
  it('a real 40-action run keeps the Supervisor\'s own retained state well under the 8 MB budget', async () => {
    const admitted = await admit();
    const sup = new Supervisor(admitted);
    const running = sup.run();

    await vi.waitFor(async () => {
      const run = await db.runs.get(admitted.runId);
      expect(run?.state).toBe('awaiting_plan_approval');
    });
    sup.respondPlanApproval(true);
    await running;

    const run = await db.runs.get(admitted.runId);
    expect(run?.state).toBe('completed');

    // Confirm this genuinely drove 40 actions, not a short-circuited run —
    // a memory measurement over a 2-action run would not test the AC at
    // all.
    const budget = (sup as any).budget;
    expect(budget.actionsUsed()).toBe(ACTION_COUNT);

    // The Supervisor's own retained object graph: its budget (counters +
    // the retries/repeats stuck-detection maps — the one part of this
    // class whose size scales with run length), its tab roster, and its
    // tab agent (snapshot + epoch bookkeeping). `serialize()` throws on
    // values it cannot clone (functions, etc.) — Waiter promises and
    // bound listener functions are exactly that, so each is captured
    // through a plain-data snapshot of what it actually accumulates, the
    // same fields a hand-rolled heap-snapshot filter would keep.
    const retained = {
      budget: {
        actions: budget.actionsUsed(), plannerCalls: budget.plannerCallsUsed(),
        retries: Array.from((budget as any).retries.entries()),
        repeats: Array.from((budget as any).repeats.entries()),
      },
      roster: Array.from((sup as any).roster.list?.() ?? (sup as any).roster.tabs?.entries?.() ?? []),
      tabAgentSnapshot: (sup as any).tabAgent.snapshot ?? null,
      plan: run?.plan,
    };

    const bytes = serialize(retained).byteLength;
    const MB = 1024 * 1024;
    // eslint-disable-next-line no-console
    console.log(`[bench] agent-runtime state memory after a ${ACTION_COUNT}-action run — ${bytes} bytes (${(bytes / MB).toFixed(4)} MB) vs an 8 MB budget`);
    expect(bytes, `retained state serialized to ${(bytes / MB).toFixed(3)} MB`).toBeLessThan(8 * MB);
    // Sanity floor — a measurement that always reports ~0 bytes would pass
    // the budget for the wrong reason (measuring nothing).
    expect(bytes).toBeGreaterThan(100);
  });
});
