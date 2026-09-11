/**
 * Step resolver — plan step + current snapshot → ActionRequest. §8.4.
 * Docs/planning/phase_4_model_tiers_routing.md §8.4.
 *
 * Built now because the judge tier needs a consumer, and because Phase 5
 * must not have to build both the agent loop and this resolver at once.
 * NOTHING DRIVES IT IN SEQUENCE UNTIL PHASE 5 (§1, §15) — no caller in this
 * phase invokes resolveStep() as part of a real run; it exists, is unit
 * tested against its own three-stage ladder, and waits.
 *
 * Uses the JUDGE tier, never the planner (§3.7.20) — this is the per-step
 * hot path; the planner is not.
 */
import { Ok, Err, type Result } from '@lib/utils/result';
import { z } from 'zod';
import { inferStructured } from '@lib/model/router';
import type { Posture } from '@lib/model/posture';
import { JUDGE_TARGET_SYSTEM, renderCandidates } from '@lib/agent/prompts';
import type { PlanStep } from '@lib/schemas/plan.schema';
import type { PerceptionSnapshot, ElementDescriptor } from '@lib/schemas/snapshot.schema';
import { HandleSchema, ActionRequestSchema, handleOf, type Action, type ActionRequest } from '@lib/schemas/action.schema';

export type ResolveError = 'TARGET_MISSING' | 'TARGET_AMBIGUOUS';

export interface ResolveContext {
  runId: number;
  tabId: number;
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Token-overlap (Jaccard) similarity — no fuzzy-matching dependency is in
 *  package.json, and accessible names are short enough that token overlap
 *  is a reasonable proxy for "same element, page re-rendered". */
function nameSimilarity(a: string, b: string): number {
  const ta = new Set(normalize(a).split(/[^a-z0-9]+/).filter(Boolean));
  const tb = new Set(normalize(b).split(/[^a-z0-9]+/).filter(Boolean));
  if (ta.size === 0 && tb.size === 0) return normalize(a) === normalize(b) ? 1 : 0;
  const intersection = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersection / union;
}

function matchesIntent(exact: ElementDescriptor, step: PlanStep): boolean {
  if (!step.targetHint) return false;   // no recorded hint — never declare a match blind
  return exact.role === step.targetHint.role && normalize(exact.name) === normalize(step.targetHint.name);
}

/** Candidate narrowing, still deterministic (step 2, §8.4): same role as
 *  the plan-time hint (when present), ranked by name similarity, actionable
 *  only. */
function narrow(elements: ElementDescriptor[], step: PlanStep): ElementDescriptor[] {
  let pool = elements.filter((e) => e.actionable);
  const hint = step.targetHint;
  if (hint?.role) pool = pool.filter((e) => e.role === hint.role);
  if (!hint?.name) return pool;

  return pool
    .map((e) => ({ e, score: nameSimilarity(e.name, hint.name) }))
    .filter((x) => x.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.e);
}

function byHandle(candidates: ElementDescriptor[], handle: string): ElementDescriptor | undefined {
  return candidates.find((c) => c.handle === handle);
}

/** Rebuilds `action` pointed at a newly-resolved handle — the verbs that
 *  carry a target are exactly the ones lib/schemas/action.schema.ts's
 *  handleOf() reads from (kept in sync deliberately: a handle-bearing verb
 *  added there without a case here is a compile-time-invisible but
 *  runtime-silent bug, so this switch mirrors that one's case list). */
function retarget(action: Action, candidate: ElementDescriptor): Action {
  switch (action.verb) {
    case 'read_element': return { ...action, handle: candidate.handle };
    case 'click': return { ...action, handle: candidate.handle };
    case 'type': return { ...action, handle: candidate.handle };
    case 'select': return { ...action, handle: candidate.handle };
    case 'scroll': return HandleSchema.safeParse(action.target).success ? { ...action, target: candidate.handle } : action;
    case 'look_at': return HandleSchema.safeParse(action.target).success ? { ...action, target: candidate.handle } : action;
    default: return action;
  }
}

function toRequest(action: Action, snap: PerceptionSnapshot, ctx: ResolveContext): ActionRequest {
  return ActionRequestSchema.parse({
    requestId: crypto.randomUUID(), runId: ctx.runId, tabId: ctx.tabId,
    epoch: snap.epoch, action, reason: 'plan step',
  });
}

export async function resolveStep(
  step: PlanStep, snap: PerceptionSnapshot, posture: Posture, ctx: ResolveContext,
): Promise<Result<ActionRequest, ResolveError>> {
  const handle = handleOf(step.action);
  if (!handle) return Ok(toRequest(step.action, snap, ctx));   // no target to resolve

  // 1. DETERMINISTIC FIRST. If the planned handle still exists in this
  //    epoch with the same role and name, no model call is needed at all.
  const exact = snap.elements.find((e) => e.handle === handle);
  if (exact && matchesIntent(exact, step)) return Ok(toRequest(step.action, snap, ctx));

  // 2. Candidate narrowing, still deterministic: same role, name similarity.
  const candidates = narrow(snap.elements, step);
  if (candidates.length === 0) return Err('TARGET_MISSING');
  if (candidates.length === 1) return Ok(toRequest(retarget(step.action, candidates[0]), snap, ctx));

  // 3. Only now, the judge tier: pick among a SMALL candidate set.
  const pick = await inferStructured({
    tier: 'judge', posture, system: JUDGE_TARGET_SYSTEM,
    user: renderCandidates(step, candidates), maxTokens: 60, temperature: 0,
    runId: ctx.runId,
  }, z.object({ handle: HandleSchema, confidence: z.number().min(0).max(1) }));

  if (!pick.ok) return Err('TARGET_AMBIGUOUS');
  if (pick.value.confidence < 0.7) return Err('TARGET_AMBIGUOUS');   // ask, never guess
  const chosen = byHandle(candidates, pick.value.handle);
  if (!chosen) return Err('TARGET_AMBIGUOUS');   // judge named a handle outside the candidate set — never trusted
  return Ok(toRequest(retarget(step.action, chosen), snap, ctx));
}
