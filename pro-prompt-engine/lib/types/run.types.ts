/**
 * Run types — the shape of an agent run and its journal.
 *
 * [Phase 1] Created now so the Dexie v2 schema (lib/db/dexie-db.ts) and later
 * phases write into a schema that already exists rather than migrating again.
 * [Phase 3] narrows RunEventKind from `string` to the real event vocabulary
 * (§8) and gives RunRecord its first real callers — the gate re-derives its
 * context from this row on every action.
 * See Docs/planning/phase_1_foundation_preconditions.md §3.3,
 * Docs/planning/phase_3_gate_actuation_verification.md §8.
 */

import type { Verb } from '@lib/schemas/action.schema';
import type { Plan } from '@lib/schemas/plan.schema';

export type RunState =
  | 'planning'                 // admitted; plan not yet produced
  | 'awaiting_plan_approval'   // plan shown; Suggest/Supervised hold here
  | 'running'
  | 'awaiting_approval'        // an Always-tier action is queued
  | 'awaiting_user'            // ask_user is outstanding
  | 'paused'                   // user pressed Pause
  | 'taken_over'               // user is driving; agent suspended
  | 'halted'                   // interrupted, revoked, or backend detached
  | 'stopped'                  // user pressed Stop
  | 'failed'
  | 'completed';                // includes completed_with_gaps

export interface RunBudgets {
  maxActions: 40;
  maxRetriesPerStep: 3;
  maxPlannerCalls: 30;
  maxWallClockMs: 720_000;
}

export interface RunRecord {
  id?: number;
  goal: string;                       // the user's original text, never rewritten
  state: RunState;
  mode: 'suggest' | 'step' | 'supervised' | 'watch';   // 'watch' is Phase 11
  posture: 'local-only' | 'hybrid';
  backend: 'dom' | 'cdp';              // 'cdp' is Phase 9
  origin: string;                      // the origin the run was started on
  scope: string[];                     // every origin granted to this run
  roster: number[];                    // tabIds; length 1 until Phase 7
  budgets: RunBudgets;                 // SHARED across the roster (§3.7.16)
  plan?: Plan;                         // the approved plan, as executed
  outcome?: 'completed' | 'completed_with_gaps' | 'failed' | 'stuck' | 'stopped';
  startedAt: number;
  endedAt?: number;
  profileId?: number;                  // (Phase 8) fact attribution
}

// [Phase 3 §8] The complete journal vocabulary this phase writes. Later
// phases (recovery, planning, multi-tab) add kinds; none of Phase 3's own
// code appends anything outside this set — lib/agent/journal.ts is the only
// writer of runEvents (task 3.11), so this union is enforceable at the call
// site rather than merely documentary.
export type RunEventKind =
  | 'run.created'
  | 'action.requested'
  | 'action.permitted'
  | 'action.refused'
  | 'action.dispatched'
  | 'action.observed'
  | 'approval.requested'
  | 'approval.granted'
  | 'approval.denied'
  | 'run.completed';

export interface RunEvent {
  id?: number;
  runId: number;
  seq: number;                        // monotonic per run; assigned by journal.ts
  kind: RunEventKind;
  at: number;
  tabId: number | null;               // null for run-level events. [Phase 7: real tab ids]
  data: unknown;                       // validated by the per-kind Zod schema
}
