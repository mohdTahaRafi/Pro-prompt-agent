/**
 * Suspicion halts — stub. Docs/planning/phase_3_gate_actuation_verification.md §17.
 *
 * [Phase 6] fills this in: a check that halts a run showing signs of
 * having gone off the rails (repeated failures, a goal drift pattern,
 * prompt-injection indicators from the page). It needs a recovery loop to
 * halt INTO, which is Phase 6. Created now, as a stub returning 'allow'
 * unconditionally, so the file exists from this phase's first commit.
 */

/** [Phase 6: replaced by the real suspicion-halt check] */
export async function checkSuspicion(): Promise<'allow'> {
  return 'allow';
}
