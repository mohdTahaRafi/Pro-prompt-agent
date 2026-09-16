/**
 * lib/agent/traceability.ts — is a value present in something the run read?
 * Docs/planning/phase_6_recovery_journal_reporting.md §6.3, §12 task 6.11.
 */
import { describe, it, expect } from 'vitest';
import { traceValue, untraceable } from '@lib/agent/traceability';

describe('traceValue — exact and normalised matches', () => {
  it('an exact substring match traces', async () => {
    expect(await traceValue('27 inches', ['Screen size: 27 inches diagonal'])).toBe('exact');
  });

  it('a normalised value traces (₹28,999 -> 28999)', async () => {
    expect(await traceValue('28999', ['Price: ₹28,999 (incl. tax)'])).toBe('normalized');
  });

  it('case and whitespace differences still normalise-match', async () => {
    expect(await traceValue('REFRESH RATE', ['the refresh rate is listed below'])).toBe('normalized');
  });

  it('a value not present anywhere in the corpus, with no judge available, is untraceable', async () => {
    expect(await traceValue('144Hz', ['Panel type: IPS', 'Ports: HDMI, DP'])).toBe('none');
  });

  it('a value with no digits that fails both checks is "none", never sent to a judge', async () => {
    const judge = vi_fn();
    expect(await traceValue('Refresh rate', ['Panel type: IPS'], judge.fn)).toBe('none');
    expect(judge.calls).toBe(0);
  });
});

describe('traceValue — the judge tier, called only where normalisation is ambiguous', () => {
  it('calls the judge for a digit-bearing value neither check resolved, and honours its verdict', async () => {
    // "28k" carries a digit (ambiguous) but neither an exact nor a
    // normalised match finds it inside "around 28000" — a real case where
    // only a judge could plausibly decide these mean the same price.
    const judge = vi_fn(async () => true);
    const verdict = await traceValue('28k', ['The price is around 28000 rupees'], judge.fn);
    expect(verdict).toBe('judged');
    expect(judge.calls).toBe(1);
  });

  it('a negative judge verdict is "none", the same as no match at all', async () => {
    const judge = vi_fn(async () => false);
    expect(await traceValue('999', ['totally unrelated text'], judge.fn)).toBe('none');
  });

  it('a judge that throws is treated as a negative verdict, never as traced', async () => {
    const judge = { fn: async () => { throw new Error('model unavailable'); } };
    expect(await traceValue('999', ['unrelated'], judge.fn)).toBe('none');
  });
});

describe('untraceable — a synthetic-claims sweep', () => {
  it('excludes exactly the values not present in any journaled read', async () => {
    const corpus = ['Screen size: 27 inches', 'Ports: HDMI, DisplayPort', 'Price: ₹28,999'];
    const claims = [{ value: '27 inches' }, { value: 'Refresh rate' }, { value: '28999' }, { value: 'Panel type' }];
    const misses = await untraceable(claims, corpus);
    expect(misses).toEqual(new Set(['Refresh rate', 'Panel type']));
  });

  it('an empty corpus makes every claim a miss', async () => {
    const misses = await untraceable([{ value: 'anything' }], []);
    expect(misses.has('anything')).toBe(true);
  });
});

// A tiny call-counting stub — avoids pulling in vitest's vi.fn() typing
// ceremony for a one-off async callback used across several `it`s.
function vi_fn(impl: (...args: any[]) => any = async () => false) {
  const state = { calls: 0 };
  return {
    get calls() { return state.calls; },
    fn: async (...args: any[]) => { state.calls += 1; return impl(...args); },
  };
}
