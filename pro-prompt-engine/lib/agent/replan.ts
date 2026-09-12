/**
 * Replan triggers — the seven conditions that call the planner mid-run.
 * Docs/planning/phase_5_agent_loop.md §4.3, architecture.md §3.7.20.
 *
 * The per-step hot path is lib/agent/step-resolver.ts (the judge tier); the
 * planner is re-invoked only when shouldReplan() returns non-null. This is
 * the whole mechanism that keeps J-1 (30 actions) to ~3-6 planner calls
 * instead of 30 — see the file header on tab-agent.ts for where this is
 * called from.
 */
import type { ResolveError } from '@lib/agent/step-resolver';
import type { Verified } from '@lib/types/agent.types';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import type { Plan } from '@lib/schemas/plan.schema';

export type ReplanTrigger =
  | 'run_start'              // 1
  | 'verification_failed'    // 2
  | 'two_unconfirmed'        // 3 — same step, consecutive
  | 'target_unresolvable'    // 4 — the plan step's descriptor fails to re-resolve
  | 'unexpected_change'      // 5 — URL change or large mutation burst the plan did not predict
  | 'user_edited_plan'       // 6
  | 'anomaly';               // 7 — e.g. a field count far below comparable pages

export interface StepContext {
  stepIndex: number;
  plan: Plan | null;
  lastVerdict: Verified | null;
  consecutiveUnconfirmed: number;
  resolveError: ResolveError | null;
  urlChangedUnexpectedly: boolean;
  snapshot: Pick<PerceptionSnapshot, 'epochSuspect'>;
  planEditedSince: boolean;
  anomaly: boolean;
}

/** Every field above corresponds to exactly one trigger; a context that
 *  satisfies none of them is derivable and costs zero planner calls
 *  (replan-trigger.spec.ts: "a derivable step invokes the planner zero
 *  times"). Order is significant only in that run_start is checked first —
 *  every other condition implies a plan already exists. */
export function shouldReplan(ctx: StepContext): ReplanTrigger | null {
  if (ctx.stepIndex === 0 && !ctx.plan) return 'run_start';
  if (ctx.lastVerdict === 'failed') return 'verification_failed';
  if (ctx.consecutiveUnconfirmed >= 2) return 'two_unconfirmed';
  if (ctx.resolveError === 'TARGET_MISSING') return 'target_unresolvable';
  if (ctx.urlChangedUnexpectedly || ctx.snapshot.epochSuspect) return 'unexpected_change';
  if (ctx.planEditedSince) return 'user_edited_plan';
  if (ctx.anomaly) return 'anomaly';
  return null;
}

/** §4.3's one anomaly detector this phase: an extracted-field count more
 *  than 60% below the median of the same region type across the corpus.
 *  Richer anomaly detection is Phase 6. `median` is the corpus baseline the
 *  caller supplies (a fixed constant this phase — there is no live corpus
 *  query at run time); a median of 0 never trips the detector (nothing to
 *  compare against). */
export function detectFieldCountAnomaly(observedCount: number, median: number): boolean {
  if (median <= 0) return false;
  return observedCount < median * 0.4;
}
