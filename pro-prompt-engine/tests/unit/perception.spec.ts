/**
 * lib/page/perception.ts — the walk: shadow roots, same-origin iframes,
 * unreachable reporting, and the sensitive-field exclusion wired in before
 * any value read. Phase 2 §7.1, tasks 2.7/2.8.
 *
 * A <script> inserted via innerHTML is inert (per the DOM spec), so the
 * structures fixtures/nested.html declares statically are built here
 * programmatically instead — the equivalent DOM shape a real browser
 * loading that file would produce.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildSnapshot } from '@lib/page/perception';
import { ElementRegistry } from '@lib/page/registry';
import type { SettleDetector, SettleResult } from '@lib/page/settle';
import { PerceptionSnapshotSchema } from '@lib/schemas/snapshot.schema';

/** A settle detector that resolves immediately as settled — the walk/region/
 *  prune logic under test here does not depend on real quiet-window timing,
 *  which settle.spec.ts already covers on its own. */
function fakeSettle(overrides: Partial<SettleResult> = {}): SettleDetector {
  const result: SettleResult = {
    settled: true, waitedMs: 0, calibration: 'visible',
    mutations: 0, resourceEntries: 0, suspect: false, ...overrides,
  };
  return { wait: async () => result, stop: () => {} } as unknown as SettleDetector;
}

async function snapshot(opts: Partial<{ region: string; tokenBudget: number }> = {}, settleOverrides?: Partial<SettleResult>) {
  const registry = new ElementRegistry();
  const settle = fakeSettle(settleOverrides);
  const result = await buildSnapshot(registry, settle, {
    runId: 'test-run', tabId: 1, tokenBudget: 6000, ...opts,
  });
  if (!result.ok) throw new Error(`buildSnapshot failed: ${result.reason}`);
  return result.snapshot;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('buildSnapshot — output shape', () => {
  it('produces a schema-valid PerceptionSnapshot', async () => {
    document.body.innerHTML = `<button>Save</button>`;
    const snap = await snapshot();
    expect(() => PerceptionSnapshotSchema.parse(snap)).not.toThrow();
  });

  it('assigns unique, epoch-scoped handles in document order', async () => {
    document.body.innerHTML = `<button>A</button><button>B</button><button>C</button>`;
    const snap = await snapshot();
    expect(snap.elements.map((e) => e.handle)).toEqual(['e0', 'e1', 'e2']);
    expect(snap.elements.map((e) => e.name)).toEqual(['A', 'B', 'C']);
  });
});

describe('buildSnapshot — shadow roots and iframes (§7.1, task 2.7)', () => {
  it('elements from an open shadow root appear with handles', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    btn.textContent = 'Inside open shadow root';
    shadow.appendChild(btn);

    const snap = await snapshot();
    expect(snap.elements.some((e) => e.name === 'Inside open shadow root')).toBe(true);
  });

  it('a closed shadow host contributes shadow:<tag> to unreachableRegions', async () => {
    const closed = document.createElement('x-closed-widget');
    document.body.appendChild(closed);
    closed.attachShadow({ mode: 'closed' });

    const snap = await snapshot();
    expect(snap.unreachableRegions).toContain('shadow:x-closed-widget');
  });

  it('elements from a same-origin (srcdoc) iframe appear with handles', async () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    // happy-dom creates contentDocument synchronously for a plain iframe;
    // write directly into it rather than relying on srcdoc's async parse.
    iframe.contentDocument!.body.innerHTML = '<button>Inside same-origin frame</button>';

    const snap = await snapshot();
    expect(snap.elements.some((e) => e.name === 'Inside same-origin frame')).toBe(true);
  });

  it('a cross-origin iframe contributes iframe:<origin> to unreachableRegions, never treated as empty', async () => {
    const iframe = document.createElement('iframe');
    iframe.src = 'https://other.example/embedded-payment.html';
    // Simulate the cross-origin access restriction happy-dom does not
    // enforce by default: contentDocument throws, exactly as it would in a
    // real browser for a genuinely cross-origin frame.
    Object.defineProperty(iframe, 'contentDocument', {
      get() { throw new DOMException('Blocked a frame with origin from accessing a cross-origin frame.'); },
    });
    document.body.appendChild(iframe);

    const snap = await snapshot();
    expect(snap.unreachableRegions).toContain('iframe:https://other.example');
    expect(snap.unreachableRegions.length).toBeGreaterThan(0);   // never silently empty
  });

  it('an opaque (srcdoc, no resolvable src) unreachable iframe reports iframe:opaque', async () => {
    const iframe = document.createElement('iframe');
    Object.defineProperty(iframe, 'contentDocument', {
      get() { throw new DOMException('blocked'); },
    });
    document.body.appendChild(iframe);

    const snap = await snapshot();
    expect(snap.unreachableRegions).toContain('iframe:opaque');
  });
});

describe('buildSnapshot — sensitive exclusion wired in before any value read (§7.1, task 2.8)', () => {
  it('a password field is excluded: no descriptor, counted once', async () => {
    document.body.innerHTML = `
      <form>
        <input type="password" name="password" value="S3cr3t!">
        <input type="text" name="username" value="alice">
      </form>`;
    const snap = await snapshot();
    expect(snap.excludedCount).toBe(1);
    expect(snap.elements.some((e) => e.tag === 'input' && e.inputType === 'password')).toBe(false);
  });

  it('the excluded field never appears anywhere in the serialised snapshot, including its value', async () => {
    document.body.innerHTML = `<input type="password" name="password" value="S3cr3t-Val-9f2b7c">`;
    const snap = await snapshot();
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain('S3cr3t-Val-9f2b7c');
    expect(serialized).not.toContain('password');
  });

  it('a file input is kept (the one sensitive kind that survives) with actionable:false', async () => {
    document.body.innerHTML = `<input type="file" name="id_upload">`;
    const snap = await snapshot();
    expect(snap.excludedCount).toBe(0);
    const fileEl = snap.elements.find((e) => e.inputType === 'file');
    expect(fileEl).toBeDefined();
    expect(fileEl!.sensitiveKind).toBe('file');
    expect(fileEl!.actionable).toBe(false);
  });

  it('a hidden csrf input is excluded like any other sensitive kind, not surfaced at all', async () => {
    document.body.innerHTML = `<input type="hidden" name="csrf_token" value="abc123">`;
    const snap = await snapshot();
    expect(snap.excludedCount).toBe(1);
    expect(snap.elements.length).toBe(0);
  });
});
