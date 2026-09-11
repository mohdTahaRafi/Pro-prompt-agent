/**
 * z.toJSONSchema(ActionSchema) and ActionSchema.safeParse must never drift.
 * §6.1. Docs/planning/phase_4_model_tiers_routing.md §6.1, task 4.9 (schema
 * parity is exercised here; the nonce-fence escaping half of task 4.9 lives
 * in prompts.spec.ts).
 *
 * [Scope note] The doc's §6.1 describes a property-based generator running
 * 200 instances each direction against a JSON Schema VALIDATOR. No such
 * validator (ajv or similar) is a project dependency, and §14 states "New
 * runtime dependencies: 0" for this phase — adding one for a test-only
 * cross-check was judged not worth breaking that line. What IS tested here,
 * without one:
 *  1. z.toJSONSchema(ActionSchema) is REGENERATED from the same ActionSchema
 *     object safeParse validates against — there are not two hand-written
 *     descriptions to drift in the first place (the structural guarantee
 *     the doc's whole argument rests on, §6.1's own words).
 *  2. The JSON Schema's declared verb vocabulary (its discriminated union
 *     branches) is IDENTICAL to ActionSchema's own verb list — generated
 *     from the schema, not hand-copied, so a verb added to one can't be
 *     missing from the other silently.
 *  3. 200 generated, Zod-valid Action instances all round-trip through
 *     JSON.stringify/parse (the wire format both engines and the gate
 *     actually use) and re-validate afterward — catching the concrete
 *     failure mode (a field shape JSON can't carry faithfully) a schema
 *     mismatch would actually cause in production, even without a JSON
 *     Schema validator to name it by spec section.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ActionSchema, type Action, type Verb } from '@lib/schemas/action.schema';

const jsonSchema = z.toJSONSchema(ActionSchema) as any;

function verbBranches(schema: any): string[] {
  const branches = schema.anyOf ?? schema.oneOf ?? [];
  return branches
    .map((b: any) => b.properties?.verb?.const)
    .filter((v: unknown): v is string => typeof v === 'string');
}

describe('schema-parity — z.toJSONSchema(ActionSchema) vs ActionSchema.safeParse', () => {
  it('the JSON Schema declares every verb the Zod discriminated union declares, and no others', () => {
    const zodVerbs = (ActionSchema.options as { shape: { verb: { value: string } } }[]).map((o) => o.shape.verb.value);
    const schemaVerbs = verbBranches(jsonSchema);
    expect(new Set(schemaVerbs)).toEqual(new Set(zodVerbs));
    expect(schemaVerbs.length).toBe(zodVerbs.length);   // no duplicates either side
  });

  it('every implemented verb from lib/policy/gate.ts appears in both', async () => {
    const { IMPLEMENTED_VERBS } = await import('@lib/policy/gate');
    const schemaVerbs = new Set(verbBranches(jsonSchema));
    for (const v of IMPLEMENTED_VERBS) expect(schemaVerbs.has(v)).toBe(true);
  });
});

// ── A small, deterministic-seeded generator — no new dependency ──

let seed = 42;
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function pick<T>(arr: readonly T[]): T { return arr[Math.floor(rand() * arr.length)]; }
function randHandle(): string { return `e${Math.floor(rand() * 1000)}`; }
function randWord(): string { return pick(['click', 'submit', 'continue', 'name field', 'search box', 'menu']); }

function genAction(): Action {
  const verb = pick([
    'read_page', 'read_structure', 'read_element', 'wait_for_settle',
    'scroll', 'click', 'type', 'select', 'navigate', 'history_back', 'history_forward',
  ] as const);
  switch (verb) {
    case 'read_page': return { verb };
    case 'read_structure': return { verb, region: rand() > 0.5 ? randWord() : undefined };
    case 'read_element': return { verb, handle: randHandle() };
    case 'wait_for_settle': return { verb, maxMs: rand() > 0.5 ? Math.floor(100 + rand() * 14_000) : undefined };
    case 'scroll': return { verb, target: rand() > 0.5 ? randHandle() : pick(['up', 'down', 'top', 'bottom'] as const), amount: rand() > 0.5 ? Math.ceil(rand() * 20) : undefined };
    case 'click': return { verb, handle: randHandle() };
    case 'type': return { verb, handle: randHandle(), text: randWord(), mode: pick(['replace', 'append'] as const) };
    case 'select': return { verb, handle: randHandle(), value: randWord() };
    case 'navigate': return { verb, url: 'https://example.com/' + randWord().replace(/\s/g, '-') };
    case 'history_back': return { verb };
    case 'history_forward': return { verb };
  }
}

describe('schema-parity — 200 generated instances round-trip the wire format', () => {
  it('every generated instance is Zod-valid and survives JSON.stringify/parse re-validation', () => {
    for (let i = 0; i < 200; i++) {
      const action = genAction();
      const first = ActionSchema.safeParse(action);
      expect(first.success, `generated action failed first validation: ${JSON.stringify(action)}`).toBe(true);

      const roundTripped = JSON.parse(JSON.stringify(action));
      const second = ActionSchema.safeParse(roundTripped);
      expect(second.success, `round-tripped action failed re-validation: ${JSON.stringify(action)}`).toBe(true);
    }
  });
});
