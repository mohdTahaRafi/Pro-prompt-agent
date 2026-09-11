/**
 * Goal anchor — stub. Docs/planning/phase_3_gate_actuation_verification.md §17.
 *
 * [Phase 5] fills this in: a check that an action still serves the run's
 * goal, slotted into lib/policy/gate.ts at check 5.5 (reserved, between the
 * tier check and the run-state check). It needs a goal, which needs a
 * plan — neither exists until Phase 5's planner. Created now, as a stub
 * returning 'allow' unconditionally, so the gate's file tree and its
 * reserved check position exist from this phase's first commit rather than
 * arriving as a mid-pipeline insertion later.
 */

/** [Phase 5: replaced by the real goal-anchor check] */
export async function checkGoalAnchor(): Promise<'allow'> {
  return 'allow';
}
