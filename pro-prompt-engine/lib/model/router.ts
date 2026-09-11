/**
 * lib/model/router.ts — the no-cascade boundary.
 * Docs/planning/phase_4_model_tiers_routing.md §4.
 *
 * Replaces the Phase 1 flat-cascade router's `FALLBACK_ORDER` (deleted this
 * phase, per task 4.15)
 * (webgpu → ollama → groq, tried identically for every workload) with four
 * tiers, each with its own static engine chain PER POSTURE. Fallback is
 * still permitted — but only ACROSS engines of the SAME locality (§4.2),
 * never across the local/remote boundary. That boundary is enforced by
 * construction (`chain.some(isRemote)` on a `local-only` chain is a build
 * error, thrown, not returned as a Result) rather than by a check that a
 * future edit could forget.
 */
import { z } from 'zod';
import { Ok, Err, type Result } from '@lib/utils/result';
import * as journal from '@lib/agent/journal';
import type { ModelTier } from '@lib/model/tiers';
import type { Posture } from '@lib/model/posture';
import type { Engine } from '@lib/model/engine';
import type { RouteRequest, RouteResponse, RouteError } from '@lib/model/router-types';
import { promptApiEngine } from '@lib/model/engines/prompt-api';
import { webllmEngine } from '@lib/model/engines/webllm';
import { ollamaEngine } from '@lib/model/engines/ollama';
import { remoteEngine } from '@lib/model/engines/remote';
import { minimise } from '@lib/model/minimise';

export type { RouteRequest, RouteResponse, RouteError, PromptContent } from '@lib/model/router-types';
export type { Engine } from '@lib/model/engine';

function isRemote(engine: Engine): boolean { return engine.isRemote; }

/** §4.1 — the static table. Every entry is data, not a decision made at
 *  call time: which engines exist for a (tier, posture) pair is fixed at
 *  build time, which is what makes the boundary assertable by construction
 *  in tests/unit/router.spec.ts rather than merely tested by behaviour. */
export const CHAINS: Record<ModelTier, Record<Posture, Engine[]>> = {
  planner: {
    'local-only': [ollamaEngine],                 // no remote entry. At all.
    'hybrid': [remoteEngine, ollamaEngine],        // remote first: it is why Hybrid was chosen
  },
  judge: {
    // IDENTICAL across postures — not a copy-paste. Judge work (condensation
    // included) is what keeps Hybrid's Class B exposure bounded; if judge
    // could go remote, condensation would itself be a remote call and the
    // minimisation guarantee (§7.2) would be circular.
    'local-only': [promptApiEngine, webllmEngine],
    'hybrid': [promptApiEngine, webllmEngine],
  },
  vision: {
    'local-only': [promptApiEngine],
    // [Phase 10 adds the real vision engine and caller; declared routable now.]
    'hybrid': [promptApiEngine],
  },
  inline: {
    'local-only': [promptApiEngine],
    'hybrid': [promptApiEngine],   // no remote path EXISTS (§3.7.22) — not a posture check
  },
};

export async function route(req: RouteRequest): Promise<Result<RouteResponse, RouteError>> {
  const chain = CHAINS[req.tier][req.posture];
  if (chain.length === 0) return Err('NO_ENGINE_FOR_TIER');

  // ── THE BOUNDARY. Enforced here, in one place, structurally. ──
  // A Local-only request can never reach a remote engine, because the chain
  // it was handed contains none. This is not a check that could be
  // forgotten; there is no remote entry to skip.
  if (req.posture === 'local-only' && chain.some(isRemote)) {
    throw new Error('BUILD ERROR: local-only chain contains a remote engine');
  }

  // ── Minimisation, before any remote engine is tried (§3.7.23, §7.2). ──
  // [Phase 4 correction] The doc's §4 sketch only calls minimise() for
  // disclosureClass 'B'; but minimise() itself (§7.2) also carries a Class
  // A assertion branch, which would then never run. Broadened to both
  // classes — a Class A payload gets asserted-safe, a Class B payload gets
  // condensed — whenever a disclosure class is declared AND the chain can
  // actually go remote. Written back here rather than silently diverging
  // from the doc's prose, per this repo's spec-correction practice.
  if (req.disclosureClass && chain.some(isRemote)) {
    const minimised = await minimise(req);
    if (!minimised.ok) return minimised;
    req = minimised.value;
  }

  let lastError: RouteError | null = null;
  let lastDetail: unknown;
  for (let i = 0; i < chain.length; i++) {
    const engine = chain[i];
    const res = await engine.infer(req);
    if (res.ok) {
      if (i > 0 && req.runId !== undefined) {
        // §4.2 — every within-locality fallback is journaled so the report
        // can say "verification ran on the downloaded model because
        // Chrome's built-in one was unavailable."
        await journal.append(req.runId, 'inference.fallback', null, {
          tier: req.tier, from: chain[0].id, to: engine.id, reason: lastError ?? 'unknown',
        });
      }
      return Ok({ ...res.value, engine: engine.id, tier: req.tier });
    }
    lastError = res.error;
    lastDetail = res.detail;
    if (res.error === 'ABORTED') return Err('ABORTED');   // stop never falls through
  }
  return Err(lastError ?? 'ALL_ENGINES_FAILED', lastDetail);
}

/**
 * §6.2 — the validate-and-repair fallback. ONE repair attempt, the
 * validation error quoted back to the model — never a regex ladder, never a
 * fabricated default (§6.3).
 */
export async function inferStructured<T>(
  req: Omit<RouteRequest, 'schema'>, schema: z.ZodType<T>,
): Promise<Result<T, RouteError>> {
  const first = await route({ ...req, schema });
  if (!first.ok) return first;

  const p1 = schema.safeParse(extractJson(first.value.content));
  if (p1.success) return Ok(p1.data);

  const repair = await route({
    ...req, schema,
    user: `${asText(req.user)}\n\nYour previous response did not match the required format.\n` +
      `The error was: ${p1.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}\n` +
      `Respond again with valid JSON only.`,
  });
  if (!repair.ok) return repair;

  const p2 = schema.safeParse(extractJson(repair.value.content));
  if (p2.success) return Ok(p2.data);

  // Fail the run with the raw output journaled. Never guess (§3.3.1 step 4).
  if (req.runId !== undefined) {
    await journal.append(req.runId, 'model.output_invalid', null, {
      tier: req.tier, raw: repair.value.content.slice(0, 2_000), issues: p2.error.issues,
    });
  }
  return Err('MODEL_OUTPUT_INVALID');
}

function asText(user: RouteRequest['user']): string {
  return typeof user === 'string' ? user : user.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

/** Strips markdown fences and takes the first balanced `{…}` or `[…]`. Does
 *  NOT repair braces, does NOT regex out individual fields, does NOT
 *  substitute a default — all three are in the current scorer.ts and all
 *  three are deleted (§6.3). */
export function extractJson(raw: string): unknown {
  const stripped = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const openers: Record<string, string> = { '{': '}', '[': ']' };
  const startIdx = stripped.search(/[{[]/);
  if (startIdx === -1) return undefined;

  const open = stripped[startIdx];
  const close = openers[open];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (escaped) { escaped = false; }
      else if (ch === '\\') { escaped = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const candidate = stripped.slice(startIdx, i + 1);
        try { return JSON.parse(candidate); } catch { return undefined; }
      }
    }
  }
  return undefined;
}
