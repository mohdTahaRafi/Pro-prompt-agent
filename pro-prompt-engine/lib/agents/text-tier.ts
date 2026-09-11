/**
 * Text-agent tier routing — shared by every direct-path text verb
 * (refactor, generate, score, comprehend/summarise). §2, §3.7.10.
 *
 * [Phase 4 decision, not spelled out verbatim in the doc] These four are
 * "migrated onto the judge/planner tiers" per §2's table, without saying
 * which agent gets which. Routed here onto JUDGE, not planner:
 *  - §3.7.10 states the direct path "does not go through the kernel, the
 *    planner, or the gate" at all — planner is explicitly out of scope for
 *    these verbs.
 *  - The planner tier's chain (lib/model/router.ts's CHAINS.planner) has NO
 *    in-browser engine in EITHER posture (§3.1: "never an in-browser
 *    model") — routing these agents there would mean a Local-only user with
 *    no Ollama installed loses refactor/generate/score entirely, a real
 *    regression from the Phase 1 cascade's WebGPU-first behaviour.
 *  - The judge tier's chain is `[promptApiEngine, webllmEngine]` in BOTH
 *    postures — local, in-browser, no Ollama or remote key required,
 *    preserving today's behaviour and honouring PP-8/SC-11 (direct text
 *    verbs must not get slower or gain a new hard dependency because a
 *    planner now exists).
 *
 * These agents have no `run` and so no per-run posture choice (that concept
 * doesn't exist until a run is created — Phase 5 for execution, this
 * phase's Plan panel for planning only). Since CHAINS.judge is IDENTICAL
 * for both postures (lib/model/router.ts §4.1's header note), which
 * constant is passed here can never change which engine actually serves
 * the call — it exists only because RouteRequest.posture is a required
 * field.
 */
import type { Posture } from '@lib/model/posture';

export const TEXT_TIER_POSTURE: Posture = 'local-only';
