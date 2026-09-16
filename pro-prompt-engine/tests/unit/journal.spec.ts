/**
 * lib/agent/journal.ts — the only writer of runEvents.
 * Docs/planning/phase_3_gate_actuation_verification.md §12 task 3.11.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { append, query, __resetSeqCache } from '@lib/agent/journal';
import { buildReport, summaryTextFor } from '@lib/agent/reporter';
import { db } from '@lib/db/dexie-db';
import type { RunRecord } from '@lib/types/run.types';
import type { Plan } from '@lib/schemas/plan.schema';

beforeEach(async () => {
  await db.runEvents.clear();
  await db.runs.clear();
  __resetSeqCache();
});

describe('journal.append', () => {
  it('assigns gapless, monotonic seq numbers under 100 concurrent appends', async () => {
    const runId = 1;
    await Promise.all(Array.from({ length: 100 }, (_, i) =>
      append(runId, 'action.requested', null, { i })));

    const rows = await db.runEvents.where('runId').equals(runId).sortBy('seq');
    expect(rows).toHaveLength(100);
    const seqs = rows.map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  });

  it('keeps separate runs\' sequences independent', async () => {
    await append(1, 'run.created', null, {});
    await append(2, 'run.created', null, {});
    await append(1, 'action.requested', null, {});
    const run1 = await query(1);
    const run2 = await query(2);
    expect(run1.map((e) => e.seq)).toEqual([1, 2]);
    expect(run2.map((e) => e.seq)).toEqual([1]);
  });

  it('a write takes at most 10ms at the p95 (100 sequential writes)', async () => {
    const times: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      // eslint-disable-next-line no-await-in-loop
      await append(3, 'action.dispatched', 1, { i });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    expect(p95).toBeLessThanOrEqual(10);
  });

  it('falls back to counting existing rows when the seq cache is cold (simulated SW restart)', async () => {
    await append(4, 'run.created', null, {});
    await append(4, 'action.requested', null, {});
    __resetSeqCache();   // simulate a fresh service-worker wake
    await append(4, 'action.permitted', null, {});
    const rows = await query(4);
    expect(rows.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});

describe('journal.query', () => {
  it('filters by kind when given, and returns everything otherwise', async () => {
    await append(5, 'run.created', null, {});
    await append(5, 'action.requested', null, {});
    await append(5, 'action.refused', null, { code: 'OUT_OF_SCOPE' });
    expect(await query(5)).toHaveLength(3);
    expect(await query(5, 'action.refused')).toHaveLength(1);
    expect(await query(5, 'action.dispatched')).toHaveLength(0);
  });
});

// ── [Phase 6, task 6.10] lib/agent/reporter.ts's buildReport() — the
//    journal-only report. Docs/planning/phase_6_recovery_journal_reporting.md
//    §6. ──

const PLAN_6_FIELDS: Plan = {
  restatement: 'fill the six-field form', willNotDo: [],
  steps: Array.from({ length: 6 }, (_, i) => ({
    n: i + 1, intent: `fill field ${i + 1}`,
    action: { verb: 'type' as const, handle: `e${i}`, text: `value ${i + 1}`, mode: 'replace' as const },
    expectation: 'the field shows the value',
  })),
};

async function makeRun(plan?: Plan): Promise<number> {
  const record: RunRecord = {
    goal: 'fill the form', state: 'completed', mode: 'supervised', posture: 'local-only', backend: 'dom',
    origin: 'https://forms.example', scope: ['https://forms.example'], roster: [1],
    budgets: { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 },
    startedAt: Date.now(), endedAt: Date.now(), outcome: 'completed_with_gaps', plan,
  };
  return db.runs.add(record);
}

describe('reporter.buildReport — journal-only (§6.1)', () => {
  it('a plan that claims 6 filled fields but only 4 action.observed rows exist reports 4 confirmed', async () => {
    const runId = await makeRun(PLAN_6_FIELDS);
    for (let i = 0; i < 4; i++) {
      await append(runId, 'action.observed', 1, {
        verb: 'type', handle: `e${i}`, tier: 'low', stepN: i + 1,
        verified: 'confirmed', check: 'state', evidence: { after: `value ${i + 1}` }, url: 'https://forms.example/',
      });
    }
    await append(runId, 'run.completed', 1, { outcome: 'completed_with_gaps', summary: 'planner said 6, only 4 happened' });

    const report = await buildReport(runId);
    expect(report.counts.confirmed).toBe(4);
    expect(report.steps.filter((s) => s.verdict === 'confirmed')).toHaveLength(4);
    // Steps 5 and 6 were never attempted — the journal has no evidence for
    // them, so the report cannot say they succeeded, whatever the plan
    // (the planner's own claim of "6 fields filled") says.
    expect(report.steps.filter((s) => s.verdict === 'not_attempted')).toHaveLength(2);
    expect(report.gaps.filter((g) => g.kind === 'not_found')).toHaveLength(2);
  });

  it('deleting run.plan changes only step labels — every verdict, gap and count is unchanged', async () => {
    const runId = await makeRun(PLAN_6_FIELDS);
    for (let i = 0; i < 4; i++) {
      await append(runId, 'action.observed', 1, {
        verb: 'type', handle: `e${i}`, tier: 'low', stepN: i + 1,
        verified: 'confirmed', check: 'state', evidence: { after: `value ${i + 1}` }, url: 'https://forms.example/',
      });
    }
    await append(runId, 'run.completed', 1, { outcome: 'completed_with_gaps', summary: 'x' });

    const withPlan = await buildReport(runId);
    await db.runs.update(runId, { plan: undefined });
    const withoutPlan = await buildReport(runId);

    expect(withoutPlan.counts).toEqual(withPlan.counts);
    expect(withoutPlan.outcome).toEqual(withPlan.outcome);
    expect(withoutPlan.disclosure).toEqual(withPlan.disclosure);
    // Labels are the ONLY thing plan removal is allowed to change — with no
    // plan, deriveSteps() has no labels to attach events to at all.
    expect(withoutPlan.steps).toEqual([]);
    expect(withPlan.steps.every((s) => typeof s.intent === 'string' && s.intent.length > 0)).toBe(true);
  });

  it('a value the journal cannot trace to a read is dropped from the report, not shown or guessed', async () => {
    // [J-2] a collapsed spec table: the walk reports 6 of 24 rows shown.
    const runId = await makeRun({ restatement: 'read specs', willNotDo: [], steps: [
      { n: 1, intent: 'read the spec table', action: { verb: 'read_structure' as const, region: 'specs' }, expectation: 'the specs are listed' },
    ] });
    await append(runId, 'action.observed', 1, {
      verb: 'read_structure', tier: 'low', stepN: 1, verified: 'confirmed', check: 'state',
      read: { elements: [{ role: 'text', name: 'Screen size', valueShape: '27 inches' }], regions: [{ regionId: 'specs', label: 'Specifications', shown: 6, total: 24 }] },
      url: 'https://forms.example/specs',
    });
    await append(runId, 'run.completed', 1, { outcome: 'completed_with_gaps', summary: '6 of 24' });

    const report = await buildReport(runId);
    const gap = report.gaps.find((g) => g.kind === 'not_found' && g.what.includes('Specifications'));
    expect(gap).toBeTruthy();
    expect(gap?.what).toContain('18 of 24');   // 24 - 6 missing
  });

  it('summaryTextFor never echoes a planner-supplied summary verbatim — it is built from the report alone', async () => {
    const runId = await makeRun(PLAN_6_FIELDS);
    await append(runId, 'action.observed', 1, { verb: 'type', handle: 'e0', tier: 'low', stepN: 1, verified: 'confirmed', check: 'state', url: 'x' });
    await append(runId, 'run.completed', 1, { outcome: 'completed_with_gaps', summary: 'A PLANNER LIE THAT SHOULD NEVER APPEAR' });
    const report = await buildReport(runId);
    const text = summaryTextFor(report);
    expect(text).not.toContain('PLANNER LIE');
  });
});

describe('reporter.ts imports nothing from planner.ts (§6.1)', () => {
  it('no import statement in lib/agent/reporter.ts names lib/agent/planner', () => {
    const src = readFileSync(path.resolve(__dirname, '../../lib/agent/reporter.ts'), 'utf-8');
    expect(/from ['"].*planner/.test(src)).toBe(false);
  });
});

describe('journal — the only writer of runEvents', () => {
  it('no other lib/** source file writes to db.runEvents directly', () => {
    const libDir = path.resolve(__dirname, '../../lib');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        if (full === path.resolve(__dirname, '../../lib/agent/journal.ts')) continue;
        const src = readFileSync(full, 'utf-8');
        if (/db\.runEvents\.(add|put|update|bulkAdd)/.test(src)) offenders.push(full);
      }
    };
    walk(libDir);
    expect(offenders).toEqual([]);
  });
});
