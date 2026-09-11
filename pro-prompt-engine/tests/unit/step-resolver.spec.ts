/**
 * lib/agent/step-resolver.ts — plan step + current snapshot → ActionRequest.
 * §8.4. Docs/planning/phase_4_model_tiers_routing.md §8.4, task 4.11.
 *
 * The three-stage deterministic-first ladder: (1) exact handle + matching
 * targetHint resolves with ZERO model calls; (2) exactly one narrowed
 * candidate resolves with ZERO model calls; (3) more than one candidate
 * invokes the judge tier exactly once, and a low-confidence pick is refused
 * rather than guessed.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveStep } from '@lib/agent/step-resolver';
import { CHAINS } from '@lib/model/router';
import type { Engine } from '@lib/model/engine';
import type { PlanStep } from '@lib/schemas/plan.schema';
import type { PerceptionSnapshot, ElementDescriptor } from '@lib/schemas/snapshot.schema';

function el(over: Partial<ElementDescriptor> & { handle: string }): ElementDescriptor {
  return {
    role: 'button', name: 'Submit', nameSource: 'content', tag: 'button',
    enabled: true, visible: true, inViewport: true, actionable: true, sensitiveKind: null,
    regionId: 'region:root', ordinal: 0, ...over,
  };
}

function snapshotWith(elements: ElementDescriptor[]): PerceptionSnapshot {
  return {
    runId: 'r1', tabId: 1, epoch: 3, url: 'https://example.com/', origin: 'https://example.com',
    title: 't', settled: true, settleWaitedMs: 10, settleCalibration: 'visible', epochSuspect: false,
    elements, excludedCount: 0, regions: [], unreachableRegions: [], buildMs: 1,
  };
}

function step(over: Partial<PlanStep> = {}): PlanStep {
  return {
    n: 1, intent: 'Click Submit', action: { verb: 'click', handle: 'e1' }, expectation: 'the form submits',
    targetHint: { role: 'button', name: 'Submit' }, ...over,
  };
}

const ctx = { runId: 1, tabId: 1 };

describe('step-resolver — stage 1: exact handle + matching hint, zero model calls', () => {
  it('resolves immediately when the handle still exists with the same role and name', async () => {
    const judgeInfer = vi.fn();
    const original = CHAINS.judge['local-only'];
    CHAINS.judge['local-only'] = [{ id: 'judge', isRemote: false, infer: judgeInfer }];
    try {
      const snap = snapshotWith([el({ handle: 'e1' })]);
      const res = await resolveStep(step(), snap, 'local-only', ctx);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.action).toEqual({ verb: 'click', handle: 'e1' });
      expect(judgeInfer).not.toHaveBeenCalled();
    } finally { CHAINS.judge['local-only'] = original; }
  });

  it('a step with no handle-bearing verb resolves immediately (no target to resolve)', async () => {
    const snap = snapshotWith([]);
    const res = await resolveStep(step({ action: { verb: 'read_page' } }), snap, 'local-only', ctx);
    expect(res.ok).toBe(true);
  });
});

describe('step-resolver — stage 2: one surviving candidate, zero model calls', () => {
  it('the handle moved (stale), but exactly one candidate matches role+name — resolves without the judge', async () => {
    const judgeInfer = vi.fn();
    const original = CHAINS.judge['local-only'];
    CHAINS.judge['local-only'] = [{ id: 'judge', isRemote: false, infer: judgeInfer }];
    try {
      const snap = snapshotWith([el({ handle: 'e9', name: 'Submit' })]);   // handle changed, name intact
      const res = await resolveStep(step(), snap, 'local-only', ctx);
      expect(res.ok).toBe(true);
      if (res.ok) expect((res.value.action as any).handle).toBe('e9');
      expect(judgeInfer).not.toHaveBeenCalled();
    } finally { CHAINS.judge['local-only'] = original; }
  });

  it('zero candidates after narrowing returns TARGET_MISSING', async () => {
    const snap = snapshotWith([el({ handle: 'e2', role: 'link', name: 'Cancel' })]);
    const res = await resolveStep(step(), snap, 'local-only', ctx);
    expect(res).toEqual({ ok: false, error: 'TARGET_MISSING' });
  });
});

describe('step-resolver — stage 3: multiple candidates, judge invoked exactly once', () => {
  it('picks the judge-confirmed handle when confidence >= 0.7', async () => {
    const infer = vi.fn().mockResolvedValue({ ok: true, value: { content: '{"handle":"e5","confidence":0.9}', constrained: true, latencyMs: 1, engine: 'judge', tier: 'judge' } });
    const original = CHAINS.judge['local-only'];
    CHAINS.judge['local-only'] = [{ id: 'judge', isRemote: false, infer }];
    try {
      const snap = snapshotWith([el({ handle: 'e5', name: 'Submit' }), el({ handle: 'e6', name: 'Submit' })]);
      const res = await resolveStep(step(), snap, 'local-only', ctx);
      expect(infer).toHaveBeenCalledTimes(1);
      expect(res.ok).toBe(true);
      if (res.ok) expect((res.value.action as any).handle).toBe('e5');
    } finally { CHAINS.judge['local-only'] = original; }
  });

  it('a low-confidence judge pick returns TARGET_AMBIGUOUS — asks, never guesses', async () => {
    const infer = vi.fn().mockResolvedValue({ ok: true, value: { content: '{"handle":"e5","confidence":0.4}', constrained: true, latencyMs: 1, engine: 'judge', tier: 'judge' } });
    const original = CHAINS.judge['local-only'];
    CHAINS.judge['local-only'] = [{ id: 'judge', isRemote: false, infer }];
    try {
      const snap = snapshotWith([el({ handle: 'e5', name: 'Submit' }), el({ handle: 'e6', name: 'Submit' })]);
      const res = await resolveStep(step(), snap, 'local-only', ctx);
      expect(res).toEqual({ ok: false, error: 'TARGET_AMBIGUOUS' });
    } finally { CHAINS.judge['local-only'] = original; }
  });

  it('temperature: 0 is used for the judge target call', async () => {
    let seenTemp: number | undefined;
    const infer = vi.fn().mockImplementation(async (req) => {
      seenTemp = req.temperature;
      return { ok: true, value: { content: '{"handle":"e5","confidence":0.9}', constrained: true, latencyMs: 1, engine: 'judge', tier: 'judge' } };
    });
    const original = CHAINS.judge['local-only'];
    CHAINS.judge['local-only'] = [{ id: 'judge', isRemote: false, infer }];
    try {
      const snap = snapshotWith([el({ handle: 'e5', name: 'Submit' }), el({ handle: 'e6', name: 'Submit' })]);
      await resolveStep(step(), snap, 'local-only', ctx);
      expect(seenTemp).toBe(0);
    } finally { CHAINS.judge['local-only'] = original; }
  });
});
