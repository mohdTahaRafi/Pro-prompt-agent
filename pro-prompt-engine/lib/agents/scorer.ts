/**
 * Scorer Agent — deterministic scoring evaluation. §6.3.
 *
 * The old four-tier repair ladder (strict parse → brace repair → regex
 * digit extraction → a hard-coded fallback object with a fixed numeric
 * score and a "could not parse" critique) is DELETED. The last rung
 * returned a fabricated score as though it were a measurement — a user
 * saw "50 / 100" and could not tell it from a real evaluation. That was a
 * PP-6 violation in the product's most visible number. Replaced by
 * inferStructured(), returning Result: on MODEL_OUTPUT_INVALID the caller
 * shows no number at all.
 *
 * Routed on the judge tier (§3.7.10, §2 table) — same reasoning as
 * refactor.ts's header: scoring is short, structured, constrained-decodable
 * output, exactly the judge tier's shape, and judge is local in BOTH
 * postures (lib/model/router.ts's CHAINS), so this direct-path text verb
 * never depends on Ollama or a remote key.
 */
import { z } from 'zod';
import { inferStructured } from '@lib/model/router';
import type { Result } from '@lib/utils/result';
import type { RouteError } from '@lib/model/router-types';
import { TEXT_TIER_POSTURE } from '@lib/agents/text-tier';

export const ScoreSchema = z.object({
  score: z.number().min(0).max(100),
  critique: z.string().max(500),
});

export interface ScoreResult {
  score: number;
  critique: string;
  provider: string;
  latencyMs: number;
  tokensUsed?: number;
}

export async function scorePrompt(
  prompt: string,
  scoringGuidelinesMd?: string,
): Promise<Result<ScoreResult, RouteError>> {
  const guidelinesSection = scoringGuidelinesMd
    ? `\n\n--- PROFILE SCORING CRITERIA (use these, not generic criteria) ---\n${scoringGuidelinesMd}`
    : `\n\n--- DEFAULT SCORING CRITERIA ---\n- Intent Clarity (40%): Is the primary goal unambiguous?\n- Constraint Rigidity (30%): Are boundaries, formatting, and edge cases explicitly defined?\n- Persona/Role Alignment (30%): Is the requested role explicitly clear and useful?`;

  const systemPrompt = `You are a deterministic prompt quality evaluator. Score the provided prompt on a scale of 0 to 100.${guidelinesSection}

Respond with a score (0-100 integer) and a single-sentence critique explaining the main weakness.`;

  const start = performance.now();
  const result = await inferStructured({
    tier: 'judge', posture: TEXT_TIER_POSTURE,
    system: systemPrompt, user: `Score this prompt:\n\n${prompt}`,
    maxTokens: 300, temperature: 0.3,
  }, ScoreSchema);

  if (!result.ok) return result;

  return {
    ok: true,
    value: {
      score: result.value.score,
      critique: result.value.critique,
      provider: 'judge',
      latencyMs: Math.round(performance.now() - start),
    },
  };
}
