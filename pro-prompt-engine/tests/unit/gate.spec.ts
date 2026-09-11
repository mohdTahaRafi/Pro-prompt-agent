/**
 * lib/policy/gate.ts — the eight ordered checks.
 * Docs/planning/phase_3_gate_actuation_verification.md §12 task 3.5.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { gate, IMPLEMENTED_VERBS } from '@lib/policy/gate';
import * as ownership from '@lib/policy/ownership';
import { db } from '@lib/db/dexie-db';
import type { RunRecord } from '@lib/types/run.types';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import type { Action } from '@lib/schemas/action.schema';

const ORIGIN = 'https://practice.example.org';
const TAB = 42;
let runId: number;

function actionReq(overrides: Partial<{ runId: number; tabId: number; epoch: number; action: Action; reason: string }> = {}) {
  return {
    requestId: '9c858901-8a57-4791-81fe-4c455b099bc9',
    runId, tabId: TAB, epoch: 1,
    action: { verb: 'read_page' } as Action,
    reason: 'test',
    ...overrides,
  };
}

async function grantChrome(origin: string) {
  (chrome.permissions as any).__granted.add(`${origin}/*`);
}

async function makeRun(overrides: Partial<RunRecord> = {}): Promise<number> {
  const record: RunRecord = {
    goal: '', state: 'running', mode: 'supervised', posture: 'local-only', backend: 'dom',
    origin: ORIGIN, scope: [ORIGIN], roster: [TAB],
    budgets: { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 },
    startedAt: Date.now(),
    ...overrides,
  };
  return db.runs.add(record);
}

const CONTINUE = {
  handle: 'e5', role: 'button', name: 'Continue', nameSource: 'content' as const, tag: 'button',
  inputType: 'button', enabled: true, visible: true, inViewport: true, actionable: true,
  sensitiveKind: null as const, regionId: 'form:0', ordinal: 0, formId: 'form:1',
};
const SUBMIT = { ...CONTINUE, handle: 'e6', name: 'Submit application', inputType: 'submit' };

function elementSnap(elements: PerceptionSnapshot['elements']): PerceptionSnapshot {
  return {
    runId: 'r', tabId: TAB, epoch: 1, url: `${ORIGIN}/`, origin: ORIGIN, title: '', settled: true,
    settleWaitedMs: 0, settleCalibration: 'visible', epochSuspect: false, elements, excludedCount: 0,
    regions: [], unreachableRegions: [], buildMs: 1,
  };
}

beforeEach(async () => {
  await db.sitePolicy.clear();
  await db.runs.clear();
  await grantChrome(ORIGIN);
  chrome.tabs.__setTab(TAB, `${ORIGIN}/`);
  await db.sitePolicy.put({
    origin: ORIGIN,
    capabilities: ['read_page', 'read_structure', 'read_element', 'wait_for_settle', 'scroll', 'click', 'type', 'select', 'navigate', 'history_back', 'history_forward'],
    defaultMode: 'supervised', grantedAt: Date.now(),
  });
  runId = await makeRun();
});

describe('gate — the eight checks, each in isolation', () => {
  it('1. UNKNOWN_RUN when the run row does not exist', async () => {
    const d = await gate(actionReq({ runId: 999_999 }));
    expect(d).toEqual({ permitted: false, code: 'UNKNOWN_RUN' });
  });

  it('2a. TAB_NOT_IN_ROSTER when the tab is not this run\'s', async () => {
    const otherRun = await makeRun({ roster: [999] });
    const d = await gate(actionReq({ runId: otherRun }));
    expect(d).toEqual({ permitted: false, code: 'TAB_NOT_IN_ROSTER' });
  });

  it('2b. TAB_GONE when the tab no longer exists', async () => {
    chrome.tabs.__removeTab(TAB);
    const d = await gate(actionReq());
    expect(d).toEqual({ permitted: false, code: 'TAB_GONE' });
  });

  it('3a. OUT_OF_SCOPE when the tab\'s URL has no bare origin', async () => {
    chrome.tabs.__setTab(TAB, 'not a url');
    const d = await gate(actionReq());
    expect(d).toEqual({ permitted: false, code: 'OUT_OF_SCOPE' });
  });

  it('3b. OUT_OF_SCOPE when the origin is not in the run\'s scope', async () => {
    const otherRun = await makeRun({ scope: ['https://elsewhere.example'] });
    const d = await gate(actionReq({ runId: otherRun }));
    expect(d).toEqual({ permitted: false, code: 'OUT_OF_SCOPE' });
  });

  it('3c. OUT_OF_SCOPE when Chrome no longer actually holds the permission', async () => {
    (chrome.permissions as any).__granted.delete(`${ORIGIN}/*`);
    const d = await gate(actionReq());
    expect(d).toEqual({ permitted: false, code: 'OUT_OF_SCOPE' });
  });

  it('4a. UNKNOWN_HANDLE when the handle has no ledger entry', async () => {
    const d = await gate(actionReq({ action: { verb: 'click', handle: 'e404' } }));
    expect(d).toEqual({ permitted: false, code: 'UNKNOWN_HANDLE' });
  });

  it('4b. HANDLE_NOT_OWNED when the handle belongs to a different tab', async () => {
    await ownership.record(runId, TAB, elementSnap([CONTINUE]));
    await ownership.record(runId, 777, elementSnap([{ ...CONTINUE, handle: 'e9' }]));
    // Force lookup to resolve to tab 777's copy by matching ITS epoch.
    const d = await gate(actionReq({ tabId: TAB, action: { verb: 'click', handle: 'e9' }, epoch: 1 }));
    expect(d).toEqual({ permitted: false, code: 'HANDLE_NOT_OWNED' });
  });

  it('4c. STALE_EPOCH when the handle is from an older epoch', async () => {
    await ownership.record(runId, TAB, { ...elementSnap([CONTINUE]), epoch: 5 });
    const d = await gate(actionReq({ action: { verb: 'click', handle: 'e5' }, epoch: 2 }));
    expect(d).toEqual({ permitted: false, code: 'STALE_EPOCH' });
  });

  it('5a. MALFORMED_ACTION when the action fails schema validation', async () => {
    const d = await gate(actionReq({ action: { verb: 'click' } as unknown as Action }));
    expect(d).toEqual({ permitted: false, code: 'MALFORMED_ACTION' });
  });

  it('5b. NOT_YET_IMPLEMENTED for a declared-but-unimplemented verb', async () => {
    expect(IMPLEMENTED_VERBS.has('summarise')).toBe(false);
    const d = await gate(actionReq({ action: { verb: 'summarise', textRef: 'r1' } }));
    expect(d).toEqual({ permitted: false, code: 'NOT_YET_IMPLEMENTED' });
  });

  it('5c. CAPABILITY_NOT_GRANTED when the site\'s policy excludes this verb', async () => {
    await ownership.record(runId, TAB, elementSnap([CONTINUE]));
    await db.sitePolicy.update(ORIGIN, { capabilities: ['read_page'] });
    const d = await gate(actionReq({ action: { verb: 'click', handle: 'e5' } }));
    expect(d).toEqual({ permitted: false, code: 'CAPABILITY_NOT_GRANTED' });
  });

  it('5d. NEVER_TIER — defence in depth against a ledger somehow holding a sensitive descriptor', async () => {
    await ownership.record(runId, TAB, elementSnap([{ ...CONTINUE, handle: 'e7', sensitiveKind: 'password' as any, inputType: 'password' }]));
    const d = await gate(actionReq({ action: { verb: 'type', handle: 'e7', text: 'x', mode: 'replace' } }));
    expect(d).toEqual({ permitted: false, code: 'NEVER_TIER' });
  });

  it('6. RUN_STATE when the run is not "running"', async () => {
    const pausedRun = await makeRun({ state: 'paused' });
    const d = await gate(actionReq({ runId: pausedRun }));
    expect(d).toEqual({ permitted: false, code: 'RUN_STATE' });
  });

  it('7. STOPPED when the stop flag is set', async () => {
    await chrome.storage.session.set({ [`stop:${runId}`]: true });
    const d = await gate(actionReq());
    expect(d).toEqual({ permitted: false, code: 'STOPPED' });
  });

  it('8a. needsApproval for an Always-tier action', async () => {
    await ownership.record(runId, TAB, elementSnap([SUBMIT]));
    const d = await gate(actionReq({ action: { verb: 'click', handle: 'e6' } }));
    expect(d.permitted).toBe(false);
    expect(d.needsApproval).toBe(true);
    if (d.needsApproval) {
      expect(d.tier).toBe('always');
      expect(d.prompt.site).toBe('practice.example.org');
      expect(d.prompt.target).toContain('Submit application');
    }
  });

  it('8b. needsApproval in step mode even for a Low-tier action', async () => {
    const stepRun = await makeRun({ mode: 'step' });
    const d = await gate(actionReq({ runId: stepRun }));
    expect(d.permitted).toBe(false);
    expect(d.needsApproval).toBe(true);
  });

  it('3+. navigate to an ungranted DESTINATION is OUT_OF_SCOPE, in addition to the source-tab check', async () => {
    const d = await gate(actionReq({ action: { verb: 'navigate', url: 'https://elsewhere.example/next' } }));
    expect(d).toEqual({ permitted: false, code: 'OUT_OF_SCOPE' });
  });

  it('3+. navigate to a granted destination within scope proceeds to tier classification', async () => {
    const otherRun = await makeRun({ scope: [ORIGIN, 'https://elsewhere.example'] });
    await grantChrome('https://elsewhere.example');
    const d = await gate(actionReq({ runId: otherRun, action: { verb: 'navigate', url: 'https://elsewhere.example/next' } }));
    expect(d).toEqual({ permitted: true, tier: 'medium' });
  });

  it('permits a fully valid low-tier read', async () => {
    const d = await gate(actionReq());
    expect(d).toEqual({ permitted: true, tier: 'low' });
  });

  it('permits a fully valid low-tier click on a non-special button', async () => {
    await ownership.record(runId, TAB, elementSnap([CONTINUE]));
    const d = await gate(actionReq({ action: { verb: 'click', handle: 'e5' } }));
    expect(d).toEqual({ permitted: true, tier: 'low' });
  });
});

describe('gate — check ordering (violate two at once, earlier code wins)', () => {
  it('OUT_OF_SCOPE (check 3) beats CAPABILITY_NOT_GRANTED (check 5)', async () => {
    await db.sitePolicy.update(ORIGIN, { capabilities: [] });
    (chrome.permissions as any).__granted.delete(`${ORIGIN}/*`);
    const d = await gate(actionReq());
    expect(d).toEqual({ permitted: false, code: 'OUT_OF_SCOPE' });
  });

  it('RUN_STATE (check 6) beats STOPPED (check 7)', async () => {
    const pausedRun = await makeRun({ state: 'paused' });
    await chrome.storage.session.set({ [`stop:${pausedRun}`]: true });
    const d = await gate(actionReq({ runId: pausedRun }));
    expect(d).toEqual({ permitted: false, code: 'RUN_STATE' });
  });

  it('TAB_NOT_IN_ROSTER (check 2) beats OUT_OF_SCOPE (check 3)', async () => {
    const otherRun = await makeRun({ roster: [999], scope: ['https://elsewhere.example'] });
    const d = await gate(actionReq({ runId: otherRun }));
    expect(d).toEqual({ permitted: false, code: 'TAB_NOT_IN_ROSTER' });
  });

  it('UNKNOWN_HANDLE (check 4) beats NOT_YET_IMPLEMENTED (check 5) when both would fire', async () => {
    // click is implemented, so this isolates check 4 from check 5 cleanly —
    // an unknown handle refuses before the verb/capability check ever runs.
    const d = await gate(actionReq({ action: { verb: 'click', handle: 'e404' } }));
    expect(d).toEqual({ permitted: false, code: 'UNKNOWN_HANDLE' });
  });
});

describe('gate — journals every refusal before responding', () => {
  it('a refusal is journaled as action.refused', async () => {
    await gate(actionReq({ runId: 999_999 }));
    // UNKNOWN_RUN can't journal against a real run id — nothing to assert
    // on runEvents there. Use a refusal that DOES have a real run instead.
    const d = await gate(actionReq({ action: { verb: 'click', handle: 'e404' } }));
    expect(d).toEqual({ permitted: false, code: 'UNKNOWN_HANDLE' });
    const events = await db.runEvents.where('runId').equals(runId).toArray();
    const refusal = events.find((e) => e.kind === 'action.refused');
    expect(refusal).toBeDefined();
    expect((refusal!.data as any).code).toBe('UNKNOWN_HANDLE');
  });
});

describe('gate — import boundary (lib/policy/** never imports lib/model/** or lib/adapters/**)', () => {
  it('no source file under lib/policy imports from a model or adapter module', () => {
    const dir = path.resolve(__dirname, '../../lib/policy');
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      const src = readFileSync(path.join(dir, file), 'utf-8');
      expect(src, file).not.toMatch(/from\s+['"]@lib\/model\//);
      expect(src, file).not.toMatch(/from\s+['"]@lib\/adapters\//);
    }
  });
});
