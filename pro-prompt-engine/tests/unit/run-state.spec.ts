/**
 * lib/agent/run-state.ts — the transition table. Docs/planning/phase_3_gate_actuation_verification.md §12 task 3.2.
 *
 * SPEC NOTE: the phase doc's task 3.2 says "all 30 legal edges" / "all 91
 * illegal edges" (11×11 = 121 total). Enumerating the doc's own §4.5 table
 * literally gives 31 legal edges (5+3+9+4+4+3+3), not 30 — a running total
 * arithmetic slip in the doc, not a decision this test should paper over.
 * These assertions use the table's actual, dynamically-computed edge counts
 * (31 legal / 90 illegal) rather than the doc's stated 30/91, and this file
 * is the record of that correction.
 */
import { describe, it, expect } from 'vitest';
import { canAct, transition, legalEdges, illegalEdges, ALL_RUN_STATES } from '@lib/agent/run-state';

describe('run-state — transition table', () => {
  it('has eleven states', () => {
    expect(ALL_RUN_STATES).toHaveLength(11);
  });

  it('all legal edges succeed (31, per §4.5\'s table — see file header)', () => {
    const edges = legalEdges();
    expect(edges).toHaveLength(31);
    for (const [from, to] of edges) {
      const r = transition(from, to);
      expect(r.ok, `${from} -> ${to} should be legal`).toBe(true);
      if (r.ok) expect(r.value).toBe(to);
    }
  });

  it('all illegal edges return ILLEGAL_TRANSITION (90 = 121 - 31)', () => {
    const edges = illegalEdges();
    expect(edges).toHaveLength(90);
    for (const [from, to] of edges) {
      const r = transition(from, to);
      expect(r.ok, `${from} -> ${to} should be illegal`).toBe(false);
      if (!r.ok) expect(r.error).toBe('ILLEGAL_TRANSITION');
    }
  });

  it('the four terminal states accept no transition at all', () => {
    for (const terminal of ['halted', 'stopped', 'failed', 'completed'] as const) {
      for (const to of ALL_RUN_STATES) {
        expect(transition(terminal, to).ok).toBe(false);
      }
    }
  });

  it('canAct is true only for running', () => {
    for (const s of ALL_RUN_STATES) {
      expect(canAct(s)).toBe(s === 'running');
    }
  });

  it('running -> running is legal (an action completes and the run stays running)', () => {
    expect(transition('running', 'running').ok).toBe(true);
  });
});
