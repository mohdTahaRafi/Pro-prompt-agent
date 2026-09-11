/**
 * Plan schema — the planner's output shape. §8.2.
 * Docs/planning/phase_4_model_tiers_routing.md §8.2.
 *
 * `z.toJSONSchema(PlanSchema)` drives the planner engine's constrained
 * decoding (§6.1, same mechanism as ActionSchema); `PlanSchema.safeParse`
 * is what lib/agent/planner.ts validates the result against before it is
 * ever displayed. One definition, both jobs — see action.schema.ts's header
 * for why a second one would drift.
 */
import { z } from 'zod';
import { ActionSchema } from '@lib/schemas/action.schema';

export const PlanStepSchema = z.object({
  n: z.number().int().positive(),
  intent: z.string().max(200),          // plain language, shown to the user
  action: ActionSchema,                 // the SAME schema the gate validates
  expectation: z.string().max(200),     // what the page should look like after
  tabHint: z.number().int().optional(), // [Phase 7] which roster tab
  // [Phase 4 addition, not in the doc's §8.2 sketch — completed rather than
  // punted, per this repo's anti-punting rule] The role/name of the target
  // element AT PLANNING TIME, for the handle this step names (if any).
  // lib/agent/planner.ts fills this in itself from the planning-time
  // snapshot after parsing — never trusted from the model's own output —
  // so lib/agent/step-resolver.ts's step 1 ("same role and name") has
  // something concrete to compare the CURRENT snapshot's candidate against
  // instead of trusting a bare handle match across however much page state
  // has changed since the plan was made.
  targetHint: z.object({ role: z.string(), name: z.string() }).optional(),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z.object({
  restatement: z.string().max(300),               // PR-PLAN-1: understanding, restated
  steps: z.array(PlanStepSchema).max(40),
  willNotDo: z.array(z.string().max(200)).max(10), // PR-PLAN-2: required
  clarifyingQuestion: z.string().max(300).optional(), // PR-PLAN-7
}).refine((p) => p.steps.length > 0 || p.clarifyingQuestion,
  'a plan must have steps or a clarifying question');

export type Plan = z.infer<typeof PlanSchema>;
