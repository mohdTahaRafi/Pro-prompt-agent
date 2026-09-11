/**
 * Journal — the only writer of `runEvents`. Docs/planning/phase_3_gate_actuation_verification.md §8.
 *
 * Every gate decision, dispatch, verification and approval step is recorded
 * here, in order, before the caller moves on. A refusal that is not
 * recorded is a refusal the report cannot explain (§4.3).
 *
 * `data` is typed `unknown` at the storage layer (lib/types/run.types.ts) —
 * a full per-kind Zod schema for every RunEventKind's payload is future
 * work; Phase 3's callers are the only writers (enforced by this being the
 * sole export that touches db.runEvents) and are trusted to shape their own
 * payloads correctly, which the compiler already checks via each call site's
 * literal object type.
 */
import { db } from '@lib/db/dexie-db';
import type { RunEvent, RunEventKind } from '@lib/types/run.types';

// Per-run sequence cache: the common case is one `add`, not a count-then-add.
// Cleared implicitly on service-worker restart — the first append after a
// cold wake falls back to counting existing rows, which is correct (just
// slower) rather than restarting the sequence at 1 and colliding.
const seqCache = new Map<number, number>();

export async function append(
  runId: number, kind: RunEventKind, tabId: number | null, data: unknown,
): Promise<void> {
  await db.transaction('rw', db.runEvents, async () => {
    const seq = (seqCache.get(runId)
      ?? (await db.runEvents.where('runId').equals(runId).count())) + 1;
    seqCache.set(runId, seq);
    await db.runEvents.add({ runId, seq, kind, at: Date.now(), tabId, data });
  });
}

/** Every event for a run, in seq order; optionally narrowed to one kind.
 *  Used by lib/policy/tiers.ts's hasUnsavedUserInput (§5.3) and by the
 *  options-page run detail view (§11). */
export async function query(runId: number, kind?: RunEventKind): Promise<RunEvent[]> {
  const rows = await db.runEvents.where('runId').equals(runId).sortBy('seq');
  return kind ? rows.filter((e) => e.kind === kind) : rows;
}

/** Test-only: drops the in-memory seq cache so a fresh count is taken next
 *  append — mirrors what actually happens on a service-worker restart. */
export function __resetSeqCache(): void {
  seqCache.clear();
}
