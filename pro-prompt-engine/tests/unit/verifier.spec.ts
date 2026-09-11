/**
 * lib/page/verifier.ts — the six deterministic verification kinds.
 * Docs/planning/phase_3_gate_actuation_verification.md §12 task 3.10.
 *
 * A `pre` snapshot that claims to hold the same handle the action names
 * is required in every test below where the verifier needs to find "the
 * same element" in `post` — handles are NOT stable across epochs
 * (lib/page/registry.ts resets its counter on every beginEpoch()), so
 * lib/page/verifier.ts's correspondingElement() anchors its post-snapshot
 * search on the pre-snapshot's descriptor for that handle (role, name,
 * formId), never on the handle string alone. A `pre` with an empty
 * `elements` array is a legitimate "nothing there yet" state, but it means
 * there is nothing to anchor a match to — used deliberately below to prove
 * that case falls back to 'unconfirmed' rather than a false match.
 */
import { describe, it, expect } from 'vitest';
import { verify } from '@lib/page/verifier';
import type { ActEffect } from '@lib/actuation/backend';
import type { ElementDescriptor, PerceptionSnapshot } from '@lib/schemas/snapshot.schema';

function el(overrides: Partial<ElementDescriptor> = {}): ElementDescriptor {
  return {
    handle: 'e1', role: 'textbox', name: 'Full name', nameSource: 'label', tag: 'input',
    enabled: true, visible: true, inViewport: true, actionable: true, sensitiveKind: null,
    regionId: 'form:0', ordinal: 0,
    ...overrides,
  };
}

function snap(overrides: Partial<PerceptionSnapshot> = {}): PerceptionSnapshot {
  return {
    runId: 'r', tabId: 1, epoch: 1, url: 'https://x.example/', origin: 'https://x.example',
    title: '', settled: true, settleWaitedMs: 100, settleCalibration: 'visible', epochSuspect: false,
    elements: [], excludedCount: 0, regions: [], unreachableRegions: [], buildMs: 1,
    ...overrides,
  };
}

function effect(overrides: Partial<ActEffect> = {}): ActEffect {
  return { dispatched: true, elapsedMs: 5, ...overrides };
}

describe('verify — type (state check)', () => {
  it('confirms when the field now holds the intended value and the page settled', async () => {
    const pre = snap({ elements: [el({ valueShape: 'empty' })] });
    const post = snap({ elements: [el({ valueShape: 'Mohd Taha' })], settled: true });
    const r = await verify({ verb: 'type', handle: 'e1', text: 'Mohd Taha', mode: 'replace' }, effect(), post, pre);
    expect(r).toEqual({ verified: 'confirmed', check: 'state', evidence: { before: undefined, after: 'Mohd Taha' } });
  });

  it('downgrades confirmed to unconfirmed when the post-snapshot never settled', async () => {
    const pre = snap({ elements: [el({ valueShape: 'empty' })] });
    const post = snap({ elements: [el({ valueShape: 'Mohd Taha' })], settled: false });
    const r = await verify({ verb: 'type', handle: 'e1', text: 'Mohd Taha', mode: 'replace' }, effect(), post, pre);
    expect(r.verified).toBe('unconfirmed');
    expect(r.check).toBe('state');
  });

  it('fails with WRITE_REJECTED when the read-back does not match', async () => {
    const pre = snap({ elements: [el({ valueShape: 'empty' })] });
    const post = snap({ elements: [el({ valueShape: 'something else' })] });
    const r = await verify({ verb: 'type', handle: 'e1', text: 'Mohd Taha', mode: 'replace' }, effect(), post, pre);
    expect(r).toMatchObject({ verified: 'failed', check: 'state', failureCause: 'WRITE_REJECTED' });
  });

  it('fails immediately when the actuator reported focusFailed, without reading state', async () => {
    const pre = snap({ elements: [el({ valueShape: 'empty' })] });
    const post = snap({ elements: [el({ valueShape: 'Mohd Taha' })] });
    const r = await verify({ verb: 'type', handle: 'e1', text: 'Mohd Taha', mode: 'replace' }, effect({ focusFailed: true }), post, pre);
    expect(r).toMatchObject({ verified: 'failed', failureCause: 'WRITE_REJECTED' });
  });

  it('unconfirmed when the target existed before but has no counterpart in post at all', async () => {
    const pre = snap({ elements: [el({ valueShape: 'empty' })] });
    const post = snap({ elements: [] });
    const r = await verify({ verb: 'type', handle: 'e1', text: 'x', mode: 'replace' }, effect(), post, pre);
    expect(r.verified).toBe('unconfirmed');
  });

  it('unconfirmed when pre never had the handle at all — nothing to anchor a match to', async () => {
    const r = await verify({ verb: 'type', handle: 'e1', text: 'x', mode: 'replace' }, effect(), snap({ elements: [el()] }), snap({ elements: [] }));
    expect(r.verified).toBe('unconfirmed');
  });

  it('numeric inputs match after Number() coercion even when the string differs', async () => {
    const pre = snap({ elements: [el({ inputType: 'number', valueShape: 'empty' })] });
    const post = snap({ elements: [el({ inputType: 'number', valueShape: '7' })] });
    const r = await verify({ verb: 'type', handle: 'e1', text: '7.0', mode: 'replace' }, effect(), post, pre);
    expect(r.verified).toBe('confirmed');
  });

  it('a validation message appearing in the SAME form fails as PARTIAL_EFFECT', async () => {
    const target = el({ valueShape: 'empty', formId: 'form:1' });
    const pre = snap({ elements: [target] });
    const post = snap({
      elements: [
        { ...target, valueShape: 'x' },
        el({ handle: 'e2', role: 'alert', name: 'This field is required', formId: 'form:1' }),
      ],
    });
    const r = await verify({ verb: 'type', handle: 'e1', text: 'x', mode: 'replace' }, effect(), post, pre);
    expect(r).toMatchObject({ verified: 'failed', check: 'negative', failureCause: 'PARTIAL_EFFECT' });
  });

  it('a role=alert elsewhere on the page (different form) does NOT fire the negative check', async () => {
    const target = el({ valueShape: 'empty', formId: 'form:1' });
    const pre = snap({ elements: [target] });
    const post = snap({
      elements: [
        { ...target, valueShape: 'x' },
        el({ handle: 'e2', role: 'alert', name: 'Unrelated banner', formId: 'form:OTHER' }),
      ],
    });
    const r = await verify({ verb: 'type', handle: 'e1', text: 'x', mode: 'replace' }, effect(), post, pre);
    expect(r.verified).toBe('confirmed');
  });
});

describe('verify — select', () => {
  const combo = el({ role: 'combobox' });

  it('confirms when the observed text matches the requested value', async () => {
    const pre = snap({ elements: [{ ...combo, valueShape: 'United States' }] });
    const post = snap({ elements: [{ ...combo, valueShape: 'United Kingdom' }] });
    const r = await verify({ verb: 'select', handle: 'e1', value: 'United Kingdom' }, effect({ preState: 'United States' }), post, pre);
    expect(r.verified).toBe('confirmed');
    expect(r.check).toBe('state');
  });

  it('unconfirmed (not failed) when the value changed but does not textually match — label vs value mismatch', async () => {
    const pre = snap({ elements: [{ ...combo, valueShape: 'United States' }] });
    const post = snap({ elements: [{ ...combo, valueShape: 'United Kingdom' }] });
    const r = await verify({ verb: 'select', handle: 'e1', value: 'uk' }, effect({ preState: 'United States' }), post, pre);
    expect(r.verified).toBe('unconfirmed');
  });

  it('fails when nothing changed at all', async () => {
    const pre = snap({ elements: [{ ...combo, valueShape: 'United States' }] });
    const post = snap({ elements: [{ ...combo, valueShape: 'United States' }] });
    const r = await verify({ verb: 'select', handle: 'e1', value: 'United Kingdom' }, effect({ preState: 'United States' }), post, pre);
    expect(r).toMatchObject({ verified: 'failed', failureCause: 'WRITE_REJECTED' });
  });
});

describe('verify — click', () => {
  it('confirms via location when the URL changed', async () => {
    const pre = snap({ url: 'https://x.example/', origin: 'https://x.example' });
    const post = snap({ url: 'https://x.example/step-2', origin: 'https://x.example', elements: [] });
    const r = await verify({ verb: 'click', handle: 'e1' }, effect(), post, pre);
    expect(r).toMatchObject({ verified: 'confirmed', check: 'location' });
  });

  it('confirms via disappearance when a dismiss-target click removes the clicked element', async () => {
    const pre = snap({ elements: [el({ role: 'button', name: 'Close' })] });
    const post = snap({ elements: [] });
    const r = await verify({ verb: 'click', handle: 'e1' }, effect(), post, pre);
    expect(r).toMatchObject({ verified: 'confirmed', check: 'disappearance' });
  });

  it('confirms via count when a repeating region grows', async () => {
    const pre = snap({ regions: [{ regionId: 'repeat:x', label: 'items', complete: true, shown: 10, total: 10 }] });
    const post = snap({ regions: [{ regionId: 'repeat:x', label: 'items', complete: true, shown: 20, total: 20 }] });
    const r = await verify({ verb: 'click', handle: 'e1' }, effect(), post, pre);
    expect(r).toMatchObject({ verified: 'confirmed', check: 'count' });
  });

  it('THE FALSE-CONFIRMATION GATE: a swallowed submit click never reads as confirmed', async () => {
    // Nothing observably changed: same URL, target still present (matched
    // by role+name+form across the two epochs), no new alert, no region
    // growth.
    const preTarget = el({ role: 'button', name: 'Submit application', inputType: 'submit' });
    const postTarget = { ...preTarget };
    const pre = snap({ url: 'https://x.example/apply', elements: [preTarget] });
    const post = snap({ url: 'https://x.example/apply', elements: [postTarget] });
    const r = await verify({ verb: 'click', handle: 'e1' }, effect(), post, pre);
    expect(r.verified).not.toBe('confirmed');
  });

  it('a new validation error inside the target\'s form fails the click', async () => {
    const preTarget = el({ formId: 'form:1' });
    const pre = snap({ elements: [preTarget] });
    const post = snap({
      elements: [{ ...preTarget }, el({ handle: 'e2', role: 'alert', name: 'Please enter a value', formId: 'form:1' })],
    });
    const r = await verify({ verb: 'click', handle: 'e1' }, effect(), post, pre);
    expect(r).toMatchObject({ verified: 'failed', check: 'negative' });
  });
});

describe('verify — navigate / history', () => {
  it('navigate confirms when the origin matches the requested URL', async () => {
    const pre = snap({ url: 'https://x.example/', origin: 'https://x.example' });
    const post = snap({ url: 'https://x.example/next', origin: 'https://x.example' });
    const r = await verify({ verb: 'navigate', url: 'https://x.example/next' }, effect(), post, pre);
    expect(r).toMatchObject({ verified: 'confirmed', check: 'location' });
  });

  it('navigate fails when the URL never changed', async () => {
    const pre = snap({ url: 'https://x.example/' });
    const post = snap({ url: 'https://x.example/' });
    const r = await verify({ verb: 'navigate', url: 'https://x.example/next' }, effect(), post, pre);
    expect(r).toMatchObject({ verified: 'failed', check: 'location', failureCause: 'PARTIAL_EFFECT' });
  });

  it('history_back confirms on a URL change and fails when nothing moved', async () => {
    const pre = snap({ url: 'https://x.example/b' });
    const okPost = snap({ url: 'https://x.example/a' });
    expect((await verify({ verb: 'history_back' }, effect(), okPost, pre)).verified).toBe('confirmed');
    const stuckPost = snap({ url: 'https://x.example/b' });
    expect((await verify({ verb: 'history_back' }, effect(), stuckPost, pre)).verified).toBe('failed');
  });
});

describe('verify — scroll', () => {
  it('confirms a handle-target scroll once the element reports inViewport', async () => {
    const pre = snap({ elements: [el({ inViewport: false })] });
    const post = snap({ elements: [el({ inViewport: true })] });
    const r = await verify({ verb: 'scroll', target: 'e1' }, effect(), post, pre);
    expect(r).toMatchObject({ verified: 'confirmed', check: 'appearance' });
  });

  it('a direction scroll is unconfirmed with no repeat-region growth to measure', async () => {
    const r = await verify({ verb: 'scroll', target: 'down' }, effect(), snap(), snap());
    expect(r).toMatchObject({ verified: 'unconfirmed', check: 'count' });
  });
});

describe('verify — semantic/traceability are not implemented this phase', () => {
  it('an unrecognised verb path returns unconfirmed, never a fabricated confirmed', async () => {
    const r = await verify({ verb: 'read_page' } as any, effect(), snap(), snap());
    expect(r.verified).toBe('unconfirmed');
  });
});
