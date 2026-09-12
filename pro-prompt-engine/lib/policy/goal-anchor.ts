/**
 * Goal anchor — gate check 5.5. Docs/planning/phase_5_agent_loop.md §6.
 * Fills the stub left by Phase 3 (Docs/planning/phase_3_gate_actuation_verification.md §17).
 *
 * PR-SEC-12 / PR-PLAN-6: an action inconsistent with the run's approved plan
 * is refused as OFF_GOAL. The anchor is the approved plan, not a semantic
 * judgement of the goal text — checkable without a model, which is why this
 * file makes zero model calls and imports nothing from lib/model/** or
 * lib/adapters/** (enforced by tests/unit/gate.spec.ts's import-boundary
 * assertion, same as every other file under lib/policy/**).
 *
 * What this does not catch: a page that steers the *planner* into producing
 * a plausible-looking but wrong plan. The user sees that plan before it
 * runs, which is the defence, and lib/policy/suspicion.ts (Phase 6) is the
 * layer aimed at it.
 */
import { Ok, Err, type Result } from '@lib/utils/result';
import * as journal from '@lib/agent/journal';
import type { Action } from '@lib/schemas/action.schema';
import type { PlanStep } from '@lib/schemas/plan.schema';
import type { RunRecord } from '@lib/types/run.types';
import type { LedgerDescriptor } from '@lib/types/agent.types';

/** Perception changes nothing on the page — these verbs can never be
 *  off-goal, whatever the plan says. A local, single-purpose copy rather
 *  than an import of lib/policy/gate.ts's IMPLEMENTED_VERBS: that set is
 *  "what the gate will run this phase", a different axis from "what can
 *  never be off-goal" (a verb could be implemented and mutating, or — from
 *  a later phase — implemented and still non-mutating). */
const PERCEPTION_VERBS = new Set<Action['verb']>([
  'read_page', 'read_structure', 'read_element', 'wait_for_settle',
]);

/** The two control verbs (Phase 5 §10) act on the run itself, not the page —
 *  ask_user and finish are never a page mutation a plan step could have
 *  predicted in advance, so they are never off-goal either. */
const CONTROL_VERBS = new Set<Action['verb']>(['ask_user', 'finish']);

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** "Same shape" as a plan step: same verb, and — for a handle-bearing verb —
 *  the SAME TARGET, matched by (role, name) against the step's targetHint,
 *  never by raw handle string. Handles are per-epoch (lib/page/registry.ts's
 *  beginEpoch() resets its counter every structure read) and
 *  lib/agent/step-resolver.ts deliberately retargets a step's handle to
 *  whatever the current epoch re-resolved it to — comparing handles here
 *  would false-negative on every single retarget, which is the normal case,
 *  not the exception. `target` is the SAME LedgerDescriptor the gate already
 *  computed at check 5 for tier classification (lib/policy/gate.ts), passed
 *  in rather than re-derived. */
function sameShape(step: PlanStep, action: Action, target: LedgerDescriptor | null): boolean {
  if (step.action.verb !== action.verb) return false;
  if (!step.targetHint) {
    // No target on this step at all (a navigate/history verb, or a step the
    // planner produced with no handle) — verb equality is the whole check.
    return true;
  }
  if (!target) return false;   // step named a target; this action has none — not a match
  return target.role === step.targetHint.role && normalize(target.name) === normalize(step.targetHint.name);
}

/**
 * Has this run replanned at least once? A journaled `plan.replanned` event
 * is written only by this run's own Supervisor (lib/agent/supervisor.ts),
 * itself gated behind a real planner call that burns budget and is capped
 * at maxPlannerCalls (lib/agent/budget.ts) — a page cannot forge one. Scoped
 * to "at any point in this run" rather than to a precise step range: once a
 * replan has happened the plan on the run row (`run.plan`) has already been
 * replaced with the newly-derived steps, so the structural check above is
 * what actually validates a POST-replan action; this function exists as the
 * defence for the race window between the replan being journaled and
 * `run.plan` being persisted, not as the primary check. A decided scoping,
 * not a punt: narrowing it to "since step N" would need extra state
 * (a last-replan step index) that buys no real security property here.
 */
async function journalHasReplanSince(runId: number): Promise<boolean> {
  const events = await journal.query(runId, 'plan.replanned');
  return events.length > 0;
}

export async function anchorCheck(
  run: RunRecord, action: Action, target: LedgerDescriptor | null,
): Promise<Result<void, 'OFF_GOAL'>> {
  // Verbs that can never be off-goal: perception and run-control both.
  if (PERCEPTION_VERBS.has(action.verb) || CONTROL_VERBS.has(action.verb)) return Ok(undefined);

  // The approved plan is the anchor. A permitted action must correspond to
  // a step the user saw and approved, OR to a re-planned step produced by
  // a trigger the journal records.
  const planned = (run.plan?.steps ?? []).some((s) => sameShape(s, action, target));
  if (planned) return Ok(undefined);

  if (await journalHasReplanSince(run.id!)) return Ok(undefined);

  return Err('OFF_GOAL');
}
