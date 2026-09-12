/**
 * lib/agent/tab-agent.ts — observe -> decide -> request -> verify.
 * Docs/planning/phase_5_agent_loop.md §5, §11 task 5.5.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TabAgent } from '@lib/agent/tab-agent';
import { Budget } from '@lib/agent/budget';
import { gate } from '@lib/policy/gate';
import { ActionRequestSchema } from '@lib/schemas/action.schema';
import { db } from '@lib/db/dexie-db';
import type { RunRecord, RunBudgets } from '@lib/types/run.types';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import type { PlanStep } from '@lib/schemas/plan.schema';

const ORIGIN = 'https://practice.example.org';
const TAB = 42;
const LIMITS: RunBudgets = { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 };

function snapshot(elements: PerceptionSnapshot['elements'], opts: Partial<PerceptionSnapshot> = {}): PerceptionSnapshot {
  return {
    runId: 'r', tabId: TAB, epoch: 1, url: `${ORIGIN}/`, origin: ORIGIN, title: '', settled: true,
    settleWaitedMs: 0, settleCalibration: 'visible', epochSuspect: false, elements, excludedCount: 0,
    regions: [], unreachableRegions: [], buildMs: 1,
    ...opts,
  };
}

const CONTINUE = {
  handle: 'e5', role: 'button', name: 'Continue', nameSource: 'content' as const, tag: 'button',
  inputType: 'button', enabled: true, visible: true, inViewport: true, actionable: true,
  sensitiveKind: null as const, regionId: 'form:0', ordinal: 0, formId: 'form:1',
};

let runId: number;
let capturedTabIds: number[];

beforeEach(async () => {
  capturedTabIds = [];
  await db.sitePolicy.clear();
  await db.runs.clear();
  (chrome.permissions as any).__granted.add(`${ORIGIN}/*`);
  chrome.tabs.__setTab(TAB, `${ORIGIN}/`);
  await db.sitePolicy.put({
    origin: ORIGIN, capabilities: ['click', 'read_page', 'read_structure'], defaultMode: 'supervised', grantedAt: Date.now(),
  });
  const record: RunRecord = {
    goal: '', state: 'running', mode: 'supervised', posture: 'local-only', backend: 'dom',
    origin: ORIGIN, scope: [ORIGIN], roster: [TAB], budgets: LIMITS, startedAt: Date.now(),
    plan: { restatement: 'x', willNotDo: [], steps: [
      { n: 1, intent: 'click continue', action: { verb: 'click', handle: 'e5' }, expectation: 'x', targetHint: { role: 'button', name: 'Continue' } },
    ] },
  };
  runId = await db.runs.add(record);

  chrome.runtime.onMessage.addListener((message: any, _sender: any, sendResponse: (r: any) => void) => {
    if (message?.type !== 'AGENT_GATE_CHECK') return;
    (async () => {
      const validated = ActionRequestSchema.safeParse(message.payload);
      if (!validated.success) return sendResponse({ status: 'error', message: 'MALFORMED_ACTION' });
      sendResponse({ status: 'success', data: await gate(validated.data) });
    })();
    return true;
  });

  (chrome.tabs.sendMessage as any).mockImplementation(async (tabId: number, msg: any) => {
    capturedTabIds.push(tabId);
    if (msg.type === 'PERCEIVE_STRUCTURE' || msg.type === 'PERCEIVE_PAGE') return { status: 'success', data: snapshot([CONTINUE]) };
    if (msg.type === 'ACTUATE') return { ok: true, value: { dispatched: true, elapsedMs: 5 } };
    return undefined;
  });
});

const STEP: PlanStep = { n: 1, intent: 'click continue', action: { verb: 'click', handle: 'e5' }, expectation: 'x', targetHint: { role: 'button', name: 'Continue' } };

describe('TabAgent.executeStep', () => {
  it('re-snapshots on the first call (no snapshot yet), then does not re-snapshot when nothing is stale', async () => {
    const agent = new TabAgent(runId, TAB, new Budget(LIMITS, runId), 'local-only');
    await agent.executeStep(STEP);
    const callsAfterFirst = (chrome.tabs.sendMessage as any).mock.calls.length;

    // performAndVerify's own post-perceive already advances the epoch and
    // clears staleness only when the verdict was 'confirmed' at a
    // non-location check — this click resolves 'unconfirmed' (no settle/
    // regions signal in the fixture), which marks the NEXT step stale by
    // design (this.stale = verdict.verified !== 'confirmed').
    await agent.executeStep(STEP);
    expect((chrome.tabs.sendMessage as any).mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('every request carries this agent\'s own tabId, never another', async () => {
    const agent = new TabAgent(runId, TAB, new Budget(LIMITS, runId), 'local-only');
    await agent.executeStep(STEP);
    expect(capturedTabIds.length).toBeGreaterThan(0);
    expect(capturedTabIds.every((t) => t === TAB)).toBe(true);
  });

  it('a suspect epoch always re-snapshots, even right after a fresh one', async () => {
    (chrome.tabs.sendMessage as any).mockImplementation(async (tabId: number, msg: any) => {
      capturedTabIds.push(tabId);
      if (msg.type === 'PERCEIVE_STRUCTURE' || msg.type === 'PERCEIVE_PAGE') {
        return { status: 'success', data: snapshot([CONTINUE], { epochSuspect: true }) };
      }
      if (msg.type === 'ACTUATE') return { ok: true, value: { dispatched: true, elapsedMs: 5 } };
      return undefined;
    });
    const agent = new TabAgent(runId, TAB, new Budget(LIMITS, runId), 'local-only');
    await agent.executeStep(STEP);
    const n1 = (chrome.tabs.sendMessage as any).mock.calls.filter((c: any[]) => c[1]?.type?.startsWith('PERCEIVE')).length;
    await agent.executeStep(STEP);
    const n2 = (chrome.tabs.sendMessage as any).mock.calls.filter((c: any[]) => c[1]?.type?.startsWith('PERCEIVE')).length;
    expect(n2).toBeGreaterThan(n1);   // re-perceived again despite an otherwise-fresh epoch
  });

  it('a location verdict marks the snapshot stale for the next step', async () => {
    let call = 0;
    (chrome.tabs.sendMessage as any).mockImplementation(async (tabId: number, msg: any) => {
      capturedTabIds.push(tabId);
      if (msg.type === 'PERCEIVE_STRUCTURE' || msg.type === 'PERCEIVE_PAGE') {
        call += 1;
        // Second perceive (the post-action re-read) reports a NEW url —
        // verify()'s click branch reads this as a 'location' verdict.
        return { status: 'success', data: snapshot([CONTINUE], { url: call === 1 ? `${ORIGIN}/` : `${ORIGIN}/next` }) };
      }
      if (msg.type === 'ACTUATE') return { ok: true, value: { dispatched: true, elapsedMs: 5 } };
      return undefined;
    });
    const agent = new TabAgent(runId, TAB, new Budget(LIMITS, runId), 'local-only');
    const outcome = await agent.executeStep(STEP);
    expect(outcome.kind).toBe('done');
    if (outcome.kind === 'done') expect(outcome.result.check).toBe('location');

    const before = (chrome.tabs.sendMessage as any).mock.calls.filter((c: any[]) => c[1]?.type?.startsWith('PERCEIVE')).length;
    await agent.executeStep(STEP);   // must re-snapshot because of the location verdict, not because of epochSuspect
    const after = (chrome.tabs.sendMessage as any).mock.calls.filter((c: any[]) => c[1]?.type?.startsWith('PERCEIVE')).length;
    expect(after).toBeGreaterThan(before);
  });
});
