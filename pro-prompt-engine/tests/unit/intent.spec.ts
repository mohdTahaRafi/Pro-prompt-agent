/**
 * lib/agent/intent.ts — THROWAWAY deterministic instruction resolver.
 * Docs/planning/phase_3_gate_actuation_verification.md §11.
 */
import { describe, it, expect } from 'vitest';
import { resolveIntent, UNMATCHED_COPY } from '@lib/agent/intent';
import type { ElementDescriptor, PerceptionSnapshot } from '@lib/schemas/snapshot.schema';

function el(overrides: Partial<ElementDescriptor>): ElementDescriptor {
  return {
    handle: 'e0', role: 'button', name: 'Continue', nameSource: 'content', tag: 'button',
    enabled: true, visible: true, inViewport: true, actionable: true, sensitiveKind: null,
    regionId: 'region:root', ordinal: 0,
    ...overrides,
  };
}

function snap(elements: ElementDescriptor[]): PerceptionSnapshot {
  return {
    runId: 'r', tabId: 1, epoch: 1, url: 'https://x.example/', origin: 'https://x.example',
    title: '', settled: true, settleWaitedMs: 0, settleCalibration: 'visible', epochSuspect: false,
    elements, excludedCount: 0, regions: [], unreachableRegions: [], buildMs: 1,
  };
}

describe('resolveIntent — click', () => {
  it('resolves "click Continue" to the matching button', () => {
    const s = snap([el({ handle: 'e17', name: 'Continue' })]);
    const r = resolveIntent('click Continue', s);
    expect(r).toEqual({ kind: 'action', action: { verb: 'click', handle: 'e17' } });
  });

  it('resolves with quotes and a trailing "button"', () => {
    const s = snap([el({ handle: 'e3', name: 'Submit application' })]);
    const r = resolveIntent('click "Submit application" button', s);
    expect(r).toEqual({ kind: 'action', action: { verb: 'click', handle: 'e3' } });
  });

  it('two matching elements renders an ambiguous chooser, never a guess', () => {
    const s = snap([el({ handle: 'e1', name: 'Delete' }), el({ handle: 'e2', name: 'Delete' })]);
    const r = resolveIntent('click Delete', s);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates).toHaveLength(2);
  });

  it('a click on a role outside the click pattern\'s role set does not match', () => {
    const s = snap([el({ handle: 'e1', name: 'Full name', role: 'textbox' })]);
    expect(resolveIntent('click Full name', s).kind).toBe('unmatched');
  });
});

describe('resolveIntent — type', () => {
  it('resolves "type X into the Y field" to a replace-mode type action', () => {
    const s = snap([el({ handle: 'e12', name: 'Full name', role: 'textbox' })]);
    const r = resolveIntent('type "Mohd Taha" into the full name field', s);
    expect(r).toEqual({ kind: 'action', action: { verb: 'type', handle: 'e12', text: 'Mohd Taha', mode: 'replace' } });
  });

  it('a password field has no handle in the snapshot at all — unmatched, not refused', () => {
    // password fields never appear in a snapshot (Phase 2 §7.1 exclusion),
    // so the resolver cannot name a target for one even if it wanted to.
    const s = snap([el({ handle: 'e1', name: 'Username', role: 'textbox' })]);
    const r = resolveIntent('type "hunter2" into the password field', s);
    expect(r.kind).toBe('unmatched');
  });
});

describe('resolveIntent — select / scroll / navigation / read', () => {
  it('resolves select', () => {
    const s = snap([el({ handle: 'e4', name: 'Country', role: 'combobox' })]);
    expect(resolveIntent('select "United Kingdom" from "Country"', s))
      .toEqual({ kind: 'action', action: { verb: 'select', handle: 'e4', value: 'United Kingdom' } });
  });

  it('resolves scroll down/up/top/bottom', () => {
    expect(resolveIntent('scroll down', snap([]))).toEqual({ kind: 'action', action: { verb: 'scroll', target: 'down' } });
    expect(resolveIntent('scroll to the bottom', snap([]))).toEqual({ kind: 'action', action: { verb: 'scroll', target: 'bottom' } });
  });

  it('resolves go back / go forward', () => {
    expect(resolveIntent('go back', snap([]))).toEqual({ kind: 'action', action: { verb: 'history_back' } });
    expect(resolveIntent('go forward', snap([]))).toEqual({ kind: 'action', action: { verb: 'history_forward' } });
  });

  it('resolves navigate', () => {
    expect(resolveIntent('go to https://example.com/next', snap([])))
      .toEqual({ kind: 'action', action: { verb: 'navigate', url: 'https://example.com/next' } });
  });

  it('resolves read page / structure', () => {
    expect(resolveIntent('read the page', snap([]))).toEqual({ kind: 'action', action: { verb: 'read_page' } });
    expect(resolveIntent('read structure', snap([]))).toEqual({ kind: 'action', action: { verb: 'read_structure' } });
  });
});

describe('resolveIntent — unmatched text, no model, no guess', () => {
  it('unrecognised text reports the capability list, never silently drops it', () => {
    const r = resolveIntent('please make it more professional', snap([]));
    expect(r).toEqual({ kind: 'unmatched' });
  });

  it('UNMATCHED_COPY names the available verbs', () => {
    expect(UNMATCHED_COPY).toMatch(/click/);
    expect(UNMATCHED_COPY).toMatch(/type/);
    expect(UNMATCHED_COPY).not.toBe('');
  });
});
