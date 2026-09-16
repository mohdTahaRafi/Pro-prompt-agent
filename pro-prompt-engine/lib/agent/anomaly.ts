/**
 * Anomaly detection — the seventh re-planning trigger, given real detectors.
 * Docs/planning/phase_6_recovery_journal_reporting.md §4.
 *
 * Pure, synchronous, no I/O — lib/agent/supervisor.ts is the only caller
 * and owns the run-level state (region-total history, the unconfirmed
 * streak, the plan's origin) these functions are handed as plain arguments.
 * anomaly.spec.ts drives every function directly, with no run at all.
 *
 * lib/agent/replan.ts's own detectFieldCountAnomaly (Phase 5 §4.3) already
 * covers ONE region against a fixed corpus-baseline constant. This module
 * covers the same 60%-below-median shape but against totals actually
 * observed DURING the run (no live corpus query — there isn't one, §4),
 * which is what lets J-2's collapsed-specification-table scenario be
 * "noticed", not "told": the agent has no external baseline for THIS page,
 * only its own prior reads of it.
 */

/** §4 row 1 — low field count. `median <= 0` (no prior observation of this
 *  region signature yet, or every prior total was zero) never trips: there
 *  is nothing to compare against. Same 60%-below-median shape as
 *  lib/agent/replan.ts's detectFieldCountAnomaly, applied to a live median
 *  instead of a fixed constant. */
export function isLowFieldCount(observedTotal: number, median: number): boolean {
  if (median <= 0) return false;
  return observedTotal < median * 0.4;
}

/** The median of a region's `total` across every PRIOR snapshot in this run
 *  that reported the same regionId. `history` is every observed total for
 *  that region, oldest first — the CURRENT snapshot's own total is never
 *  included (a region cannot be anomalous relative to itself). */
export function medianOf(history: number[]): number {
  if (history.length === 0) return 0;
  const sorted = [...history].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** §4 row 1, second clause — a form's extracted-value count far below its
 *  own field count (the step asked for N fields and a read produced far
 *  fewer values than the region it read claims to have). Same threshold as
 *  isLowFieldCount, applied to (extracted, expected) rather than
 *  (observed-this-run, historical-median) — a form does not need history to
 *  know how many of ITS OWN fields it has. */
export function isFieldShortfall(extractedCount: number, fieldCount: number): boolean {
  if (fieldCount <= 0) return false;
  return extractedCount < fieldCount * 0.4;
}

export type CollapseVerdict = 'replan' | 'end' | null;

/** §4 row 2 — verification-rate collapse. `streak` is the count of
 *  CONSECUTIVE 'unconfirmed' verdicts, reset to 0 by any 'confirmed' or
 *  'failed' verdict and — deliberately — NOT reset by a replan, so "the
 *  next two [after the replan] also come back unconfirmed" (§4) is six
 *  total, not two after a fresh count. Fires 'replan' exactly once, at 4;
 *  'end' from 6 onward (a monotonically increasing streak hits both
 *  exactly once each, in order, so the caller never needs its own
 *  already-fired bookkeeping). */
export function verificationCollapse(streak: number): CollapseVerdict {
  if (streak >= 6) return 'end';
  if (streak === 4) return 'replan';
  return null;
}

/** §4 row 3 — unexpected origin. The plan was built against `expectedOrigin`;
 *  the current snapshot reports `currentOrigin`. An origin still within the
 *  run's granted `scope` but different from what the plan expected is a
 *  replan signal (the page navigated somewhere the plan didn't predict) —
 *  the caller additionally routes this to lib/policy/suspicion.ts, since
 *  origin drift is also one of that module's four signals. An origin
 *  OUTSIDE scope is not this detector's job at all: the gate refuses
 *  OUT_OF_SCOPE before any action there is even attempted. */
export function isUnexpectedOrigin(currentOrigin: string, expectedOrigin: string, scope: string[]): boolean {
  return currentOrigin !== expectedOrigin && scope.includes(currentOrigin);
}
