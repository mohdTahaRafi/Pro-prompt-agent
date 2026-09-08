/**
 * lib/page/overlay/mount.ts — the shared closed-shadow-root host. Phase 2
 * §3.1, task 2.13.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ensureOverlayRoot, getOverlayHost, teardownOverlayRoot, OVERLAY_ROOT_ATTR } from '@lib/page/overlay/mount';

afterEach(() => {
  teardownOverlayRoot();
  document.body.innerHTML = '';
});

describe('ensureOverlayRoot', () => {
  it('creates exactly one host element, appended to documentElement, marked with the overlay attribute', () => {
    const shadow = ensureOverlayRoot();
    expect(shadow).toBeInstanceOf(ShadowRoot);
    const host = getOverlayHost();
    expect(host).not.toBeNull();
    expect(host!.hasAttribute(OVERLAY_ROOT_ATTR)).toBe(true);
    expect(document.documentElement.contains(host!)).toBe(true);
  });

  it('is idempotent — a second call returns the same shadow root, never a second host', () => {
    const first = ensureOverlayRoot();
    const second = ensureOverlayRoot();
    expect(second).toBe(first);
    expect(document.querySelectorAll(`[${OVERLAY_ROOT_ATTR}]`).length).toBe(1);
  });

  it('the host is a closed shadow root — host.shadowRoot is null to page script', () => {
    ensureOverlayRoot();
    const host = getOverlayHost()!;
    expect(host.shadowRoot).toBeNull();
  });
});

describe('teardownOverlayRoot', () => {
  it('removes the host and a subsequent ensureOverlayRoot creates a fresh one', () => {
    const shadow1 = ensureOverlayRoot();
    teardownOverlayRoot();
    expect(getOverlayHost()).toBeNull();
    expect(document.querySelectorAll(`[${OVERLAY_ROOT_ATTR}]`).length).toBe(0);

    const shadow2 = ensureOverlayRoot();
    expect(shadow2).not.toBe(shadow1);
  });
});
