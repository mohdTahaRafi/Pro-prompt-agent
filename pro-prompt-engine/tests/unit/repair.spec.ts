/**
 * lib/model/router.ts's inferStructured() — the one-shot validate-and-repair
 * fallback. §6.2. Docs/planning/phase_4_model_tiers_routing.md §6.2, §6.3,
 * task 4.7.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { inferStructured, CHAINS } from '@lib/model/router';
import type { Engine } from '@lib/model/engine';
import * as journal from '@lib/agent/journal';

const Schema = z.object({ score: z.number() });

describe('inferStructured — the one-shot repair path (§6.2)', () => {
  it('returns the parsed value on first-try success', async () => {
    const ok: Engine = { id: 'ok', isRemote: false, infer: async () => ({ ok: true, value: { content: '{"score": 90}', constrained: true, latencyMs: 1, engine: 'ok', tier: 'judge' } }) };
    const original = CHAINS.judge['local-only'];
    CHAINS.judge['local-only'] = [ok];
    try {
      const res = await inferStructured({ tier: 'judge', posture: 'local-only', system: 's', user: 'u' }, Schema);
      expect(res).toEqual({ ok: true, value: { score: 90 } });
    } finally { CHAINS.judge['local-only'] = original; }
  });

  it('malformed-then-valid: the ONE repair attempt recovers, quoting the validation error back', async () => {
    let call = 0;
    let repairPromptSeen = '';
    const flaky: Engine = {
      id: 'flaky', isRemote: false,
      infer: async (req) => {
        call++;
        if (call === 2) repairPromptSeen = String(req.user);
        const content = call === 1 ? 'not json at all' : '{"score": 42}';
        return { ok: true, value: { content, constrained: true, latencyMs: 1, engine: 'flaky', tier: 'judge' } };
      },
    };
    const original = CHAINS.judge['local-only'];
    CHAINS.judge['local-only'] = [flaky];
    try {
      const res = await inferStructured({ tier: 'judge', posture: 'local-only', system: 's', user: 'u' }, Schema);
      expect(res).toEqual({ ok: true, value: { score: 42 } });
      expect(call).toBe(2);   // ONE repair attempt, not a ladder
      expect(repairPromptSeen).toContain('did not match the required format');
    } finally { CHAINS.judge['local-only'] = original; }
  });

  it('malformed-then-malformed: returns MODEL_OUTPUT_INVALID and journals the raw output — never a fabricated default', async () => {
    const appendSpy = vi.spyOn(journal, 'append').mockResolvedValue(undefined);
    const alwaysBad: Engine = { id: 'bad', isRemote: false, infer: async () => ({ ok: true, value: { content: 'still not json', constrained: true, latencyMs: 1, engine: 'bad', tier: 'judge' } }) };
    const original = CHAINS.judge['local-only'];
    CHAINS.judge['local-only'] = [alwaysBad];
    try {
      const res = await inferStructured({ tier: 'judge', posture: 'local-only', system: 's', user: 'u', runId: 7 }, Schema);
      expect(res).toEqual({ ok: false, error: 'MODEL_OUTPUT_INVALID' });
      expect(appendSpy).toHaveBeenCalledWith(7, 'model.output_invalid', null, expect.objectContaining({ tier: 'judge', raw: 'still not json' }));
    } finally { CHAINS.judge['local-only'] = original; appendSpy.mockRestore(); }
  });

  it('a first-attempt engine failure short-circuits before any repair attempt', async () => {
    const infer = vi.fn().mockResolvedValue({ ok: false, error: 'ENGINE_UNAVAILABLE' });
    const dead: Engine = { id: 'dead', isRemote: false, infer };
    const original = CHAINS.judge['local-only'];
    CHAINS.judge['local-only'] = [dead];
    try {
      const res = await inferStructured({ tier: 'judge', posture: 'local-only', system: 's', user: 'u' }, Schema);
      expect(res).toEqual({ ok: false, error: 'ENGINE_UNAVAILABLE' });
      expect(infer).toHaveBeenCalledTimes(1);
    } finally { CHAINS.judge['local-only'] = original; }
  });
});

describe('scorer.ts — the fabricated-score ladder is gone (§6.3)', () => {
  it('grep -n \'{ *score: *50\' lib/ returns nothing', async () => {
    const { execSync } = await import('node:child_process');
    const out = execSync("grep -rn '{ *score: *50' lib/ || true", { cwd: process.cwd() }).toString();
    expect(out.trim()).toBe('');
  });
});
