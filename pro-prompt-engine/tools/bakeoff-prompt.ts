/**
 * Planner prompt — the Phase 2 bake-off's own draft. §10.1.
 *
 * [Phase 4] Moved out of lib/agent/prompts.ts, which that file's own header
 * always said no production code imports (Docs/planning/phase_2_perception.md
 * §16) — Phase 4 replaces lib/agent/prompts.ts with the shipped planner
 * prompt (§8.1), so this draft now lives where its only consumer,
 * tools/bakeoff.ts, actually is: tools/. Content unchanged from the Phase 2
 * version; only the file's location and this header moved.
 *
 * Kept (not deleted) so the bake-off can still be re-run — e.g. against
 * DEFAULT_PLANNER_MODEL once a real dev machine can pull it
 * (lib/model/engines/ollama.ts's header note) — without resurrecting a
 * planner draft from git history.
 */
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';

/** The bake-off's own minimal plan shape — NOT lib/schemas/plan.schema.ts,
 *  which is now the real, shipped Plan shape (§8.2). Scored against a
 *  hand-written gold answer, never executed. */
export interface BakeoffPlanStep {
  /** One of the four perception verbs, or a plain description for an
   *  interaction verb the vocabulary doesn't have yet in Phase 2 — the
   *  model is asked to name the action even though nothing can run it. */
  action: string;
  /** The handle this step targets, or null when the step needs no target
   *  (e.g. "wait for the page to settle"). */
  handle: string | null;
  /** One sentence: what this step accomplishes. */
  reason: string;
}

export interface BakeoffPlanResponse {
  /** Ordered steps a competent person would take to accomplish the goal
   *  against this snapshot. */
  steps: BakeoffPlanStep[];
  /** What the model states it CANNOT do for this goal given only what the
   *  snapshot shows (PR-PLAN-2) — empty array if nothing is out of reach. */
  willNotDo: string[];
}

const SYSTEM_PROMPT = `You are a browser-automation planner. You are given a structured description of a web page (a "snapshot") and a goal. The snapshot lists every element the page currently exposes, each with an opaque handle like "e12" — you may ONLY reference handles that appear in the snapshot's element list. Never invent a handle.

Each element has:
- handle: the opaque reference you must use to target it
- role: its accessible role (button, textbox, link, checkbox, ...)
- name: its accessible name — what a screen reader would announce
- regionId: which part of the page it belongs to (a form, a landmark, a repeated list, or the page root)
- visible / inViewport: whether it can currently be seen
- actionable: whether it is something you could plausibly act on (disabled and file-input elements are not)

Your job is NOT to act — you are only planning. For the given goal, respond with a JSON object of exactly this shape:

{
  "steps": [
    { "action": "<a short verb phrase, e.g. 'click', 'type into', 'read', 'wait for settle'>",
      "handle": "<a handle from the snapshot, or null if this step targets nothing>",
      "reason": "<one sentence: why this step, in this position>" }
  ],
  "willNotDo": ["<anything the goal implies that this snapshot does not make possible, or an empty array>"]
}

Rules:
1. Every non-null "handle" value MUST be a handle that appears in the snapshot's elements list. A handle you invented, guessed, or reused from a different snapshot is a hard failure.
2. If the goal cannot be accomplished with what the snapshot shows (the needed control is missing, excluded as sensitive, or in an unreachable region), say so plainly in "willNotDo" rather than guessing at a handle that might work.
3. Order steps the way a careful person would actually perform them.
4. Respond with ONLY the JSON object — no prose before or after it.`;

export function buildBakeoffPrompt(snapshot: PerceptionSnapshot, goal: string): { system: string; user: string } {
  const elementLines = snapshot.elements.map((e) => {
    const bits = [
      `handle=${e.handle}`, `role=${e.role}`, `name=${JSON.stringify(e.name)}`,
      `region=${e.regionId}`, e.visible ? 'visible' : 'hidden',
      e.inViewport ? 'in-viewport' : 'off-screen', e.actionable ? 'actionable' : 'not-actionable',
      e.valueShape ? `value=${JSON.stringify(e.valueShape)}` : undefined,
    ].filter(Boolean);
    return `- ${bits.join(', ')}`;
  }).join('\n');

  const regionLines = snapshot.regions.map((r) =>
    `- ${r.regionId} ("${r.label}"): ${r.shown} of ${r.total} shown${r.complete ? '' : ' (PRUNED)'}`,
  ).join('\n');

  const user = `PAGE: ${snapshot.title || '(untitled)'} — ${snapshot.url}
SETTLED: ${snapshot.settled ? `yes, after ${snapshot.settleWaitedMs}ms` : `NO — page was still changing after ${snapshot.settleWaitedMs}ms`}
EXCLUDED FIELDS: ${snapshot.excludedCount} (password/payment/OTP fields — never described, never targetable)
UNREACHABLE REGIONS: ${snapshot.unreachableRegions.length ? snapshot.unreachableRegions.join(', ') : 'none'}

REGIONS:
${regionLines || '(none)'}

ELEMENTS:
${elementLines || '(none)'}

GOAL: ${goal}

Respond with the JSON object described in your instructions. Nothing else.`;

  return { system: SYSTEM_PROMPT, user };
}
