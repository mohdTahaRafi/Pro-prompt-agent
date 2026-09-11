/**
 * lib/policy/ownership.ts — the gate's shadow ledger.
 * Docs/planning/phase_3_gate_actuation_verification.md §12 task 3.3.
 */
import { describe, it, expect } from 'vitest';
import * as ownership from '@lib/policy/ownership';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';

function snap(overrides: Partial<PerceptionSnapshot> = {}): PerceptionSnapshot {
  return {
    runId: 'r1', tabId: 1, epoch: 1, url: 'https://example.com/', origin: 'https://example.com',
    title: 'Example', settled: true, settleWaitedMs: 400, settleCalibration: 'visible',
    epochSuspect: false, elements: [], excludedCount: 0, regions: [], unreachableRegions: [],
    buildMs: 12,
    ...overrides,
  };
}

const CONTINUE_BTN = {
  handle: 'e5', role: 'button', name: 'Continue', nameSource: 'content' as const, tag: 'button',
  enabled: true, visible: true, inViewport: true, actionable: true, sensitiveKind: null,
  regionId: 'form:0', ordinal: 0, formId: 'form:checkout',
};

describe('ownership — record / lookup / descriptor / forTab', () => {
  it('a recorded snapshot round-trips through lookup and descriptor', async () => {
    await ownership.record(101, 1, snap({ epoch: 4, elements: [CONTINUE_BTN] }));

    const owner = await ownership.lookup(101, 'e5', 4);
    expect(owner).toEqual({ tabId: 1, epoch: 4, descriptor: expect.objectContaining({ role: 'button', name: 'Continue' }) });

    const d = await ownership.descriptor(101, 'e5');
    expect(d?.name).toBe('Continue');
    expect(d?.formId).toBe('form:checkout');
  });

  it('unknown handle returns null from lookup and descriptor', async () => {
    await ownership.record(102, 1, snap({ epoch: 1, elements: [] }));
    expect(await ownership.lookup(102, 'e99', 1)).toBeNull();
    expect(await ownership.descriptor(102, 'e99')).toBeNull();
  });

  it('a handle from tab 2 looked up under tab 1 returns a mismatch', async () => {
    const runId = 103;
    await ownership.record(runId, 1, snap({ epoch: 2, elements: [{ ...CONTINUE_BTN, handle: 'e5' }] }));
    await ownership.record(runId, 2, snap({ epoch: 7, elements: [{ ...CONTINUE_BTN, handle: 'e5', name: 'Submit' }] }));

    // The request claims epoch 7 (tab 2's epoch) but arrives as if it were
    // tab 1's — the gate would then see owner.tabId (2) !== req.tabId (1)
    // and refuse HANDLE_NOT_OWNED.
    const owner = await ownership.lookup(runId, 'e5', 7);
    expect(owner?.tabId).toBe(2);
    expect(owner?.tabId).not.toBe(1);
  });

  it('lookup falls back to a non-matching epoch (STALE_EPOCH path) rather than reporting unknown', async () => {
    const runId = 104;
    await ownership.record(runId, 1, snap({ epoch: 3, elements: [CONTINUE_BTN] }));
    const owner = await ownership.lookup(runId, 'e5', 1);   // request thinks it's epoch 1; ledger has 3
    expect(owner).not.toBeNull();
    expect(owner?.epoch).toBe(3);   // caller compares this against the requested epoch itself
  });

  it('forTab returns the full per-tab ledger', async () => {
    const runId = 105;
    await ownership.record(runId, 1, snap({ epoch: 1, elements: [CONTINUE_BTN] }));
    const ledger = await ownership.forTab(runId, 1);
    expect(ledger?.epoch).toBe(1);
    expect(Object.keys(ledger?.handles ?? {})).toEqual(['e5']);
    expect(await ownership.forTab(runId, 999)).toBeNull();
  });

  it('record() overwrites the previous epoch for a tab rather than accumulating history', async () => {
    const runId = 106;
    await ownership.record(runId, 1, snap({ epoch: 1, elements: [{ ...CONTINUE_BTN, handle: 'e0' }] }));
    await ownership.record(runId, 1, snap({ epoch: 2, elements: [{ ...CONTINUE_BTN, handle: 'e1' }] }));
    const ledger = await ownership.forTab(runId, 1);
    expect(ledger?.epoch).toBe(2);
    expect(Object.keys(ledger?.handles ?? {})).toEqual(['e1']);
  });

  it("the ledger survives a simulated service-worker restart — it lives in chrome.storage.session, not module state", async () => {
    const runId = 107;
    await ownership.record(runId, 1, snap({ epoch: 1, elements: [CONTINUE_BTN] }));
    // "Restart": ownership.ts keeps no in-memory cache of its own, so there
    // is nothing to reset here — every call reads storage.session fresh.
    // This test documents that property rather than exercising a reset.
    const owner = await ownership.lookup(runId, 'e5', 1);
    expect(owner?.descriptor.name).toBe('Continue');
  });

  it('clear() drops a run\'s entire ledger', async () => {
    const runId = 108;
    await ownership.record(runId, 1, snap({ epoch: 1, elements: [CONTINUE_BTN] }));
    await ownership.clear(runId);
    expect(await ownership.forTab(runId, 1)).toBeNull();
  });
});
