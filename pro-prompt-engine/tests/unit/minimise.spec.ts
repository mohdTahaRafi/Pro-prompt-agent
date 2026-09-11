/**
 * lib/model/minimise.ts — Class A assertion, Class B local condensation. §7.
 * Docs/planning/phase_4_model_tiers_routing.md §7.2, task 4.8.
 */
import { describe, it, expect, vi } from 'vitest';
import { minimise } from '@lib/model/minimise';
import { CHAINS } from '@lib/model/router';
import type { Engine } from '@lib/model/engine';

describe('minimise — Class A (assert, never transform)', () => {
  it('a well-formed planner template payload passes through unchanged', async () => {
    const req = {
      tier: 'planner' as const, posture: 'hybrid' as const, disclosureClass: 'A' as const,
      system: 's', user: '### GOAL\ndo it\n\n### POLICY\nx\n\n### OBSERVATION\n{}\n',
    };
    const res = await minimise(req);
    expect(res).toEqual({ ok: true, value: req });
  });

  it('a Class A payload containing raw page-text (no template markers) returns CLASS_A_CONTAINS_RAW_TEXT', async () => {
    const req = {
      tier: 'planner' as const, posture: 'hybrid' as const, disclosureClass: 'A' as const,
      system: 's', user: 'Welcome to our site! Here is a long article about widgets and how they work in practice...',
    };
    const res = await minimise(req);
    expect(res).toEqual({ ok: false, error: 'CLASS_A_CONTAINS_RAW_TEXT' });
  });
});

describe('minimise — Class B (condense locally, refuse rather than upgrade)', () => {
  it('with both local judge engines unavailable, returns CONDENSATION_UNAVAILABLE and makes zero network calls', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const unavailable: Engine = { id: 'unavailable', isRemote: false, infer: async () => ({ ok: false, error: 'ENGINE_UNAVAILABLE' }) };
    const originalLocal = CHAINS.judge['local-only'];
    const originalHybrid = CHAINS.judge.hybrid;
    CHAINS.judge['local-only'] = [unavailable];
    CHAINS.judge.hybrid = [unavailable];
    try {
      const req = { tier: 'planner' as const, posture: 'hybrid' as const, disclosureClass: 'B' as const, system: 's', user: 'raw page text here' };
      const res = await minimise(req);
      expect(res).toEqual({ ok: false, error: 'CONDENSATION_UNAVAILABLE' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      CHAINS.judge['local-only'] = originalLocal;
      CHAINS.judge.hybrid = originalHybrid;
      vi.unstubAllGlobals();
    }
  });

  it('with a local judge available, condenses, scrubs PII, and carries meta.condensed', async () => {
    const judge: Engine = { id: 'judge', isRemote: false, infer: async () => ({ ok: true, value: { content: 'Condensed. Contact me at a@b.com.', constrained: false, latencyMs: 3, engine: 'prompt-api', tier: 'judge' } }) };
    const original = CHAINS.judge.hybrid;
    CHAINS.judge.hybrid = [judge];
    try {
      const req = { tier: 'planner' as const, posture: 'hybrid' as const, disclosureClass: 'B' as const, system: 's', user: 'a very long raw page of text' };
      const res = await minimise(req);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.user).toContain('[EMAIL_REDACTED]');
        expect(res.value.user).not.toContain('a@b.com');
        expect(res.value.meta?.condensed).toBe(true);
        expect(res.value.meta?.scrubbed).toContain('email');
      }
    } finally { CHAINS.judge.hybrid = original; }
  });
});

describe('router.ts wires minimise() for BOTH disclosure classes when the chain can go remote', () => {
  it('a Class A route on Hybrid asserts the payload before ever trying the remote engine', async () => {
    const remoteInfer = vi.fn();
    const remote: Engine = { id: 'remote', isRemote: true, infer: remoteInfer };
    const { route } = await import('@lib/model/router');
    const original = CHAINS.planner.hybrid;
    CHAINS.planner.hybrid = [remote];
    try {
      const res = await route({
        tier: 'planner', posture: 'hybrid', disclosureClass: 'A',
        system: 's', user: 'this is not the planner template at all, just prose',
      });
      expect(res).toEqual({ ok: false, error: 'CLASS_A_CONTAINS_RAW_TEXT' });
      expect(remoteInfer).not.toHaveBeenCalled();
    } finally { CHAINS.planner.hybrid = original; }
  });
});
