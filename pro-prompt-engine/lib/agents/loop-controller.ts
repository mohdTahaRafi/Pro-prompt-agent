/**
 * Agent Loop Controller
 * Orchestrates the Draft → Score → Refactor cycle.
 * - Passes critique from Scorer back to Refactor on subsequent iterations (self-correction)
 * - Uses profile-specific ScoringGuidelines.md for evaluation
 * - Target score: 75 (per FRD)
 * - Circuit breaker: max 3 iterations
 */

import { scorePrompt } from './scorer';
import { refactorPrompt } from './refactor';

export const TARGET_SCORE = 75;
export const MAX_ITERATIONS = 3;

export async function runRefactorLoop(
  userPrompt: string,
  profileContext?: string,
  profileGuidelines?: string,
  scoringGuidelinesMd?: string,
): Promise<{
  originalPrompt: string;
  refinedPrompt: string;
  score: number;
  /** §6.3 — true when no iteration ever produced a real score (the engine
   *  was unavailable or its output never validated). `score` is then 0,
   *  and callers MUST show "I couldn't score this" rather than "0/100" —
   *  a fabricated-looking number is exactly what §6.3 deletes. */
  scoreUnavailable: boolean;
  iterations: number;
  critique: string;
  provider: string;
  latencyMs: number;
  tokensUsed: number;
}> {
  let currentPrompt = userPrompt;
  let iterations = 0;
  let lastScore = 0;
  let lastCritique = '';
  let scored = false;

  let totalLatency = 0;
  let totalTokens = 0;
  let lastProvider = 'unavailable';

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // Step 1: Refactor — pass prior critique on iterations 2+
    console.log(`[Loop Controller] Iteration ${iterations}: Refactoring...`);
    const refactored = await refactorPrompt(
      currentPrompt,
      profileContext,
      profileGuidelines,
      iterations > 1 ? lastCritique : undefined,  // Self-correction feedback
    );
    currentPrompt = refactored.text;
    totalLatency += refactored.latencyMs;
    totalTokens += refactored.tokensUsed || 0;
    lastProvider = refactored.provider;

    // Step 2: Score — use profile scoring guidelines
    console.log(`[Loop Controller] Iteration ${iterations}: Scoring...`);
    const scoreRes = await scorePrompt(currentPrompt, scoringGuidelinesMd);
    // §6.3: no fabricated score on failure. A scoring failure stops the
    // loop with whatever the last successful iteration produced, rather
    // than pretending a 50/100 measurement happened.
    if (!scoreRes.ok) {
      console.warn(`[Loop Controller] Scoring failed (${scoreRes.error}); stopping with the current draft.`);
      break;
    }
    scored = true;
    lastScore = scoreRes.value.score;
    lastCritique = scoreRes.value.critique;
    lastProvider = scoreRes.value.provider;
    totalLatency += scoreRes.value.latencyMs;
    totalTokens += scoreRes.value.tokensUsed || 0;

    console.log(`[Loop Controller] Score: ${lastScore}/100. Critique: "${lastCritique}"`);

    // Circuit breaker: stop early if we hit the target
    if (lastScore >= TARGET_SCORE) {
      console.log(`[Loop Controller] Target score ${TARGET_SCORE} reached at iteration ${iterations}.`);
      break;
    }
  }

  console.log(`[Loop Controller] Finished. Final score: ${lastScore}/100 after ${iterations} iteration(s).`);

  return {
    originalPrompt: userPrompt,
    refinedPrompt: currentPrompt,
    score: lastScore,
    scoreUnavailable: !scored,
    iterations,
    critique: lastCritique,
    provider: lastProvider,
    latencyMs: totalLatency,
    tokensUsed: totalTokens,
  };
}
