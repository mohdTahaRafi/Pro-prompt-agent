/**
 * Action schema — verb vocabulary.
 *
 * [Phase 2] widens Verb from `never` to the four perception verbs
 * (PR-PERC-1…7): the agent can look, but cannot yet click, type, navigate,
 * or decide. [Phase 3] adds the interaction verbs and the full Zod schema
 * that drives both z.toJSONSchema() (constrained decoding) and gate
 * validation, per architecture.md §3.7.14.
 *
 * NOTE ON FILE LOCATION: Docs/planning/phase_2_perception.md §13 lists this
 * widening under `lib/types/agent.types.ts`. That file is a Phase 3 stub
 * (gate/tier/actuation types) with no `Verb` export; the real `Verb` type —
 * the one `lib/policy/scope.ts`'s `DEFAULT_CAPABILITIES: Verb[]` already
 * imports — lives here, created in Phase 1. Widening it here instead keeps
 * every existing import working; agent.types.ts is untouched until Phase 3.
 */

export type PerceptionVerb =
  | 'read_page' | 'read_structure' | 'read_element' | 'wait_for_settle';

/** [Phase 3: unions in the interaction verb set — click, type, navigate, …] */
export type Verb = PerceptionVerb;
