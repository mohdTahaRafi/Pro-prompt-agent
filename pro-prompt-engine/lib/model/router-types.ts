/**
 * Router types — split out of lib/model/router.ts so every engine
 * (lib/model/engines/*.ts) can import RouteRequest/RouteResponse/RouteError
 * without importing router.ts itself. router.ts imports the CHAINS table's
 * engines, which would make an engine→router.ts import circular; engines
 * only ever need the *shapes*, never route() itself (lib/model/minimise.ts
 * is the one module that legitimately needs route() — see its header).
 * Docs/planning/phase_4_model_tiers_routing.md §4.
 */
import type { z } from 'zod';
import type { ModelTier } from '@lib/model/tiers';
import type { Posture } from '@lib/model/posture';

/** A vision request's user content carries image parts alongside text
 *  (§3's vision row). Declared now — routable from this phase — with no
 *  caller until Phase 10's `look_at` (§15). */
export type PromptContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string };   // data URL or base64, engine-specific

export interface RouteRequest {
  tier: ModelTier;
  posture: Posture;
  system: string;
  user: string | PromptContent[];
  schema?: z.ZodType;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Required whenever the call may go remote (§4). Also gates
   *  lib/model/minimise.ts's Class A assertion / Class B condensation. */
  disclosureClass?: 'A' | 'B';
  /** [Addition beyond the doc's RouteRequest sketch] The run this call is
   *  made on behalf of, when one exists. §5.4 and §4.2 require every remote
   *  call and every within-locality fallback to be journaled against a run
   *  (`inference.remote`, `inference.fallback`) — the doc's engine code
   *  samples read `req.runId` to do that but the interface as sketched
   *  never declared the field. Undefined for calls with no run yet: the
   *  direct-path text agents (§3.7.10) and inline completion, neither of
   *  which journal inference calls. */
  runId?: number;
  /** Set by lib/model/minimise.ts's Class B condensation — carried through
   *  so the caller (and the journal) can see the condensation ratio. */
  meta?: { condensed: boolean; originalTokens: number; sentTokens: number; scrubbed: string[] };
}

export interface RouteResponse {
  content: string;
  constrained: boolean;
  tokensUsed?: number;
  latencyMs: number;
  engine: string;
  tier: ModelTier;
}

export type RouteError =
  | 'NO_ENGINE_FOR_TIER'
  | 'ENGINE_UNAVAILABLE'
  | 'ENGINE_DOWNLOADING'
  | 'ENGINE_FAILED'
  | 'CONTEXT_TOO_LARGE'
  | 'ABORTED'
  | 'ALL_ENGINES_FAILED'
  | 'CONDENSATION_UNAVAILABLE'
  | 'CLASS_A_CONTAINS_RAW_TEXT'
  | 'MODEL_OUTPUT_INVALID';
