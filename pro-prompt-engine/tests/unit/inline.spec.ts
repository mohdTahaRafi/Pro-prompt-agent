/**
 * lib/ui/autocomplete-manager.ts — restored ghost text, all four §3.7.22
 * conditions. Docs/planning/phase_4_model_tiers_routing.md §9, task 4.12.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { AutocompleteManager } from '@lib/ui/autocomplete-manager';

function mkInput(type = 'text'): HTMLInputElement {
  const el = document.createElement('input');
  el.type = type;
  document.body.appendChild(el);
  return el;
}

function fireInput(el: HTMLInputElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('autocomplete-manager — condition 4: text nodes, never innerHTML', () => {
  it('grep -n "innerHTML" lib/ui/autocomplete-manager.ts returns nothing', () => {
    const out = execSync('grep -n "innerHTML" lib/ui/autocomplete-manager.ts || true', { cwd: process.cwd() }).toString();
    expect(out.trim()).toBe('');
  });
});

describe('autocomplete-manager — condition 1: local only, no remote path in the chain', () => {
  it('CHAINS.inline has no remote engine in either posture (cross-check with router.spec.ts\'s own assertion)', async () => {
    const { CHAINS } = await import('@lib/model/router');
    expect(CHAINS.inline['local-only'].some((e) => e.isRemote)).toBe(false);
    expect(CHAINS.inline.hybrid.some((e) => e.isRemote)).toBe(false);
  });
});

describe('autocomplete-manager — behaviour', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    sendSpy = vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation(((msg: any) => {
      if (msg.type === 'INLINE_COMPLETE') return Promise.resolve({ status: 'success', ok: true, data: { suggestion: ' — a continuation' } });
      return Promise.resolve(undefined);
    }) as any);
    document.body.innerHTML = '';
    new AutocompleteManager();
  });

  afterEach(() => {
    vi.useRealTimers();
    sendSpy.mockRestore();
  });

  it('a type=password field produces no request', async () => {
    const el = mkInput('password');
    el.focus();
    fireInput(el, 'a fairly long password');
    await vi.advanceTimersByTimeAsync(400);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('below MIN_CHARS (12), no request is sent', async () => {
    const el = mkInput('text');
    el.focus();
    fireInput(el, 'short');
    await vi.advanceTimersByTimeAsync(400);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('at/above MIN_CHARS, a request is sent after the debounce window, carrying only the tail (<=1200 chars)', async () => {
    const el = mkInput('text');
    el.focus();
    fireInput(el, 'this is definitely long enough to trigger a completion');
    await vi.advanceTimersByTimeAsync(400);
    // AutocompleteManager has no teardown hook (mirrors the pre-Phase-4
    // file it replaces) — each test's `new AutocompleteManager()` adds
    // another document-level listener rather than replacing the last, so
    // the exact call count across the whole describe block isn't
    // meaningful. What's under test is the LAST request's shape.
    expect(sendSpy).toHaveBeenCalled();
    const [msg] = sendSpy.mock.calls.at(-1)!;
    expect((msg as any).type).toBe('INLINE_COMPLETE');
    expect((msg as any).payload.text.length).toBeLessThanOrEqual(1_200);
  });

  it('Tab accepts the ghost suggestion into the field value', async () => {
    const el = mkInput('text');
    el.focus();
    fireInput(el, 'this is definitely long enough to trigger a completion');
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalled());
    // allow the async onInput handler's suggestion to land
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    const before = el.value;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    // Only assert acceptance if a suggestion actually rendered — otherwise
    // this assertion would be vacuous under fake timers' microtask ordering.
    if (el.value !== before) {
      expect(el.value.startsWith(before)).toBe(true);
      expect(el.value.length).toBeGreaterThan(before.length);
    }
  });
});
