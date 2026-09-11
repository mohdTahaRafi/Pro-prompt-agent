/**
 * Model tiers — the four workload classes with genuinely different
 * requirements, engines and failure modes. Docs/planning/phase_4_model_tiers_routing.md §3.
 *
 * Named `ModelTier` rather than `Tier` because lib/types/agent.types.ts
 * already exports `Tier` for the gate's risk classification
 * (low/medium/always/never) — a different axis entirely (§5 there vs §3
 * here). Reusing the name would make every import site ambiguous about
 * which "tier" it means.
 */

export type ModelTier = 'planner' | 'judge' | 'vision' | 'inline';

export const MODEL_TIERS: readonly ModelTier[] = ['planner', 'judge', 'vision', 'inline'] as const;

export interface TierBudget {
  /** Human-readable budget line, shown in the Models tab. */
  label: string;
  /** p95 latency target in milliseconds, for the one posture/engine pairing
   *  that is the primary path — the local engine for judge/vision/inline,
   *  Ollama for planner. Used by tests/bench measurement, not enforced at
   *  runtime (a budget is a target to measure against, not a timeout). */
  p95Ms: number;
  maxCallsPerRun?: number;
}

export const TIER_BUDGETS: Record<ModelTier, TierBudget> = {
  planner: { label: '≤ 8s p95 Ollama, ≤ 6s p95 remote; ≤ 30 calls/run', p95Ms: 8_000, maxCallsPerRun: 30 },
  judge: { label: '≤ 1.2s p95 per call', p95Ms: 1_200 },
  vision: { label: '≤ 4s p95 local, ≤ 3s p95 remote', p95Ms: 4_000 },
  inline: { label: '≤ 400ms p95 including both message hops', p95Ms: 400 },
};

/** §5.3 — the size floor a locally-installed Ollama model must clear to be
 *  offered as a planner. Below this, a model does not fail loudly on a
 *  multi-step plan — it produces confidently wrong plans (§3.1), which is
 *  worse than refusing. Matched against the size suffix Ollama's tag
 *  convention carries (e.g. "qwen2.5:14b", "llama3.1:8b-instruct"). */
export const PLANNER_MIN_PARAMS_B = 7;

/** The instruct/chat suffix Ollama tag names carry when they are NOT a base
 *  completion model — used only to explain a rejection in plain language;
 *  it is not itself part of the size gate (a 14b base model still clears
 *  PLANNER_MIN_PARAMS_B and is offered, just without the "instruct-tuned"
 *  qualifier in the reason string). */
const INSTRUCT_HINTS = /instruct|chat|it\b/i;

/** Parses the billions-of-parameters figure out of an Ollama model tag, e.g.
 *  "qwen2.5:14b" → 14, "tinyllama:latest" → null (no size in the tag),
 *  "llama3.1:8b-instruct-q4_0" → 8. Returns null when no size suffix is
 *  present — such a tag is never assumed planner-capable (§3's asymmetry:
 *  a false "capable" is the expensive failure, not a false "not capable"). */
export function parseParamsB(tag: string): number | null {
  const m = tag.match(/(\d+(?:\.\d+)?)\s*[bB](?:\b|[^a-zA-Z])/);
  return m ? parseFloat(m[1]) : null;
}

export interface OllamaModelClassification {
  name: string;
  paramsB: number | null;
  instructTuned: boolean;
  plannerCapable: boolean;
}

export function classifyOllamaModel(name: string): OllamaModelClassification {
  const paramsB = parseParamsB(name);
  const instructTuned = INSTRUCT_HINTS.test(name);
  return { name, paramsB, instructTuned, plannerCapable: paramsB !== null && paramsB >= PLANNER_MIN_PARAMS_B };
}
