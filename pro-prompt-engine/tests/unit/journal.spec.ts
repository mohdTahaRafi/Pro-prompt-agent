/**
 * lib/agent/journal.ts — the only writer of runEvents.
 * Docs/planning/phase_3_gate_actuation_verification.md §12 task 3.11.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { append, query, __resetSeqCache } from '@lib/agent/journal';
import { db } from '@lib/db/dexie-db';

beforeEach(async () => {
  await db.runEvents.clear();
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
