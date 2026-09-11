/**
 * Action schema — the closed verb vocabulary, and the request envelope the
 * gate validates. Docs/planning/phase_3_gate_actuation_verification.md §3.
 *
 * Nineteen verbs are declared (`open_tab` completes the vocabulary in
 * Phase 7). Eleven are implemented this phase; the rest parse successfully
 * — so this schema is a stable target for Phase 4's constrained decoding
 * from the first commit — but the gate refuses them `NOT_YET_IMPLEMENTED`
 * (IMPLEMENTED_VERBS in lib/policy/gate.ts).
 *
 * `ActionSchema` is the single definition that both validates at the gate
 * and, from Phase 4, constrains decoding (architecture.md §3.7.14). Nothing
 * else defines "what an action can be" — a second definition is how the two
 * drift.
 */
import { z } from 'zod';

export const HandleSchema = z.string().regex(/^e[0-9]+$/);

export const ActionSchema = z.discriminatedUnion('verb', [
  // ── Perception — Phase 2 ──
  z.object({ verb: z.literal('read_page') }),
  z.object({ verb: z.literal('read_structure'), region: z.string().optional() }),
  z.object({ verb: z.literal('read_element'), handle: HandleSchema }),
  z.object({ verb: z.literal('wait_for_settle'), maxMs: z.number().int().min(100).max(15_000).optional() }),

  // ── Interaction — Phase 3 ──
  z.object({
    verb: z.literal('scroll'),
    target: z.union([HandleSchema, z.enum(['up', 'down', 'top', 'bottom'])]),
    // Tenths of a viewport height, 1–20, so amount: 10 is one screen. A pixel
    // count would be meaningless across devices; an unbounded number would
    // let one action scroll 40,000px — too large for settle/verify to reason
    // about (§3.1).
    amount: z.number().int().min(1).max(20).optional(),
  }),
  z.object({ verb: z.literal('click'), handle: HandleSchema }),
  z.object({
    verb: z.literal('type'), handle: HandleSchema,
    text: z.string().max(4_000),
    mode: z.enum(['replace', 'append']),
  }),
  z.object({ verb: z.literal('select'), handle: HandleSchema, value: z.string().max(200) }),

  // ── Navigation — Phase 3 ──
  z.object({ verb: z.literal('navigate'), url: z.string().url().max(2_000) }),
  z.object({ verb: z.literal('history_back') }),
  z.object({ verb: z.literal('history_forward') }),

  // ── Declared now, refused NOT_YET_IMPLEMENTED until their own phase ──
  z.object({ verb: z.literal('look_at'), target: z.union([HandleSchema, z.literal('viewport')]) }),           // Phase 10
  z.object({ verb: z.literal('open_tab'), url: z.string().url().max(2_000) }),                                 // Phase 7
  z.object({ verb: z.literal('summarise'), textRef: z.string(), shape: z.string().optional() }),               // Phase 8
  z.object({ verb: z.literal('transform'), textRef: z.string(), shape: z.string() }),                          // Phase 8
  z.object({ verb: z.literal('refactor'), text: z.string().max(20_000) }),                                     // Phase 8
  z.object({ verb: z.literal('generate'), description: z.string().max(4_000) }),                               // Phase 8
  z.object({
    verb: z.literal('ask_user'), question: z.string().max(500),
    reason: z.enum(['AMBIGUOUS_TARGET', 'MISSING_CAPABILITY', 'NEEDS_USER_DATA', 'SITE_BLOCKED']),
    options: z.array(z.string().max(120)).max(6).optional(),
  }),                                                                                                           // Phase 5
  z.object({
    verb: z.literal('finish'),
    outcome: z.enum(['completed', 'completed_with_gaps', 'failed', 'stuck']),
    summary: z.string().max(2_000),
  }),                                                                                                           // Phase 5
]);

export type Action = z.infer<typeof ActionSchema>;

/** The full closed vocabulary — every verb the schema declares, whether or
 *  not it is implemented yet. `lib/policy/gate.ts`'s IMPLEMENTED_VERBS is
 *  the subset the gate will actually run. */
export type Verb = Action['verb'];

export const ActionRequestSchema = z.object({
  requestId: z.string().uuid(),
  runId: z.number().int(),
  tabId: z.number().int(),   // mandatory from Phase 3: the gate resolves origin
                              // from THIS tab, never from the run's scope union
                              // (§3.1, architecture.md §3.7.17).
  epoch: z.number().int().positive(),
  action: ActionSchema,
  reason: z.string().max(300),   // why the requester wants this; journaled verbatim
});

export type ActionRequest = z.infer<typeof ActionRequestSchema>;

/** The message lib/actuation/dom-backend.ts sends to entrypoints/agent.content.ts
 *  to dispatch a permitted, already-gated action (§6.2). Not part of
 *  PerceptionRequest's union (lib/schemas/snapshot.schema.ts) — ACTUATE
 *  performs, it does not perceive — but validated the same way, at the same
 *  boundary, before lib/page/actuator.ts ever touches the DOM. */
export const ActuateMessageSchema = z.object({
  type: z.literal('ACTUATE'),
  runId: z.number().int(),
  action: ActionSchema,
  epoch: z.number().int().positive(),
});

/** Pulls the `handle` field out of an action, for actions that carry one.
 *  Central so the gate and the actuator agree on what "the target" means for
 *  each verb — a second, drifted copy of this switch is exactly how a
 *  handle-bearing verb added later slips past ownership checks unnoticed. */
export function handleOf(action: Action): string | undefined {
  switch (action.verb) {
    case 'read_element':
    case 'click':
    case 'type':
    case 'select':
      return action.handle;
    case 'scroll':
    case 'look_at':
      return HandleSchema.safeParse(action.target).success ? action.target : undefined;
    default:
      return undefined;
  }
}
