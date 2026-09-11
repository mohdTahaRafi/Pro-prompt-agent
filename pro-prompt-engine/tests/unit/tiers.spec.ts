/**
 * lib/policy/tiers.ts — classifyTier / classifyClick / hasUnsavedUserInput.
 * Docs/planning/phase_3_gate_actuation_verification.md §12 task 3.4.
 *
 * Every row of §5 is covered in both directions: each input yields the
 * stated tier, and a near-miss input does NOT accidentally yield it too.
 */
import { describe, it, expect } from 'vitest';
import { classifyTier, classifyClick, hasUnsavedUserInput } from '@lib/policy/tiers';
import * as ownership from '@lib/policy/ownership';
import * as journal from '@lib/agent/journal';
import type { LedgerDescriptor } from '@lib/types/agent.types';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';

const ORIGIN = 'https://shop.example.com';
const GOV_ORIGIN = 'https://www.gov.uk';

function target(overrides: Partial<LedgerDescriptor> = {}): LedgerDescriptor {
  return { role: 'button', name: 'Continue', ordinal: 0, actionable: true, sensitiveKind: null, ...overrides };
}

describe('classifyTier — NEVER, first and unconditionally', () => {
  it('a password/payment/otp target is never, whatever the verb', () => {
    for (const kind of ['password', 'payment', 'otp'] as const) {
      const t = target({ sensitiveKind: kind, inputType: 'text' });
      expect(classifyTier({ verb: 'type', handle: 'e1', text: 'x', mode: 'replace' }, t, ORIGIN)).toBe('never');
      expect(classifyTier({ verb: 'click', handle: 'e1' }, t, ORIGIN)).toBe('never');
    }
  });

  it('a file/hidden/null-kind target is never classified never by sensitivity alone', () => {
    for (const kind of ['file', 'hidden', null] as const) {
      const t = target({ sensitiveKind: kind });
      expect(classifyTier({ verb: 'click', handle: 'e1' }, t, ORIGIN)).not.toBe('never');
    }
  });
});

describe('classifyTier — perception and scroll are always low', () => {
  const low = [
    { verb: 'read_page' as const },
    { verb: 'read_structure' as const },
    { verb: 'read_element' as const, handle: 'e1' },
    { verb: 'wait_for_settle' as const },
    { verb: 'scroll' as const, target: 'down' as const },
  ];
  for (const action of low) {
    it(`${action.verb} is low`, () => {
      expect(classifyTier(action, null, ORIGIN)).toBe('low');
    });
  }
});

describe('classifyTier — type', () => {
  it('replacing a filled field is medium', () => {
    const t = target({ inputType: 'text', valueShape: 'existing text' });
    expect(classifyTier({ verb: 'type', handle: 'e1', text: 'new', mode: 'replace' }, t, ORIGIN)).toBe('medium');
  });
  it('replacing an EMPTY field is low, not medium', () => {
    const t = target({ inputType: 'text', valueShape: 'empty' });
    expect(classifyTier({ verb: 'type', handle: 'e1', text: 'new', mode: 'replace' }, t, ORIGIN)).toBe('low');
  });
  it('appending is low even to a filled field', () => {
    const t = target({ inputType: 'text', valueShape: 'existing text' });
    expect(classifyTier({ verb: 'type', handle: 'e1', text: 'new', mode: 'append' }, t, ORIGIN)).toBe('low');
  });
  it('a sensitive-origin type is always, regardless of fill state', () => {
    const t = target({ inputType: 'text', valueShape: 'empty' });
    expect(classifyTier({ verb: 'type', handle: 'e1', text: 'x', mode: 'replace' }, t, GOV_ORIGIN)).toBe('always');
  });
});

describe('classifyTier — select / navigate / history', () => {
  it('select is medium off a sensitive origin', () => {
    expect(classifyTier({ verb: 'select', handle: 'e1', value: 'x' }, target(), ORIGIN)).toBe('medium');
  });
  it('select is always on a sensitive origin', () => {
    expect(classifyTier({ verb: 'select', handle: 'e1', value: 'x' }, target(), GOV_ORIGIN)).toBe('always');
  });
  it('navigate is medium (unsaved-input escalation is the gate\'s job, not classifyTier\'s)', () => {
    expect(classifyTier({ verb: 'navigate', url: 'https://example.com' }, null, ORIGIN)).toBe('medium');
    expect(classifyTier({ verb: 'navigate', url: 'https://example.com' }, null, GOV_ORIGIN)).toBe('medium');
  });
  it('history_back / history_forward are always medium, not escalated by origin', () => {
    expect(classifyTier({ verb: 'history_back' }, null, GOV_ORIGIN)).toBe('medium');
    expect(classifyTier({ verb: 'history_forward' }, null, GOV_ORIGIN)).toBe('medium');
  });
});

describe('classifyClick — §5.2, the whole difficulty in one function', () => {
  it('unknown target (null) is medium, never low', () => {
    expect(classifyClick(null, ORIGIN)).toBe('medium');
  });

  it('a submit-type input is always, whatever it is named', () => {
    expect(classifyClick(target({ inputType: 'submit', name: 'Continue' }), ORIGIN)).toBe('always');
  });
  it('an image-type input is always', () => {
    expect(classifyClick(target({ inputType: 'image', name: 'Go' }), ORIGIN)).toBe('always');
  });
  it('a plain non-submit button named "Continue" in a form is NOT always by structure alone', () => {
    expect(classifyClick(target({ inputType: 'button', name: 'Continue', formId: 'f1' }), ORIGIN)).toBe('low');
  });

  const alwaysNames = ['Submit', 'Send message', 'Buy now', 'Place Order', 'Delete account', 'Cancel subscription', 'Share', 'Reply', 'Apply now', 'Donate'];
  for (const name of alwaysNames) {
    it(`a click named "${name}" is always (name-based)`, () => {
      expect(classifyClick(target({ inputType: 'button', name }), ORIGIN)).toBe('always');
    });
  }

  it('a click named "Continue" is NOT always — it is not in ALWAYS_NAME_RE', () => {
    expect(classifyClick(target({ inputType: 'button', name: 'Continue' }), ORIGIN)).toBe('low');
  });

  it('any click on a sensitive origin is always, even an innocuous name', () => {
    expect(classifyClick(target({ inputType: 'button', name: 'Filter' }), GOV_ORIGIN)).toBe('always');
  });
  it('the same innocuous name off a sensitive origin is low', () => {
    expect(classifyClick(target({ inputType: 'button', name: 'Filter' }), ORIGIN)).toBe('low');
  });

  it('a link leaving the origin is medium', () => {
    expect(classifyClick(target({ role: 'link', name: 'Docs', href: 'https://other.example/docs' }), ORIGIN)).toBe('medium');
  });
  it('a link staying on the same origin is low, not medium', () => {
    expect(classifyClick(target({ role: 'link', name: 'About', href: `${ORIGIN}/about` }), ORIGIN)).toBe('low');
  });

  it('a disclosure toggle / filter / tab with no special name is low', () => {
    expect(classifyClick(target({ role: 'tab', name: 'Details' }), ORIGIN)).toBe('low');
  });
});

describe('hasUnsavedUserInput — §5.3, driven by the journal, not a heuristic', () => {
  function snap(elements: PerceptionSnapshot['elements'] = []): PerceptionSnapshot {
    return {
      runId: 'r', tabId: 1, epoch: 1, url: 'https://x.example/', origin: 'https://x.example',
      title: '', settled: true, settleWaitedMs: 0, settleCalibration: 'visible', epochSuspect: false,
      elements, excludedCount: 0, regions: [], unreachableRegions: [], buildMs: 1,
    };
  }
  const FIELD = {
    handle: 'e1', role: 'textbox', name: 'Name', nameSource: 'label' as const, tag: 'input',
    inputType: 'text', valueShape: 'John', enabled: true, visible: true, inViewport: true,
    actionable: true, sensitiveKind: null, regionId: 'form:0', ordinal: 0,
  };

  it('false when the ledger has nothing recorded for the tab', async () => {
    expect(await hasUnsavedUserInput(9001, 1)).toBe(false);
  });

  it('true when a filled text field exists that this run never wrote', async () => {
    await ownership.record(9002, 1, snap([FIELD]));
    expect(await hasUnsavedUserInput(9002, 1)).toBe(true);
  });

  it('false when the only filled field is empty', async () => {
    await ownership.record(9003, 1, snap([{ ...FIELD, valueShape: 'empty' }]));
    expect(await hasUnsavedUserInput(9003, 1)).toBe(false);
  });

  it('false when THIS run wrote the value itself (journaled action.observed)', async () => {
    const runId = 9004;
    await ownership.record(runId, 1, snap([FIELD]));
    await journal.append(runId, 'action.observed', 1, { verb: 'type', handle: 'e1' });
    expect(await hasUnsavedUserInput(runId, 1)).toBe(false);
  });

  it('true when a DIFFERENT handle was written but this one was not', async () => {
    const runId = 9005;
    await ownership.record(runId, 1, snap([FIELD]));
    await journal.append(runId, 'action.observed', 1, { verb: 'type', handle: 'e2' });
    expect(await hasUnsavedUserInput(runId, 1)).toBe(true);
  });
});
