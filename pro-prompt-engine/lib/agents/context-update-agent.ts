/**
 * Context Update Agent
 * Intelligently merges new information into an existing Context.md.
 * Rather than blindly appending, it produces a coherent, deduplicated,
 * and token-constrained update — similar to how Gemini CLI maintains GEMINI.md.
 *
 * [Phase 4] direct-path text verb, judge tier — same reasoning as
 * lib/agents/refactor.ts (lib/agents/text-tier.ts's header).
 */

import { route } from '@lib/model/router';
import { TEXT_TIER_POSTURE } from '@lib/agents/text-tier';
import { countTokens, MAX_CONTEXT_TOKENS } from '@lib/utils/token-counter';

export async function updateContext(
  existingContext: string,
  newInformation: string,
  source: 'manual' | 'selection' | 'web_scan' = 'manual',
): Promise<string> {
  const existingTokens = countTokens(existingContext);
  const sourceLabel = source === 'web_scan' ? 'a web page scan' : source === 'selection' ? 'a text selection' : 'manual input';

  // If no existing context, just summarize the new information directly
  if (!existingContext.trim()) {
    const systemPrompt = `You are a knowledge distillation engine. The user wants to build a context knowledge base.
Extract and structure the most important, actionable facts from the provided text.
Format as clear markdown with headers and bullet points.
Be dense — every sentence should carry information.
Do NOT exceed 800 words.
Do NOT include meta-commentary like "Here is the context" — output only the knowledge itself.`;

    const response = await route({
      tier: 'judge', posture: TEXT_TIER_POSTURE,
      system: systemPrompt,
      user: `Distill this into a structured knowledge context (source: ${sourceLabel}):\n\n${newInformation}`,
      maxTokens: 1024, temperature: 0.2,
    });

    return (response.ok ? response.value.content.trim() : '') || newInformation.slice(0, 4000);
  }

  // With existing context: intelligent merge
  const systemPrompt = `You are a knowledge base curator maintaining a living Context.md file for a prompt engineering profile.
Your job is to intelligently merge new information into the existing context.

Rules:
1. MERGE intelligently — integrate new facts into relevant existing sections.
2. DEDUPLICATE — if the new info already exists, don't repeat it.
3. UPDATE — if new info contradicts or supersedes existing info, replace the old with the new.
4. ADD — if new info is genuinely new, add it to the appropriate section or create a new one.
5. COMPRESS — if the total would exceed the limit, summarize older/less critical sections to make room.
6. PRESERVE structure — keep the markdown heading hierarchy.
7. TOKEN LIMIT — the output MUST be under ${MAX_CONTEXT_TOKENS} tokens (~${Math.round(MAX_CONTEXT_TOKENS * 3.5)} characters). Current context: ~${existingTokens} tokens.

Output ONLY the updated Context.md content. No preamble, no explanation.`;

  const response = await route({
    tier: 'judge', posture: TEXT_TIER_POSTURE,
    system: systemPrompt,
    user: `--- EXISTING CONTEXT.MD ---\n${existingContext}\n\n--- NEW INFORMATION TO MERGE (source: ${sourceLabel}) ---\n${newInformation}\n\n--- Produce the updated Context.md: ---`,
    maxTokens: 2000, temperature: 0.3,
  });

  const result = response.ok ? response.value.content.trim() : '';

  // Safety: if LLM fails, fall back to simple append with truncation
  if (!result) {
    const combined = existingContext + '\n\n---\n\n' + newInformation;
    return combined.slice(0, MAX_CONTEXT_TOKENS * 4); // rough char limit
  }

  return result;
}

/**
 * Profile Bootstrap Agent
 * Given a user's description of what they want the profile to do,
 * generate all 4 profile files with appropriate content.
 */
export async function bootstrapProfile(description: string): Promise<{
  name: string;
  icon: string;
  profileDescriptionMd: string;
  promptGuidelinesMd: string;
  scoringGuidelinesMd: string;
}> {
  const systemPrompt = `You are an expert prompt engineering consultant helping a user configure a prompt engineering profile.
The user will describe what they want the profile for. You must generate 4 structured files for their profile.

Respond with ONLY a valid JSON object with these exact keys:
- "name": short profile name (2-3 words max)
- "icon": single relevant emoji
- "profileDescriptionMd": markdown string describing what this profile is for (2-3 sentences)
- "promptGuidelinesMd": markdown string with 4-6 numbered guidelines for how prompts should be written for this use case (use ## heading + numbered list)
- "scoringGuidelinesMd": markdown string with 4-5 scoring criteria and their weights that sum to 100% (use ## heading + bullet points)

Example format:
{"name":"Finance Analyst","icon":"📊","profileDescriptionMd":"...","promptGuidelinesMd":"# Finance Guidelines\\n\\n1. **Precision**: ...","scoringGuidelinesMd":"# Finance Scoring\\n\\n- **Data Specificity (35%)**: ..."}`;

  const response = await route({
    tier: 'judge', posture: TEXT_TIER_POSTURE,
    system: systemPrompt,
    user: `Create a prompt engineering profile for this use case:\n\n${description}`,
    maxTokens: 1500, temperature: 0.6,
  });

  try {
    if (!response.ok) throw new Error(response.error);
    const raw = response.value.content.replace(/```json/g, '').replace(/```/g, '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found');
    const parsed = JSON.parse(match[0]);
    return {
      name: parsed.name || 'Custom Profile',
      icon: parsed.icon || '🧑‍💻',
      profileDescriptionMd: parsed.profileDescriptionMd || description,
      promptGuidelinesMd: parsed.promptGuidelinesMd || `# ${parsed.name || 'Profile'} Guidelines\n\n1. Be clear and specific.\n2. Define the output format.\n3. Provide relevant context.\n4. Set quality constraints.`,
      scoringGuidelinesMd: parsed.scoringGuidelinesMd || `# ${parsed.name || 'Profile'} Scoring\n\n- **Clarity (40%)**: Is the intent unambiguous?\n- **Format (30%)**: Is output format specified?\n- **Context (30%)**: Is enough background provided?`,
    };
  } catch {
    return {
      name: 'Custom Profile',
      icon: '🧑‍💻',
      profileDescriptionMd: description,
      promptGuidelinesMd: `# Profile Guidelines\n\n1. Be clear and specific.\n2. Define the output format.\n3. Provide relevant context.\n4. Set quality constraints.`,
      scoringGuidelinesMd: `# Scoring Criteria\n\n- **Clarity (40%)**: Is the intent unambiguous?\n- **Format (30%)**: Is output format specified?\n- **Context (30%)**: Is enough background provided?`,
    };
  }
}
