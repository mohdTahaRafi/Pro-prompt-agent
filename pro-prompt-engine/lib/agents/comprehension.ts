/**
 * Comprehension Agent — condenses raw webpage context into concise
 * knowledge. §2, §3.7.10 — direct-path text verb, judge tier
 * (lib/agents/text-tier.ts). Distinct from lib/model/minimise.ts's Class B
 * condensation (same tier, different job: this builds a profile's
 * Context.md knowledge base; minimise.ts shrinks a payload before a remote
 * planner call).
 */

import { route } from '@lib/model/router';
import { TEXT_TIER_POSTURE } from '@lib/agents/text-tier';

export async function comprehendContext(rawText: string): Promise<string> {
  const systemPrompt = `You are a critical knowledge extractor. The user will provide raw, potentially noisy text from a webpage or selection.
Your job is to condense this into purely factual, highly dense contextual information.
Rules:
- Remove all fluff, formatting artifacts, and conversational text.
- Preserve hard facts, code blocks, exact definitions, and specific constraints.
- Output a structured summary (bullet points if applicable).
- Do NOT hallucinate. Do NOT add information not present in the source text.`;

  const response = await route({
    tier: 'judge', posture: TEXT_TIER_POSTURE,
    system: systemPrompt, user: `Extract key context from this raw text:\n\n${rawText}`,
    maxTokens: 1024, temperature: 0.2, // Very low temperature to prevent hallucination
  });

  if (!response.ok) throw new Error(`Comprehension failed: ${response.error}`);
  return response.value.content.trim();
}
