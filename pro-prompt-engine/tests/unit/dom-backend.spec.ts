/**
 * lib/actuation/backend.ts + dom-backend.ts + cdp-backend.ts.
 * Docs/planning/phase_3_gate_actuation_verification.md §12 task 3.6.
 *
 * Not part of vitest.config.ts's coverage-tracked set — lib/actuation is
 * the runtime glue between the gate and the real chrome.tabs APIs, not a
 * safety property the way lib/policy and lib/page are — but task 3.6's
 * acceptance criterion is specific enough to deserve a
 * direct test: dom-backend.act() on a tab with no content script returns
 * Err('TARGET_MISSING'), never throws. tests/setup.ts's chrome.tabs.sendMessage
 * double always resolves undefined (no listener ever answers it), which is
 * exactly "no content script" from the caller's point of view.
 */
import { describe, it, expect } from 'vitest';
import { domBackend } from '@lib/actuation/dom-backend';
import { cdpBackend } from '@lib/actuation/cdp-backend';

describe('dom-backend', () => {
  it('act() on a tab with no content script returns Err(TARGET_MISSING), never throws', async () => {
    await expect(domBackend.act(1, 1, { verb: 'click', handle: 'e0' }, 1)).resolves.toEqual({
      ok: false, error: 'TARGET_MISSING',
    });
  });

  it('perceive() on a tab with no content script returns Err(TARGET_MISSING), never throws', async () => {
    await expect(domBackend.perceive(1, 1, {})).resolves.toEqual({ ok: false, error: 'TARGET_MISSING' });
  });

  it('attach() is a no-op success; detach() resolves; capture() is Err(NOT_IMPLEMENTED) — Phase 10', async () => {
    await expect(domBackend.attach(1)).resolves.toEqual({ ok: true, value: undefined });
    await expect(domBackend.detach(1)).resolves.toBeUndefined();
    await expect(domBackend.capture(1)).resolves.toEqual({ ok: false, error: 'NOT_IMPLEMENTED' });
  });

  it('kind is "dom"', () => {
    expect(domBackend.kind).toBe('dom');
  });
});

describe('cdp-backend — Phase 9 stub', () => {
  it('every method throws NOT_IMPLEMENTED; the interface still compiles against it', async () => {
    expect(cdpBackend.kind).toBe('cdp');
    await expect(cdpBackend.attach(1)).rejects.toThrow('NOT_IMPLEMENTED');
    await expect(cdpBackend.detach(1)).rejects.toThrow('NOT_IMPLEMENTED');
    await expect(cdpBackend.perceive(1, 1, {})).rejects.toThrow('NOT_IMPLEMENTED');
    await expect(cdpBackend.act(1, 1, { verb: 'click', handle: 'e0' }, 1)).rejects.toThrow('NOT_IMPLEMENTED');
    await expect(cdpBackend.capture(1)).rejects.toThrow('NOT_IMPLEMENTED');
  });
});
