/**
 * lib/schemas/plan.schema.ts — §8.2. task 4.10.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { PlanSchema } from '@lib/schemas/plan.schema';

const validPlan = {
  restatement: 'Fill and submit the form.',
  steps: [
    { n: 1, intent: 'Type name', action: { verb: 'type', handle: 'e1', text: 'Taha', mode: 'replace' }, expectation: 'the field shows Taha' },
  ],
  willNotDo: ['I will not attach a file — the form needs one and I have no way to provide one.'],
};

describe('PlanSchema', () => {
  it('accepts a well-formed plan', () => {
    expect(PlanSchema.safeParse(validPlan).success).toBe(true);
  });

  it('an empty willNotDo array is legal (still required to be present)', () => {
    expect(PlanSchema.safeParse({ ...validPlan, willNotDo: [] }).success).toBe(true);
  });

  it('rejects a plan with neither steps nor a clarifyingQuestion', () => {
    const res = PlanSchema.safeParse({ ...validPlan, steps: [] });
    expect(res.success).toBe(false);
  });

  it('accepts an empty-steps plan WITH a clarifyingQuestion', () => {
    const res = PlanSchema.safeParse({ ...validPlan, steps: [], clarifyingQuestion: 'Which account do you mean?' });
    expect(res.success).toBe(true);
  });

  it('caps steps at 40 and willNotDo at 10', () => {
    const tooManySteps = { ...validPlan, steps: Array.from({ length: 41 }, (_, i) => ({ ...validPlan.steps[0], n: i + 1 })) };
    expect(PlanSchema.safeParse(tooManySteps).success).toBe(false);
    const tooManyWillNotDo = { ...validPlan, willNotDo: Array.from({ length: 11 }, () => 'x') };
    expect(PlanSchema.safeParse(tooManyWillNotDo).success).toBe(false);
  });

  it('a step naming an action outside ActionSchema is rejected — same schema as the gate', () => {
    const bad = { ...validPlan, steps: [{ n: 1, intent: 'x', action: { verb: 'delete_everything' }, expectation: 'y' }] };
    expect(PlanSchema.safeParse(bad).success).toBe(false);
  });

  it('targetHint is optional and, when present, carries role/name', () => {
    const withHint = { ...validPlan, steps: [{ ...validPlan.steps[0], targetHint: { role: 'textbox', name: 'Full name' } }] };
    expect(PlanSchema.safeParse(withHint).success).toBe(true);
  });

  it('z.toJSONSchema(PlanSchema) does not throw and declares steps/willNotDo', () => {
    const jsonSchema = z.toJSONSchema(PlanSchema) as any;
    const str = JSON.stringify(jsonSchema);
    expect(str).toContain('willNotDo');
    expect(str).toContain('steps');
  });
});
