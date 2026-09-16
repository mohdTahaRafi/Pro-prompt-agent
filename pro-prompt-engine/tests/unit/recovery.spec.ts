/**
 * lib/agent/recovery.ts — FailureCause -> RecoveryAction.
 * Docs/planning/phase_6_recovery_journal_reporting.md §3, §12 task 6.1.
 */
import { describe, it, expect } from 'vitest';
import { recover, detectSiteRefusal, type RecoveryContext } from '@lib/agent/recovery';
import type { FailureCause } from '@lib/types/agent.types';
import type { PlanStep } from '@lib/schemas/plan.schema';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';

const STEP: PlanStep = {
  n: 3, intent: 'click submit', action: { verb: 'click', handle: 'e1' },
  expectation: 'the order confirms', targetHint: { role: 'button', name: 'Submit' },
};

function ctx(overrides: Partial<RecoveryContext> = {}): RecoveryContext {
  return { step: STEP, retriesForStep: 0, ...overrides };
}

describe('recover() — the bounded-retry envelope (§3, PR-REC-3)', () => {
  it('converts a retrying cause to ask on the fourth encounter (retriesForStep >= 3)', () => {
    const action = recover('OBSCURED', ctx({ retriesForStep: 3, overlayDismissed: true }));
    expect(action.kind).toBe('ask');
  });

  it('TARGET_MISSING does NOT cost a retry — replans even at retriesForStep 5', () => {
    const action = recover('TARGET_MISSING', ctx({ retriesForStep: 5 }));
    expect(action).toEqual({ kind: 'replan', trigger: 'target_unresolvable' });
  });

  it('TARGET_AMBIGUOUS does not cost a retry either — always asks, never the envelope message', () => {
    const action = recover('TARGET_AMBIGUOUS', ctx({ retriesForStep: 5, targetName: 'Continue' }));
    expect(action.kind).toBe('ask');
    if (action.kind === 'ask') expect(action.question).toContain('Continue');
  });
});

describe('recover() — one arm per §3 row', () => {
  it('NOT_SETTLED waits one more settle window and retries', () => {
    expect(recover('NOT_SETTLED', ctx())).toEqual({ kind: 'retry', afterSettle: true });
  });

  it('OBSCURED retries after a successful dismissal', () => {
    expect(recover('OBSCURED', ctx({ overlayDismissed: true }))).toEqual({ kind: 'retry', afterSettle: false });
  });

  it('OBSCURED asks when the dismissal did not clear it', () => {
    const action = recover('OBSCURED', ctx({ overlayDismissed: false }));
    expect(action.kind).toBe('ask');
  });

  it('WRITE_REJECTED attempt 1 adapts: click to focus, then the original action', () => {
    const step: PlanStep = { n: 1, intent: 'fill phone', action: { verb: 'type', handle: 'e9', text: '0770', mode: 'replace' }, expectation: 'x' };
    const action = recover('WRITE_REJECTED', { step, retriesForStep: 0, handle: 'e9' });
    expect(action.kind).toBe('adapt');
    if (action.kind === 'adapt') {
      expect(action.sequence).toEqual([{ verb: 'click', handle: 'e9' }, step.action]);
    }
  });

  it('WRITE_REJECTED attempt 2 accepts when loosely equal (reformatted, not rejected) — never a third real write', () => {
    const action = recover('WRITE_REJECTED', ctx({ retriesForStep: 1, intended: '07700900123', readBack: '07700 900123' }));
    expect(action.kind).toBe('accept');
  });

  it('WRITE_REJECTED attempt 2 asks, quoting both values, when genuinely different', () => {
    const action = recover('WRITE_REJECTED', ctx({ retriesForStep: 1, intended: 'Mohd Taha', readBack: '', targetName: 'Full name' }));
    expect(action.kind).toBe('ask');
    if (action.kind === 'ask') {
      expect(action.question).toContain('Mohd Taha');
      expect(action.question).toContain('Full name');
    }
  });

  it('AUTH_REQUIRED pauses and offers a take-over, and its copy says why (never touches password fields) rather than asking for one', () => {
    const action = recover('AUTH_REQUIRED', ctx());
    expect(action).toMatchObject({ kind: 'pause', offer: 'takeover' });
    if (action.kind === 'pause') {
      expect(action.message).toMatch(/never touch password/i);
      expect(action.message).toMatch(/sign in/i);
    }
  });

  it('SITE_REFUSED ends the run terminally, distinguishing rate-limit copy', () => {
    const action = recover('SITE_REFUSED', ctx({ refusal: { kind: 'rate_limit', evidence: '429' } }));
    expect(action).toMatchObject({ kind: 'end', outcome: 'failed' });
    if (action.kind === 'end') expect(action.message).toMatch(/slow down/i);
  });

  it('NAVIGATION_FAILED retries once, then asks', () => {
    expect(recover('NAVIGATION_FAILED', ctx({ retriesForStep: 0 }))).toEqual({ kind: 'retry', afterSettle: true });
    const second = recover('NAVIGATION_FAILED', ctx({ retriesForStep: 1 }));
    expect(second.kind).toBe('ask');
  });

  it('PARTIAL_EFFECT never returns retry — always approve_retry', () => {
    for (let n = 0; n < 5; n++) {
      const action = recover('PARTIAL_EFFECT', ctx({ retriesForStep: n }));
      expect(action.kind).not.toBe('retry');
      expect(action.kind).toBe('approve_retry');
    }
  });

  it('MODEL_OUTPUT_INVALID ends the run as failed', () => {
    expect(recover('MODEL_OUTPUT_INVALID', ctx())).toMatchObject({ kind: 'end', outcome: 'failed' });
  });

  it('STUCK ends the run with outcome "stuck", distinct from "failed"', () => {
    const action = recover('STUCK', ctx());
    expect(action).toMatchObject({ kind: 'end', outcome: 'stuck' });
  });

  it('TAB_CLOSED ends the run, terminal for that tab', () => {
    expect(recover('TAB_CLOSED', ctx())).toMatchObject({ kind: 'end', outcome: 'failed' });
  });

  it('BACKEND_DETACHED ends the run ([Phase 9] wires the trigger; the arm exists now)', () => {
    expect(recover('BACKEND_DETACHED', ctx())).toMatchObject({ kind: 'end' });
  });

  it('every FailureCause the type declares has an arm (no throw)', () => {
    const causes: FailureCause[] = [
      'STOPPED', 'TARGET_MISSING', 'TARGET_AMBIGUOUS', 'TARGET_DISABLED', 'OBSCURED',
      'NEVER_TIER_AT_ACTUATOR', 'WRITE_REJECTED', 'PARTIAL_EFFECT', 'NOT_SETTLED',
      'AUTH_REQUIRED', 'SITE_REFUSED', 'NAVIGATION_FAILED', 'MODEL_OUTPUT_INVALID',
      'STUCK', 'TAB_CLOSED', 'BACKEND_DETACHED',
    ];
    for (const cause of causes) {
      expect(() => recover(cause, ctx({ overlayDismissed: true, handle: 'e1' }))).not.toThrow();
    }
  });
});

// ── §3.5 SITE_REFUSED detection ──

function snap(overrides: Partial<PerceptionSnapshot> = {}): PerceptionSnapshot {
  return {
    runId: 'r', tabId: 1, epoch: 1, url: 'https://shop.example/', origin: 'https://shop.example',
    title: '', settled: true, settleWaitedMs: 0, settleCalibration: 'visible', epochSuspect: false,
    elements: [], excludedCount: 0, regions: [], unreachableRegions: [], buildMs: 1, ...overrides,
  };
}

describe('detectSiteRefusal (§3.5)', () => {
  it('detects a CAPTCHA from an element name', () => {
    const s = snap({ elements: [{ handle: 'e1', role: 'group', name: 'Please complete the captcha', nameSource: 'content', tag: 'div', enabled: true, visible: true, inViewport: true, actionable: false, sensitiveKind: null, regionId: 'r', ordinal: 0 }] });
    expect(detectSiteRefusal(s, 0)).toMatchObject({ kind: 'captcha' });
  });

  it('detects a rate limit from the page title', () => {
    const s = snap({ title: '429 Too Many Requests' });
    expect(detectSiteRefusal(s, 0)).toMatchObject({ kind: 'rate_limit' });
  });

  it('detects a block page', () => {
    const s = snap({ title: 'Access Denied' });
    expect(detectSiteRefusal(s, 0)).toMatchObject({ kind: 'blocked' });
  });

  it('detects repeated identical refusals only via the caller-supplied count', () => {
    expect(detectSiteRefusal(snap(), 2)).toBeNull();
    expect(detectSiteRefusal(snap(), 3)).toMatchObject({ kind: 'repeated_identical_refusal' });
  });

  it('a clean page is never flagged', () => {
    expect(detectSiteRefusal(snap({ title: 'Shop — Monitors' }), 0)).toBeNull();
  });
});
