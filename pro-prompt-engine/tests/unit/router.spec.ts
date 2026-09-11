/**
 * lib/model/router.ts — the no-cascade boundary. §4.
 * Docs/planning/phase_4_model_tiers_routing.md §4, task 4.2.
 *
 * Asserts the boundary BY CONSTRUCTION (walks CHAINS), not by behaviour —
 * a silent locality crossing is a build failure, not a bug report (§3.8).
 *
 * [Test-design note on task 4.2's acceptance wording] The doc's acceptance
 * criterion says "a local-only planner request with Ollama down returns
 * NO_ENGINE_FOR_TIER and makes zero network calls". As specified,
 * CHAINS.planner['local-only'] is `[ollamaEngine]` — never an empty array —
 * so an Ollama-down planner call legitimately DOES call fetch() (that is
 * how it discovers Ollama is down) and returns a failure code from that
 * attempt, not NO_ENGINE_FOR_TIER. NO_ENGINE_FOR_TIER is reachable only
 * when a (tier, posture) pair's chain is empty, which is true of none of
 * the CHAINS entries today — it exists for a future tier/posture with no
 * engine at all. Tested here as two separate, both real, properties: (1)
 * NO_ENGINE_FOR_TIER + zero network calls, on a chain forced empty; (2) an
 * Ollama-down Local-only planner call never reaches any HOST OTHER THAN
 * localhost:11434 — the actual boundary guarantee task 4.2 cares about.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { route, extractJson, CHAINS } from '@lib/model/router';
import type { Engine } from '@lib/model/engine';
import { MODEL_TIERS } from '@lib/model/tiers';
import * as journal from '@lib/agent/journal';

describe('router — the boundary, asserted by construction', () => {
  it('no local-only chain contains a remote engine', () => {
    for (const tier of MODEL_TIERS) {
      for (const engine of CHAINS[tier]['local-only']) {
        expect(engine.isRemote, `${tier}.local-only contains remote engine "${engine.id}"`).toBe(false);
      }
    }
  });

  it('the inline row contains no remote engine in EITHER posture', () => {
    expect(CHAINS.inline['local-only'].some((e) => e.isRemote)).toBe(false);
    expect(CHAINS.inline.hybrid.some((e) => e.isRemote)).toBe(false);
  });

  it('the judge row is IDENTICAL across postures — local in both', () => {
    expect(CHAINS.judge['local-only'].map((e) => e.id)).toEqual(CHAINS.judge.hybrid.map((e) => e.id));
    expect(CHAINS.judge['local-only'].some((e) => e.isRemote)).toBe(false);
  });

  it('a local-only chain containing a remote engine throws a BUILD ERROR, not a Result', async () => {
    const fakeRemote: Engine = { id: 'fake-remote', isRemote: true, infer: async () => ({ ok: true, value: { content: '', constrained: false, latencyMs: 0, engine: 'fake-remote', tier: 'judge' } }) };
    const original = CHAINS.judge['local-only'];
    CHAINS.judge['local-only'] = [...original, fakeRemote];
    try {
      await expect(route({ tier: 'judge', posture: 'local-only', system: 's', user: 'u' }))
        .rejects.toThrow(/BUILD ERROR/);
    } finally {
      CHAINS.judge['local-only'] = original;
    }
  });
});

describe('router — NO_ENGINE_FOR_TIER, on a chain forced empty', () => {
  it('returns NO_ENGINE_FOR_TIER and makes zero network calls', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const original = CHAINS.judge['local-only'];
    CHAINS.judge['local-only'] = [];
    try {
      const res = await route({ tier: 'judge', posture: 'local-only', system: 's', user: 'u' });
      expect(res).toEqual({ ok: false, error: 'NO_ENGINE_FOR_TIER' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      CHAINS.judge['local-only'] = original;
      vi.unstubAllGlobals();
    }
  });
});

describe('router — Local-only planner with Ollama down never reaches a non-localhost host', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed'))));
  afterEach(() => vi.unstubAllGlobals());

  it('every fetch call target is localhost:11434; the call fails, never silently upgrades', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const res = await route({ tier: 'planner', posture: 'local-only', system: 's', user: 'u' });
    expect(res.ok).toBe(false);
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      expect(url.startsWith('http://localhost:11434')).toBe(true);
    }
  });
});

describe('router — fallback within a locality is journaled', () => {
  it('journals inference.fallback when the first engine fails and a later one in the same chain succeeds', async () => {
    const appendSpy = vi.spyOn(journal, 'append').mockResolvedValue(undefined);
    const failing: Engine = { id: 'failing', isRemote: false, infer: async () => ({ ok: false, error: 'ENGINE_UNAVAILABLE' }) };
    const succeeding: Engine = { id: 'succeeding', isRemote: false, infer: async () => ({ ok: true, value: { content: 'hi', constrained: false, latencyMs: 5, engine: 'succeeding', tier: 'judge' } }) };
    const original = CHAINS.judge['local-only'];
    CHAINS.judge['local-only'] = [failing, succeeding];
    try {
      const res = await route({ tier: 'judge', posture: 'local-only', system: 's', user: 'u', runId: 42 });
      expect(res).toEqual({ ok: true, value: { content: 'hi', constrained: false, latencyMs: 5, engine: 'succeeding', tier: 'judge' } });
      expect(appendSpy).toHaveBeenCalledWith(42, 'inference.fallback', null, expect.objectContaining({ tier: 'judge', from: 'failing', to: 'succeeding' }));
    } finally {
      CHAINS.judge['local-only'] = original;
      appendSpy.mockRestore();
    }
  });

  it('does NOT journal a fallback when runId is absent (no run exists yet)', async () => {
    const appendSpy = vi.spyOn(journal, 'append').mockResolvedValue(undefined);
    const failing: Engine = { id: 'failing', isRemote: false, infer: async () => ({ ok: false, error: 'ENGINE_UNAVAILABLE' }) };
    const succeeding: Engine = { id: 'succeeding', isRemote: false, infer: async () => ({ ok: true, value: { content: 'hi', constrained: false, latencyMs: 5, engine: 'succeeding', tier: 'judge' } }) };
    const original = CHAINS.judge['local-only'];
    CHAINS.judge['local-only'] = [failing, succeeding];
    try {
      await route({ tier: 'judge', posture: 'local-only', system: 's', user: 'u' });
      expect(appendSpy).not.toHaveBeenCalled();
    } finally {
      CHAINS.judge['local-only'] = original;
      appendSpy.mockRestore();
    }
  });
});

describe('router — ABORTED never falls through to the next engine', () => {
  it('stops at the first ABORTED result', async () => {
    const secondEngineInfer = vi.fn();
    const aborting: Engine = { id: 'aborting', isRemote: false, infer: async () => ({ ok: false, error: 'ABORTED' }) };
    const never: Engine = { id: 'never', isRemote: false, infer: secondEngineInfer };
    const original = CHAINS.judge['local-only'];
    CHAINS.judge['local-only'] = [aborting, never];
    try {
      const res = await route({ tier: 'judge', posture: 'local-only', system: 's', user: 'u' });
      expect(res).toEqual({ ok: false, error: 'ABORTED' });
      expect(secondEngineInfer).not.toHaveBeenCalled();
    } finally {
      CHAINS.judge['local-only'] = original;
    }
  });
});

describe('extractJson', () => {
  it('strips markdown fences and takes the first balanced object', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('does not repair unbalanced braces (no brace-append repair)', () => {
    expect(extractJson('{"a":1')).toBeUndefined();
  });
  it('does not regex out fields from unparsable garbage', () => {
    expect(extractJson('score is about 50 or so')).toBeUndefined();
  });
  it('handles a string value containing a brace character without miscounting depth', () => {
    expect(extractJson('{"a":"contains } a brace"}')).toEqual({ a: 'contains } a brace' });
  });
});
