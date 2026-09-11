/**
 * Planner — goal → Plan. §8.3.
 * Docs/planning/phase_4_model_tiers_routing.md §8.3.
 *
 * Produces a plan. Does NOT execute one — Phase 5 does (§1). Pure with
 * respect to the run row: this module never touches lib/db/dexie-db.ts or
 * lib/agent/journal.ts directly; entrypoints/background.ts's orchestration
 * layer (mirroring how it already wraps lib/policy/gate.ts) creates the run
 * row, journals `run.created`/`plan.produced`, and passes this function
 * only the `runId` an in-flight inference call should journal fallbacks and
 * remote calls against (lib/model/router-types.ts's RouteRequest.runId).
 */
import { Ok, Err, type Result } from '@lib/utils/result';
import { probePosture, type Posture } from '@lib/model/posture';
import { inferStructured } from '@lib/model/router';
import type { RouteError } from '@lib/model/router-types';
import { PLANNER_SYSTEM, renderPlannerUser, generateNonce, type PlannerPolicy } from '@lib/agent/prompts';
import { PlanSchema, type Plan } from '@lib/schemas/plan.schema';
import { handleOf } from '@lib/schemas/action.schema';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';

export interface PlanInput {
  goal: string;
  postureChoice: Posture;
  snapshot: PerceptionSnapshot;
  policy: PlannerPolicy;
  runId?: number;
  signal?: AbortSignal;
}

/** Distinct from RouteError: the doc's §8.3 sketch returns `NO_PLANNER` with
 *  a `reason` string — a refusal shaped for direct display (§8.3's "the
 *  refusal path is the product decision"), not one of route()'s engine
 *  failure codes. Both are carried in the same Result so callers have one
 *  place to switch on. */
export type PlanError = { code: 'NO_PLANNER'; reason: string } | { code: RouteError };

export async function plan(input: PlanInput): Promise<Result<Plan, PlanError>> {
  const posture = await probePosture(input.postureChoice);
  if (!posture.planner.available) {
    return Err({ code: 'NO_PLANNER', reason: posture.planner.reason ?? "The planner isn't available." });
  }

  const nonce = generateNonce();
  const user = renderPlannerUser({ goal: input.goal, policy: input.policy, snapshot: input.snapshot }, nonce);

  const result = await inferStructured({
    tier: 'planner', posture: posture.posture, system: PLANNER_SYSTEM, user,
    disclosureClass: 'A', maxTokens: 2_000, temperature: 0.2,
    signal: input.signal, runId: input.runId,
  }, PlanSchema);

  if (!result.ok) return Err({ code: result.error });

  // §8.1 rule 1, enforced in code rather than trusted from the prompt alone
  // (task 4.10: "a plan naming a handle absent from the snapshot is
  // rejected before display"). A handle that does not appear in the
  // planning-time snapshot does not exist, full stop — no partial credit,
  // no silent drop of just that step.
  const known = new Map(input.snapshot.elements.map((e) => [e.handle, e]));
  for (const step of result.value.steps) {
    const handle = handleOf(step.action);
    if (handle && !known.has(handle)) {
      return Err({ code: 'MODEL_OUTPUT_INVALID' });
    }
    // Fill targetHint from the planning-time snapshot ourselves — never
    // trust the model's own echo of role/name (plan.schema.ts's header).
    if (handle) {
      const el = known.get(handle)!;
      step.targetHint = { role: el.role, name: el.name };
    }
  }

  return Ok(result.value);
}
