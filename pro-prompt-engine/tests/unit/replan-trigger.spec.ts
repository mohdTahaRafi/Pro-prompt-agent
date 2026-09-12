/**
 * lib/agent/replan.ts — the seven re-planning triggers.
 * Docs/planning/phase_5_agent_loop.md §11 task 5.6.
 */
import { describe, it, expect } from 'vitest';
import { shouldReplan, detectFieldCountAnomaly, type StepContext } from '@lib/agent/replan';
import type { Plan } from '@lib/schemas/plan.schema';

const PLAN: Plan = { restatement: 'x', steps: [{ n: 1, intent: 'a', action: { verb: 'read_page' }, expectation: 'x' }], willNotDo: [] };

function baseCtx(overrides: Partial<StepContext> = {}): StepContext {
  return {
    stepIndex: 1, plan: PLAN, lastVerdict: 'confirmed', consecutiveUnconfirmed: 0,
    resolveError: null, urlChangedUnexpectedly: false, snapshot: { epochSuspect: false },
    planEditedSince: false, anomaly: false,
    ...overrides,
  };
}

describe('shouldReplan — each trigger fires on its own condition, and nothing else does', () => {
  it('a fully derivable step (no condition met) invokes the planner zero times — returns null', () => {
    expect(shouldReplan(baseCtx())).toBeNull();
  });

  it('1. run_start — stepIndex 0 with no plan yet', () => {
    expect(shouldReplan(baseCtx({ stepIndex: 0, plan: null }))).toBe('run_start');
  });

  it('run_start does NOT fire once a plan exists, even at stepIndex 0', () => {
    expect(shouldReplan(baseCtx({ stepIndex: 0, plan: PLAN }))).toBeNull();
  });

  it('2. verification_failed — the previous step\'s verdict was failed', () => {
    expect(shouldReplan(baseCtx({ lastVerdict: 'failed' }))).toBe('verification_failed');
  });

  it('3. two_unconfirmed — two consecutive unconfirmed on the same step', () => {
    expect(shouldReplan(baseCtx({ consecutiveUnconfirmed: 2 }))).toBe('two_unconfirmed');
    expect(shouldReplan(baseCtx({ consecutiveUnconfirmed: 1 }))).toBeNull();
  });

  it('4. target_unresolvable — the resolver returned TARGET_MISSING', () => {
    expect(shouldReplan(baseCtx({ resolveError: 'TARGET_MISSING' }))).toBe('target_unresolvable');
  });

  it('TARGET_AMBIGUOUS does not trigger a replan (it is an ask_user reason, §10)', () => {
    expect(shouldReplan(baseCtx({ resolveError: 'TARGET_AMBIGUOUS' }))).toBeNull();
  });

  it('5. unexpected_change — an unpredicted URL change', () => {
    expect(shouldReplan(baseCtx({ urlChangedUnexpectedly: true }))).toBe('unexpected_change');
  });

  it('5. unexpected_change — a suspect epoch (large mutation burst)', () => {
    expect(shouldReplan(baseCtx({ snapshot: { epochSuspect: true } }))).toBe('unexpected_change');
  });

  it('6. user_edited_plan — the user edited the plan since the last check', () => {
    expect(shouldReplan(baseCtx({ planEditedSince: true }))).toBe('user_edited_plan');
  });

  it('7. anomaly — the caller-supplied anomaly flag', () => {
    expect(shouldReplan(baseCtx({ anomaly: true }))).toBe('anomaly');
  });

  it('checks earlier in the list win when more than one condition is true', () => {
    expect(shouldReplan(baseCtx({ lastVerdict: 'failed', anomaly: true }))).toBe('verification_failed');
  });
});

describe('detectFieldCountAnomaly — §4.3\'s one detector this phase', () => {
  it('fires when the observed count is more than 60% below the median', () => {
    expect(detectFieldCountAnomaly(3, 10)).toBe(true);   // 70% below
  });

  it('does not fire at or above the 40% floor', () => {
    expect(detectFieldCountAnomaly(4, 10)).toBe(false);  // exactly 60% below
    expect(detectFieldCountAnomaly(8, 10)).toBe(false);
  });

  it('never fires against a zero median — nothing to compare against', () => {
    expect(detectFieldCountAnomaly(0, 0)).toBe(false);
  });
});
