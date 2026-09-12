/**
 * lib/model/offscreen-bridge.ts's ensureOffscreen() — the readiness race
 * fixed by the 2026-09-13 Phase 5 acceptance audit (see that file's header
 * for the full real-Chrome repro: task 5.17's form-fill.spec.ts hung
 * forever in `state: 'planning'` because RUN_ADMITTED was sent — and
 * silently dropped by lib/agent/reconcile.ts's askOffscreen() — before the
 * offscreen document's chrome.runtime.onMessage listener had registered).
 *
 * tests/setup.ts's runtime double answers HEARTBEAT_PING as a last-resort
 * default (`offscreenReady`, true unless a test says otherwise) so every
 * OTHER test that calls ensureOffscreen()/askOffscreen() in passing doesn't
 * need to know this ping exists. These tests flip that flag directly to
 * simulate the exact "document exists but its listener isn't live yet"
 * window this fix retries through.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ensureOffscreen, __resetOffscreenBridgeState } from '@lib/model/offscreen-bridge';

function setOffscreenReady(v: boolean) {
  (chrome.runtime as any).__setOffscreenReady(v);
}

beforeEach(() => {
  __resetOffscreenBridgeState();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ensureOffscreen — readiness race (2026-09-13 audit)', () => {
  it('retries HEARTBEAT_PING until the listener is actually live, then resolves', async () => {
    setOffscreenReady(false);
    const p = ensureOffscreen();

    // Still not ready after a couple of retries.
    await vi.advanceTimersByTimeAsync(200);
    setOffscreenReady(true);   // the document "finishes loading" mid-retry
    await vi.advanceTimersByTimeAsync(500);

    await expect(p).resolves.toBeUndefined();
  });

  it('throws if the document never becomes ready within the timeout', async () => {
    setOffscreenReady(false);
    const p = ensureOffscreen();
    const assertion = expect(p).rejects.toThrow(/did not become ready/);
    await vi.advanceTimersByTimeAsync(16_000);
    await assertion;
  });

  it('a second call, once confirmed ready, does not re-ping (cache hit)', async () => {
    setOffscreenReady(true);
    const sendMessage = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
    sendMessage.mockClear();

    await ensureOffscreen();
    const callsAfterFirst = sendMessage.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await ensureOffscreen();
    expect(sendMessage.mock.calls.length).toBe(callsAfterFirst);   // no second round trip
  });

  it('concurrent callers during creation all await the SAME readiness check, not one each', async () => {
    setOffscreenReady(false);
    const [p1, p2, p3] = [ensureOffscreen(), ensureOffscreen(), ensureOffscreen()];
    await vi.advanceTimersByTimeAsync(200);
    setOffscreenReady(true);
    await vi.advanceTimersByTimeAsync(500);
    await expect(Promise.all([p1, p2, p3])).resolves.toBeDefined();

    const createDocument = chrome.offscreen.createDocument as ReturnType<typeof vi.fn>;
    expect(createDocument).toHaveBeenCalledTimes(1);   // one creation, not three
  });
});
