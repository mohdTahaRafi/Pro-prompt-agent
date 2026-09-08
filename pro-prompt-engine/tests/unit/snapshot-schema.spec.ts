/**
 * lib/schemas/snapshot.schema.ts — the perception message contract (§3.3)
 * and the PerceptionSnapshot shape (§7.6). Task 2.11: an intentionally
 * malformed snapshot is rejected at the content-script boundary with
 * INVALID_SNAPSHOT, never partially delivered.
 */
import { describe, it, expect } from 'vitest';
import {
  PerceptionRequest, HandleSchema, PerceptionSnapshotSchema, ElementDescriptorSchema,
} from '@lib/schemas/snapshot.schema';

describe('HandleSchema', () => {
  it('accepts e0, e12, e999', () => {
    for (const h of ['e0', 'e12', 'e999']) expect(HandleSchema.safeParse(h).success).toBe(true);
  });
  it('rejects a selector, an id, or a malformed handle', () => {
    for (const bad of ['#submit-btn', 'e', 'E1', 'e1x', '1', '']) {
      expect(HandleSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('PerceptionRequest — the four verbs (§3.3)', () => {
  it('accepts a well-formed PERCEIVE_STRUCTURE and defaults tokenBudget to 6000', () => {
    const result = PerceptionRequest.safeParse({ type: 'PERCEIVE_STRUCTURE', runId: 'r1' });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'PERCEIVE_STRUCTURE') {
      expect(result.data.tokenBudget).toBe(6000);
    }
  });

  it('rejects a tokenBudget outside [500, 12000]', () => {
    expect(PerceptionRequest.safeParse({ type: 'PERCEIVE_STRUCTURE', runId: 'r1', tokenBudget: 100 }).success).toBe(false);
    expect(PerceptionRequest.safeParse({ type: 'PERCEIVE_STRUCTURE', runId: 'r1', tokenBudget: 20000 }).success).toBe(false);
  });

  it('accepts PERCEIVE_ELEMENT only with a valid handle', () => {
    expect(PerceptionRequest.safeParse({ type: 'PERCEIVE_ELEMENT', runId: 'r1', handle: 'e5' }).success).toBe(true);
    expect(PerceptionRequest.safeParse({ type: 'PERCEIVE_ELEMENT', runId: 'r1', handle: '#foo' }).success).toBe(false);
  });

  it('accepts PERCEIVE_PAGE with just a runId', () => {
    expect(PerceptionRequest.safeParse({ type: 'PERCEIVE_PAGE', runId: 'r1' }).success).toBe(true);
  });

  it('accepts WAIT_FOR_SETTLE with an optional maxMs in [100, 15000]', () => {
    expect(PerceptionRequest.safeParse({ type: 'WAIT_FOR_SETTLE', runId: 'r1' }).success).toBe(true);
    expect(PerceptionRequest.safeParse({ type: 'WAIT_FOR_SETTLE', runId: 'r1', maxMs: 2000 }).success).toBe(true);
    expect(PerceptionRequest.safeParse({ type: 'WAIT_FOR_SETTLE', runId: 'r1', maxMs: 50 }).success).toBe(false);
  });

  it('rejects an unrecognised type entirely — not ours, per agent.content.ts\'s safeParse gate', () => {
    expect(PerceptionRequest.safeParse({ type: 'PING' }).success).toBe(false);
  });
});

describe('PerceptionSnapshotSchema — task 2.11, rejected at the boundary', () => {
  function validSnapshot() {
    return {
      runId: 'r1', tabId: 1, epoch: 1, url: 'https://example.com/', origin: 'https://example.com',
      title: 'Example', settled: true, settleWaitedMs: 400, settleCalibration: 'visible',
      epochSuspect: false, elements: [], excludedCount: 0, regions: [], unreachableRegions: [],
      buildMs: 12,
    };
  }

  it('accepts a well-formed empty snapshot', () => {
    expect(PerceptionSnapshotSchema.safeParse(validSnapshot()).success).toBe(true);
  });

  it('rejects a snapshot with epoch 0 or negative (epoch is positive per §4.2)', () => {
    expect(PerceptionSnapshotSchema.safeParse({ ...validSnapshot(), epoch: 0 }).success).toBe(false);
    expect(PerceptionSnapshotSchema.safeParse({ ...validSnapshot(), epoch: -1 }).success).toBe(false);
  });

  it('rejects a snapshot whose origin carries a path (must be a bare origin)', () => {
    expect(PerceptionSnapshotSchema.safeParse({ ...validSnapshot(), origin: 'https://example.com/x' }).success).toBe(false);
  });

  it('rejects a snapshot with a malformed element descriptor rather than delivering it partially', () => {
    const bad = {
      ...validSnapshot(),
      elements: [{ handle: 'not-a-handle', role: 'button', name: 'Save', nameSource: 'native',
        tag: 'button', enabled: true, visible: true, inViewport: true, actionable: true,
        sensitiveKind: null, regionId: 'region:root', ordinal: 0 }],
    };
    const result = PerceptionSnapshotSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects a snapshot missing a required field entirely', () => {
    const { settled, ...missingSettled } = validSnapshot();
    expect(PerceptionSnapshotSchema.safeParse(missingSettled).success).toBe(false);
  });

  it('rejects settleCalibration outside the two known values', () => {
    expect(PerceptionSnapshotSchema.safeParse({ ...validSnapshot(), settleCalibration: 'background' }).success).toBe(false);
  });
});

describe('ElementDescriptorSchema', () => {
  it('accepts a minimal valid descriptor', () => {
    const result = ElementDescriptorSchema.safeParse({
      handle: 'e0', role: 'button', name: 'Save', nameSource: 'native', tag: 'button',
      enabled: true, visible: true, inViewport: true, actionable: true,
      sensitiveKind: null, regionId: 'region:root', ordinal: 0,
    });
    expect(result.success).toBe(true);
  });

  it('rejects sensitiveKind values other than "file" or null — the ONLY kind that survives the walk', () => {
    const base = {
      handle: 'e0', role: 'textbox', name: '', nameSource: 'none' as const, tag: 'input',
      enabled: true, visible: true, inViewport: true, actionable: true,
      regionId: 'region:root', ordinal: 0,
    };
    expect(ElementDescriptorSchema.safeParse({ ...base, sensitiveKind: 'file' }).success).toBe(true);
    expect(ElementDescriptorSchema.safeParse({ ...base, sensitiveKind: null }).success).toBe(true);
    expect(ElementDescriptorSchema.safeParse({ ...base, sensitiveKind: 'password' }).success).toBe(false);
  });

  it('rejects a name over 120 characters', () => {
    const result = ElementDescriptorSchema.safeParse({
      handle: 'e0', role: 'button', name: 'x'.repeat(121), nameSource: 'native', tag: 'button',
      enabled: true, visible: true, inViewport: true, actionable: true,
      sensitiveKind: null, regionId: 'region:root', ordinal: 0,
    });
    expect(result.success).toBe(false);
  });
});
