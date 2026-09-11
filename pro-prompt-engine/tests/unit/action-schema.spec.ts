/**
 * lib/schemas/action.schema.ts — the closed verb vocabulary.
 * Docs/planning/phase_3_gate_actuation_verification.md §12 task 3.1.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ActionSchema, ActionRequestSchema, HandleSchema, handleOf } from '@lib/schemas/action.schema';

const VALID_INSTANCES: Record<string, unknown> = {
  read_page: { verb: 'read_page' },
  read_structure: { verb: 'read_structure', region: 'form:0' },
  read_element: { verb: 'read_element', handle: 'e3' },
  wait_for_settle: { verb: 'wait_for_settle', maxMs: 2000 },
  scroll: { verb: 'scroll', target: 'down', amount: 5 },
  click: { verb: 'click', handle: 'e12' },
  type: { verb: 'type', handle: 'e5', text: 'hello', mode: 'replace' },
  select: { verb: 'select', handle: 'e7', value: 'US' },
  navigate: { verb: 'navigate', url: 'https://example.com/next' },
  history_back: { verb: 'history_back' },
  history_forward: { verb: 'history_forward' },
  look_at: { verb: 'look_at', target: 'viewport' },
  open_tab: { verb: 'open_tab', url: 'https://example.com' },
  summarise: { verb: 'summarise', textRef: 'r1' },
  transform: { verb: 'transform', textRef: 'r1', shape: 'bullet-list' },
  refactor: { verb: 'refactor', text: 'const x = 1;' },
  generate: { verb: 'generate', description: 'a haiku about ships' },
  ask_user: { verb: 'ask_user', question: 'Which one?', reason: 'AMBIGUOUS_TARGET' },
  finish: { verb: 'finish', outcome: 'completed', summary: 'done' },
};

describe('ActionSchema — nineteen declared verbs', () => {
  it('produces valid JSON Schema via z.toJSONSchema', () => {
    const json = z.toJSONSchema(ActionSchema);
    expect(json).toBeTruthy();
    expect((json as { anyOf?: unknown[] }).anyOf ?? (json as { oneOf?: unknown[] }).oneOf).toBeDefined();
  });

  it('has exactly nineteen declared verbs', () => {
    expect(Object.keys(VALID_INSTANCES)).toHaveLength(19);
  });

  for (const [verb, instance] of Object.entries(VALID_INSTANCES)) {
    it(`accepts a valid ${verb} instance`, () => {
      const r = ActionSchema.safeParse(instance);
      expect(r.success, JSON.stringify(r.success ? null : r.error.issues)).toBe(true);
    });
  }

  it('rejects a twentieth, undeclared verb', () => {
    const r = ActionSchema.safeParse({ verb: 'delete_everything' });
    expect(r.success).toBe(false);
  });

  it('rejects a malformed handle', () => {
    expect(ActionSchema.safeParse({ verb: 'click', handle: 'not-a-handle' }).success).toBe(false);
    expect(ActionSchema.safeParse({ verb: 'click', handle: 'e' }).success).toBe(false);
    expect(HandleSchema.safeParse('e0').success).toBe(true);
  });

  it('rejects a 5,000-character type text (max is 4,000)', () => {
    const r = ActionSchema.safeParse({ verb: 'type', handle: 'e1', text: 'x'.repeat(5_000), mode: 'replace' });
    expect(r.success).toBe(false);
  });
});

describe('ActionRequestSchema', () => {
  const base = {
    requestId: '9c858901-8a57-4791-81fe-4c455b099bc9',
    runId: 1, tabId: 42, epoch: 3,
    action: { verb: 'click', handle: 'e1' },
    reason: 'user said "click continue"',
  };

  it('accepts a well-formed request', () => {
    expect(ActionRequestSchema.safeParse(base).success).toBe(true);
  });

  it('requires tabId', () => {
    const { tabId, ...rest } = base;
    expect(ActionRequestSchema.safeParse(rest).success).toBe(false);
  });

  it('requires a positive epoch', () => {
    expect(ActionRequestSchema.safeParse({ ...base, epoch: 0 }).success).toBe(false);
    expect(ActionRequestSchema.safeParse({ ...base, epoch: -1 }).success).toBe(false);
  });

  it('requires a uuid requestId', () => {
    expect(ActionRequestSchema.safeParse({ ...base, requestId: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('handleOf', () => {
  it('extracts the handle from every handle-bearing verb', () => {
    expect(handleOf({ verb: 'read_element', handle: 'e1' })).toBe('e1');
    expect(handleOf({ verb: 'click', handle: 'e2' })).toBe('e2');
    expect(handleOf({ verb: 'type', handle: 'e3', text: 'x', mode: 'replace' })).toBe('e3');
    expect(handleOf({ verb: 'select', handle: 'e4', value: 'x' })).toBe('e4');
  });

  it('extracts a handle-shaped scroll target but not a direction one', () => {
    expect(handleOf({ verb: 'scroll', target: 'e5' })).toBe('e5');
    expect(handleOf({ verb: 'scroll', target: 'down' })).toBeUndefined();
  });

  it('returns undefined for verbs with no handle', () => {
    expect(handleOf({ verb: 'navigate', url: 'https://example.com' })).toBeUndefined();
    expect(handleOf({ verb: 'history_back' })).toBeUndefined();
    expect(handleOf({ verb: 'read_page' })).toBeUndefined();
  });
});
