/**
 * The approval prompt — lib/policy/gate.ts §9.
 * Docs/planning/phase_3_gate_actuation_verification.md §12 task 3.12.
 *
 * The requestId-keyed replay protection ("an approval token for request A
 * is refused for request B") lives in entrypoints/background.ts's pending-
 * approval map, which — like every WXT entrypoint using `defineBackground`
 * — only runs inside the built extension, not under plain Vitest; it is
 * exercised by tests/e2e/*.spec.ts against the real extension instead. This
 * file covers everything about the prompt itself that IS reachable through
 * lib/policy/gate.ts directly: every generated prompt names its target and
 * the hostname, and no prompt string in the repository is generic.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gate } from '@lib/policy/gate';
import * as ownership from '@lib/policy/ownership';
import { db } from '@lib/db/dexie-db';
import type { RunRecord } from '@lib/types/run.types';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import type { Action } from '@lib/schemas/action.schema';
import type { ApprovalPrompt } from '@lib/types/agent.types';

const ORIGIN = 'https://practice.example.org';
const TAB = 42;

function elementSnap(elements: PerceptionSnapshot['elements']): PerceptionSnapshot {
  return {
    runId: 'r', tabId: TAB, epoch: 1, url: `${ORIGIN}/apply`, origin: ORIGIN, title: '', settled: true,
    settleWaitedMs: 0, settleCalibration: 'visible', epochSuspect: false, elements, excludedCount: 0,
    regions: [], unreachableRegions: [], buildMs: 1,
  };
}

const ELSEWHERE = 'https://elsewhere.example';

async function setup(mode: RunRecord['mode'] = 'supervised'): Promise<number> {
  await db.sitePolicy.clear();
  await db.runs.clear();
  (chrome.permissions as any).__granted.add(`${ORIGIN}/*`);
  // Also granted so a navigate-verb approval-prompt test can name a
  // real destination without tripping gate.ts's destination-scope check
  // (§6.3 "Navigating") — a concern orthogonal to what this file tests.
  (chrome.permissions as any).__granted.add(`${ELSEWHERE}/*`);
  chrome.tabs.__setTab(TAB, `${ORIGIN}/apply`);
  await db.sitePolicy.put({
    origin: ORIGIN,
    capabilities: ['click', 'type', 'select', 'navigate', 'history_back', 'history_forward', 'read_page'],
    defaultMode: 'supervised', grantedAt: Date.now(),
  });
  const record: RunRecord = {
    goal: '', state: 'running', mode, posture: 'local-only', backend: 'dom',
    origin: ORIGIN, scope: [ORIGIN, ELSEWHERE], roster: [TAB],
    budgets: { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 },
    startedAt: Date.now(),
  };
  return db.runs.add(record);
}

async function approvalFor(runId: number, action: Action): Promise<ApprovalPrompt> {
  const d = await gate({
    requestId: '9c858901-8a57-4791-81fe-4c455b099bc9', runId, tabId: TAB, epoch: 1, action, reason: 't',
  });
  expect(d.needsApproval, JSON.stringify(d)).toBe(true);
  if (!d.needsApproval) throw new Error('unreachable');
  return d.prompt;
}

const SUBMIT_BTN = {
  handle: 'e1', role: 'button', name: 'Submit application', nameSource: 'content' as const, tag: 'button',
  inputType: 'submit', enabled: true, visible: true, inViewport: true, actionable: true,
  sensitiveKind: null as const, regionId: 'form:0', ordinal: 0, formId: 'form:apply',
};

describe('approval prompt — every generated prompt names its target and the hostname', () => {
  beforeEach(async () => { await ownership.clear(1); });

  it('a submit-like click names the button and the site', async () => {
    const runId = await setup();
    await ownership.record(runId, TAB, elementSnap([SUBMIT_BTN]));
    const prompt = await approvalFor(runId, { verb: 'click', handle: 'e1' });
    expect(prompt.target).toBe('Submit application');
    expect(prompt.site).toBe('practice.example.org');
    expect(prompt.action).toContain('Submit application');
    expect(prompt.consequence).toMatch(/submit/i);
    expect(prompt.tier).toBe('always');
  });

  it('a navigate prompt (step mode) names the destination and the current site', async () => {
    const runId = await setup('step');
    const prompt = await approvalFor(runId, { verb: 'navigate', url: 'https://elsewhere.example/next' });
    expect(prompt.target).toBe('elsewhere.example');
    expect(prompt.site).toBe('practice.example.org');
    expect(prompt.action).toContain('elsewhere.example');
  });

  it('a type-into-field prompt on a sensitive origin names the field and the site', async () => {
    const GOV = 'https://www.gov.uk';
    await db.sitePolicy.clear();
    await db.runs.clear();
    (chrome.permissions as any).__granted.add(`${GOV}/*`);
    chrome.tabs.__setTab(TAB, `${GOV}/form`);
    await db.sitePolicy.put({ origin: GOV, capabilities: ['type'], defaultMode: 'supervised', grantedAt: Date.now() });
    const runId = await db.runs.add({
      goal: '', state: 'running', mode: 'supervised', posture: 'local-only', backend: 'dom',
      origin: GOV, scope: [GOV], roster: [TAB],
      budgets: { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 },
      startedAt: Date.now(),
    });
    await ownership.record(runId, TAB, {
      ...elementSnap([{ ...SUBMIT_BTN, handle: 'e2', role: 'textbox', name: 'Full name', inputType: 'text' }]),
      origin: GOV, url: `${GOV}/form`,
    });
    const prompt = await approvalFor(runId, { verb: 'type', handle: 'e2', text: 'Mohd Taha', mode: 'replace' });
    expect(prompt.target).toBe('Full name');
    expect(prompt.site).toBe('www.gov.uk');
  });

  it('every reachable consequence string is specific, never the generic "Do you want to allow this action?"', async () => {
    const runId = await setup('step');   // step mode: even the low-tier navigate below needs approval
    await ownership.record(runId, TAB, elementSnap([SUBMIT_BTN, { ...SUBMIT_BTN, handle: 'e3', name: 'Delete account', inputType: 'button' }]));
    const prompts = await Promise.all([
      approvalFor(runId, { verb: 'click', handle: 'e1' }),
      approvalFor(runId, { verb: 'click', handle: 'e3' }),
      approvalFor(runId, { verb: 'navigate', url: 'https://elsewhere.example' }),
    ]);
    for (const p of prompts) {
      expect(p.consequence).not.toBe('Do you want to allow this action?');
      expect(p.consequence.length).toBeGreaterThan(15);
    }
    // At least two DIFFERENT consequence sentences across these three
    // distinct actions — proof it is not one canned string.
    expect(new Set(prompts.map((p) => p.consequence)).size).toBeGreaterThan(1);
  });
});

describe('no generic approval string anywhere in the repository', () => {
  it('lib/policy/gate.ts never contains "Do you want to allow this action?"', () => {
    const src = readFileSync(path.resolve(__dirname, '../../lib/policy/gate.ts'), 'utf-8');
    expect(src).not.toContain('Do you want to allow this action?');
  });
});
