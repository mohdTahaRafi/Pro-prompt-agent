/**
 * The four autonomy modes — lib/policy/gate.ts §7, §9.
 * Docs/planning/phase_5_agent_loop.md §7, §11 task 5.8.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { gate } from '@lib/policy/gate';
import * as ownership from '@lib/policy/ownership';
import * as journal from '@lib/agent/journal';
import { db } from '@lib/db/dexie-db';
import type { RunRecord } from '@lib/types/run.types';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';

const ORIGIN = 'https://practice.example.org';
const TAB = 42;

function elementSnap(elements: PerceptionSnapshot['elements']): PerceptionSnapshot {
  return {
    runId: 'r', tabId: TAB, epoch: 1, url: `${ORIGIN}/`, origin: ORIGIN, title: '', settled: true,
    settleWaitedMs: 0, settleCalibration: 'visible', epochSuspect: false, elements, excludedCount: 0,
    regions: [], unreachableRegions: [], buildMs: 1,
  };
}

const CONTINUE = {
  handle: 'e5', role: 'button', name: 'Continue', nameSource: 'content' as const, tag: 'button',
  inputType: 'button', enabled: true, visible: true, inViewport: true, actionable: true,
  sensitiveKind: null as const, regionId: 'form:0', ordinal: 0, formId: 'form:1',
};
const SUBMIT = { ...CONTINUE, handle: 'e6', name: 'Submit application', inputType: 'submit' };

async function makeRun(mode: RunRecord['mode'], overrides: Partial<RunRecord> = {}): Promise<number> {
  const record: RunRecord = {
    goal: '', state: 'running', mode, posture: 'local-only', backend: 'dom',
    origin: ORIGIN, scope: [ORIGIN], roster: [TAB],
    budgets: { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 },
    startedAt: Date.now(),
    ...overrides,
  };
  const id = await db.runs.add(record);
  await journal.append(id, 'plan.replanned', null, { trigger: 'run_start', fromStepIndex: 0 });   // bypass goal-anchor — not this file's concern
  return id;
}

async function lowTierClick(runId: number) {
  await ownership.record(runId, TAB, elementSnap([CONTINUE]));
  return gate({ requestId: '9c858901-8a57-4791-81fe-4c455b099bc9', runId, tabId: TAB, epoch: 1, action: { verb: 'click', handle: 'e5' }, reason: 't' });
}

async function alwaysTierClick(runId: number) {
  await ownership.record(runId, TAB, elementSnap([SUBMIT]));
  return gate({ requestId: '9c858901-8a57-4791-81fe-4c455b099bc9', runId, tabId: TAB, epoch: 1, action: { verb: 'click', handle: 'e6' }, reason: 't' });
}

beforeEach(async () => {
  await db.sitePolicy.clear();
  await db.runs.clear();
  (chrome.permissions as any).__granted.add(`${ORIGIN}/*`);
  chrome.tabs.__setTab(TAB, `${ORIGIN}/`);
  await db.sitePolicy.put({
    origin: ORIGIN, capabilities: ['click', 'type', 'select'], defaultMode: 'supervised', grantedAt: Date.now(),
  });
});

describe('Step mode — every action requires approval, every tier including Low', () => {
  it('a Low-tier click needs approval', async () => {
    const runId = await makeRun('step');
    const d = await lowTierClick(runId);
    expect(d.needsApproval).toBe(true);
  });
});

describe('Supervised mode (default) — free on Low, Always always stops', () => {
  it('a Low-tier click is permitted with no approval', async () => {
    const runId = await makeRun('supervised');
    const d = await lowTierClick(runId);
    expect(d).toEqual({ permitted: true, tier: 'low' });
  });

  it('a Medium-tier action needs approval only where site policy says so', async () => {
    const runId = await makeRun('supervised');
    await db.sitePolicy.update(ORIGIN, { capabilities: ['navigate'] });
    const free = await gate({ requestId: '9c858901-8a57-4791-81fe-4c455b099bc9', runId, tabId: TAB, epoch: 1, action: { verb: 'navigate', url: `${ORIGIN}/next` }, reason: 't' });
    expect(free).toEqual({ permitted: true, tier: 'medium' });

    await db.sitePolicy.update(ORIGIN, { mediumRequiresApproval: true });
    const runId2 = await makeRun('supervised');
    const gated = await gate({ requestId: '9c858901-8a57-4791-81fe-4c455b099bc9', runId: runId2, tabId: TAB, epoch: 1, action: { verb: 'navigate', url: `${ORIGIN}/next` }, reason: 't' });
    expect(gated.needsApproval).toBe(true);
  });
});

describe('Suggest mode — behaves as Supervised once past plan approval (§7)', () => {
  it('a Low-tier click is permitted with no approval, same as Supervised', async () => {
    const runId = await makeRun('suggest');
    const d = await lowTierClick(runId);
    expect(d).toEqual({ permitted: true, tier: 'low' });
  });
});

describe('Watch mode — [Phase 11], refused with RUN_STATE', () => {
  it('refuses every action, regardless of tier', async () => {
    const runId = await makeRun('watch');
    const d = await lowTierClick(runId);
    expect(d).toEqual({ permitted: false, code: 'RUN_STATE' });
  });
});

describe('Always-tier approval is required in EVERY mode, without exception (PR-SEC-2, PR-AUT-5)', () => {
  it.each(['suggest', 'step', 'supervised'] as const)('%s mode still holds an Always-tier click for approval', async (mode) => {
    const runId = await makeRun(mode);
    const d = await alwaysTierClick(runId);
    expect(d.permitted).toBe(false);
    expect(d.needsApproval).toBe(true);
    if (d.needsApproval) expect(d.tier).toBe('always');
  });

  it('watch mode refuses an Always-tier action too — RUN_STATE, before tier is ever reached', async () => {
    const runId = await makeRun('watch');
    const d = await alwaysTierClick(runId);
    expect(d).toEqual({ permitted: false, code: 'RUN_STATE' });
  });
});
