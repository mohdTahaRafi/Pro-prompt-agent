/**
 * lib/page/settle.ts — the quiet-window detector, both calibrations.
 * Phase 2 §6, task 2.6.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SettleDetector, VISIBLE_QUIET_MS, VISIBLE_CAP_MS,
  HIDDEN_QUIET_MS, HIDDEN_CAP_MS, EPOCH_INVALIDATION_MUTATIONS,
} from '@lib/page/settle';
import { OVERLAY_ROOT_ATTR } from '@lib/page/overlay/mount';

function mutate(times: number, target: Element = document.body) {
  for (let i = 0; i < times; i++) {
    const span = document.createElement('span');
    target.appendChild(span);
    span.remove();
  }
}

describe('SettleDetector — visible calibration', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('a 200ms burst then quiet returns settled:true at ~600ms', async () => {
    const detector = new SettleDetector();
    const root = document.getElementById('root')!;
    const waitPromise = detector.wait();

    // Burst mutations for ~200ms, then go quiet — settle should fire ~400ms
    // (VISIBLE_QUIET_MS) after the LAST mutation, i.e. around 600ms total.
    const burstEnd = Date.now() + 200;
    const interval = setInterval(() => {
      mutate(1, root);
      if (Date.now() >= burstEnd) clearInterval(interval);
    }, 20);

    const result = await waitPromise;
    clearInterval(interval);

    expect(result.settled).toBe(true);
    expect(result.calibration).toBe('visible');
    expect(result.waitedMs).toBeGreaterThanOrEqual(500);
    expect(result.waitedMs).toBeLessThan(VISIBLE_CAP_MS);
    expect(result.mutations).toBeGreaterThan(0);
  }, 10_000);

  it('continuous mutation (100ms interval) never quiets — returns settled:false at the cap', async () => {
    const detector = new SettleDetector();
    const root = document.getElementById('root')!;
    const interval = setInterval(() => mutate(1, root), 100);

    const result = await detector.wait();
    clearInterval(interval);

    expect(result.settled).toBe(false);
    expect(result.waitedMs).toBeGreaterThanOrEqual(VISIBLE_CAP_MS - 100);
    expect(result.calibration).toBe('visible');
  }, 15_000);

  it('a mutation burst above EPOCH_INVALIDATION_MUTATIONS marks the result suspect', async () => {
    const detector = new SettleDetector();
    const root = document.getElementById('root')!;
    // wait()'s synchronous prefix (through mo.observe()) runs before its
    // first `await`, so the observer is attached before this line executes.
    const waitPromise = detector.wait();
    mutate(EPOCH_INVALIDATION_MUTATIONS + 50, root);

    const result = await waitPromise;
    expect(result.suspect).toBe(true);
    expect(result.mutations).toBeGreaterThan(EPOCH_INVALIDATION_MUTATIONS);
  }, 10_000);

  it('a small mutation count (well under the threshold) is not suspect', async () => {
    const detector = new SettleDetector();
    const root = document.getElementById('root')!;
    const waitPromise = detector.wait();
    mutate(10, root);

    const result = await waitPromise;
    expect(result.suspect).toBe(false);
  }, 10_000);

  it('mutations inside our own overlay shadow host do not count as page activity', async () => {
    const detector = new SettleDetector();
    const host = document.createElement('div');
    host.setAttribute(OVERLAY_ROOT_ATTR, '');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const waitPromise = detector.wait();
    // Mutate inside our own shadow tree, repeatedly, well past the quiet
    // window — none of this should ever count or delay settling.
    const interval = setInterval(() => {
      const span = document.createElement('span');
      shadow.appendChild(span);
    }, 20);
    setTimeout(() => clearInterval(interval), 300);

    const result = await waitPromise;
    clearInterval(interval);

    expect(result.settled).toBe(true);
    expect(result.mutations).toBe(0);
  }, 10_000);

  it('stop() causes an in-flight wait to resolve immediately as unsettled', async () => {
    const detector = new SettleDetector();
    const waitPromise = detector.wait();
    setTimeout(() => detector.stop(), 50);
    const result = await waitPromise;
    expect(result.settled).toBe(false);
    expect(result.waitedMs).toBeLessThan(VISIBLE_QUIET_MS);
  }, 10_000);
});

describe('SettleDetector — hidden calibration', () => {
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('document.visibilityState="hidden" selects the 1000ms/15000ms constants', async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    expect(HIDDEN_QUIET_MS).toBe(1_000);
    expect(HIDDEN_CAP_MS).toBe(15_000);

    const detector = new SettleDetector();
    const result = await detector.wait(1_200);   // cap this test's own runtime
    expect(result.calibration).toBe('hidden');
  }, 10_000);
});

describe('SettleDetector — resource entries', () => {
  it('counts completed PerformanceResourceTiming entries as activity', async () => {
    document.body.innerHTML = '';
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });

    let capturedCallback: ((list: any) => void) | null = null;
    const OriginalPO = (globalThis as any).PerformanceObserver;
    class FakePO {
      constructor(cb: (list: any) => void) { capturedCallback = cb; }
      observe() {}
      disconnect() {}
    }
    (globalThis as any).PerformanceObserver = FakePO;

    const detector = new SettleDetector();
    const waitPromise = detector.wait();

    setTimeout(() => {
      capturedCallback?.({
        getEntries: () => [{ responseEnd: 123 }],
      });
    }, 50);

    const result = await waitPromise;
    (globalThis as any).PerformanceObserver = OriginalPO;

    expect(result.resourceEntries).toBe(1);
    expect(result.waitedMs).toBeGreaterThanOrEqual(400);
  }, 10_000);
});
