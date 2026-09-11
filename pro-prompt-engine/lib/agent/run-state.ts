/**
 * Run state machine — the transition table the gate and (from Phase 5) the
 * Supervisor share verbatim. Docs/planning/phase_3_gate_actuation_verification.md §4.5.
 *
 * Eleven states, ~30 flat edges. `running → running` is legal and is the
 * normal case: an action completes and the run stays running. The four
 * terminal states have empty transition lists, which is what makes "a
 * completed run cannot be resurrected" a table lookup rather than a
 * convention.
 */
import { Ok, Err, type Result } from '@lib/utils/result';
import type { RunState } from '@lib/types/run.types';

const LEGAL: Record<RunState, RunState[]> = {
  planning: ['awaiting_plan_approval', 'running', 'failed', 'stopped', 'halted'],
  awaiting_plan_approval: ['running', 'stopped', 'failed'],
  running: [
    'awaiting_approval', 'awaiting_user', 'paused', 'taken_over',
    'running', 'completed', 'failed', 'stopped', 'halted',
  ],
  awaiting_approval: ['running', 'stopped', 'failed', 'halted'],
  awaiting_user: ['running', 'stopped', 'failed', 'halted'],
  paused: ['running', 'stopped', 'halted'],
  taken_over: ['running', 'stopped', 'halted'],
  halted: [],
  stopped: [],
  failed: [],
  completed: [],
};

/** The gate's hot predicate. One boolean, from a persisted string, no
 *  interpreter to rehydrate on a cold service-worker wake. */
export function canAct(state: RunState): boolean {
  return state === 'running';
}

export function transition(from: RunState, to: RunState): Result<RunState, 'ILLEGAL_TRANSITION'> {
  return LEGAL[from].includes(to) ? Ok(to) : Err('ILLEGAL_TRANSITION');
}

/** Every state the table knows about, for exhaustive test iteration. */
export const ALL_RUN_STATES: RunState[] = Object.keys(LEGAL) as RunState[];

/** All legal (from, to) pairs — §12 task 3.2 asserts all 30 succeed. */
export function legalEdges(): Array<[RunState, RunState]> {
  const edges: Array<[RunState, RunState]> = [];
  for (const from of ALL_RUN_STATES) {
    for (const to of LEGAL[from]) edges.push([from, to]);
  }
  return edges;
}

/** All illegal (from, to) pairs over the full state set — §12 task 3.2
 *  asserts all 91 return ILLEGAL_TRANSITION (11×11 = 121 pairs, minus the
 *  30 legal ones). */
export function illegalEdges(): Array<[RunState, RunState]> {
  const legal = new Set(legalEdges().map(([f, t]) => `${f}>${t}`));
  const edges: Array<[RunState, RunState]> = [];
  for (const from of ALL_RUN_STATES) {
    for (const to of ALL_RUN_STATES) {
      if (!legal.has(`${from}>${to}`)) edges.push([from, to]);
    }
  }
  return edges;
}
