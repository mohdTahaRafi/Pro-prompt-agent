/**
 * lib/policy/goal-anchor.ts — gate check 5.5.
 * Docs/planning/phase_5_agent_loop.md §6, §11 task 5.7.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { anchorCheck } from '@lib/policy/goal-anchor';
import * as journal from '@lib/agent/journal';
import { db } from '@lib/db/dexie-db';
import type { RunRecord } from '@lib/types/run.types';
import type { LedgerDescriptor } from '@lib/types/agent.types';

const ORIGIN = 'https://practice.example.org';

async function makeRun(overrides: Partial<RunRecord> = {}): Promise<RunRecord & { id: number }> {
  await db.runs.clear();
  const record: RunRecord = {
    goal: 'fill the form', state: 'running', mode: 'supervised', posture: 'local-only', backend: 'dom',
    origin: ORIGIN, scope: [ORIGIN], roster: [1],
    budgets: { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 },
    startedAt: Date.now(),
    plan: { restatement: 'x', willNotDo: [], steps: [
      { n: 1, intent: 'fill name', action: { verb: 'type', handle: 'e5', text: 'x', mode: 'replace' }, expectation: 'x', targetHint: { role: 'textbox', name: 'Full name' } },
    ] },
    ...overrides,
  };
  const id = await db.runs.add(record);
  return { ...record, id };
}

const NAME_FIELD: LedgerDescriptor = {
  role: 'textbox', name: 'Full name', inputType: 'text', ordinal: 0, actionable: true, sensitiveKind: null,
};
const EMAIL_FIELD: LedgerDescriptor = {
  role: 'textbox', name: 'Email', inputType: 'email', ordinal: 1, actionable: true, sensitiveKind: null,
};

describe('anchorCheck', () => {
  it('permits an action matching an approved plan step (verb + target role/name)', async () => {
    const run = await makeRun();
    const r = await anchorCheck(run, { verb: 'type', handle: 'e5', text: 'x', mode: 'replace' }, NAME_FIELD);
    expect(r.ok).toBe(true);
  });

  it('matches by role/name, never by raw handle — a re-resolved handle in a new epoch still matches', async () => {
    const run = await makeRun();
    // A different handle string (e.g. re-resolved after a page re-render)
    // but the SAME role/name the plan step names.
    const r = await anchorCheck(run, { verb: 'type', handle: 'e99', text: 'x', mode: 'replace' }, NAME_FIELD);
    expect(r.ok).toBe(true);
  });

  it('refuses OFF_GOAL for an unplanned mutating action', async () => {
    const run = await makeRun();
    const r = await anchorCheck(run, { verb: 'type', handle: 'e6', text: 'x', mode: 'replace' }, EMAIL_FIELD);
    expect(r).toEqual({ ok: false, error: 'OFF_GOAL' });
  });

  it('refuses OFF_GOAL when the verb differs even if the target matches', async () => {
    const run = await makeRun();
    const r = await anchorCheck(run, { verb: 'click', handle: 'e5' }, NAME_FIELD);
    expect(r).toEqual({ ok: false, error: 'OFF_GOAL' });
  });

  it('a perception verb always passes, whatever the plan says', async () => {
    const run = await makeRun({ plan: { restatement: 'x', willNotDo: [], steps: [] } });
    for (const action of [
      { verb: 'read_page' as const }, { verb: 'read_structure' as const },
      { verb: 'read_element' as const, handle: 'e1' }, { verb: 'wait_for_settle' as const },
    ]) {
      expect((await anchorCheck(run, action, null)).ok).toBe(true);
    }
  });

  it('ask_user and finish always pass — they act on the run, never the page', async () => {
    const run = await makeRun({ plan: { restatement: 'x', willNotDo: [], steps: [] } });
    expect((await anchorCheck(run, { verb: 'ask_user', question: 'q?', reason: 'AMBIGUOUS_TARGET' }, null)).ok).toBe(true);
    expect((await anchorCheck(run, { verb: 'finish', outcome: 'completed', summary: 's' }, null)).ok).toBe(true);
  });

  it('an unplanned action passes once a plan.replanned event is journaled for this run', async () => {
    const run = await makeRun({ plan: { restatement: 'x', willNotDo: [], steps: [] } });
    const before = await anchorCheck(run, { verb: 'click', handle: 'e7' }, EMAIL_FIELD);
    expect(before.ok).toBe(false);
    await journal.append(run.id, 'plan.replanned', null, { trigger: 'unexpected_change', fromStepIndex: 0 });
    const after = await anchorCheck(run, { verb: 'click', handle: 'e7' }, EMAIL_FIELD);
    expect(after.ok).toBe(true);
  });

  it('makes zero model calls — no import from lib/model/** or lib/adapters/** anywhere under lib/policy/**', () => {
    const policyDir = path.resolve(__dirname, '../../lib/policy');
    for (const file of readdirSync(policyDir)) {
      if (!file.endsWith('.ts')) continue;
      const src = readFileSync(path.join(policyDir, file), 'utf-8');
      expect(src, file).not.toMatch(/from ['"]@lib\/(model|adapters)\//);
    }
  });
});
