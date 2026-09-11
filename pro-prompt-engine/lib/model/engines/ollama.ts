/**
 * Ollama engine — the local planner. §5.3.
 *
 * Runs directly in the service worker: `fetch()` to localhost needs no
 * offscreen document, unlike the Prompt API and WebLLM, whose model state
 * lives in a persistent document (lib/model/offscreen-bridge.ts's header).
 *
 * Gains over the Phase 1 ollama-adapter.ts this absorbs: the `format`
 * parameter for genuine constrained decoding (§6.1's second enforcement
 * point), `AbortSignal` support, and `probeOllamaPlanner()` replacing the
 * old boolean `checkOllamaHealth()` — a product decision, not just a health
 * check (§5.3): a reachable Ollama with only small models installed is told
 * *why* it doesn't qualify, not just that it's "unavailable".
 */
import { z } from 'zod';
import { Ok, Err, type Result } from '@lib/utils/result';
import type { RouteRequest, RouteResponse, RouteError } from '@lib/model/router-types';
import type { Engine } from '@lib/model/engine';
import { classifyOllamaModel, PLANNER_MIN_PARAMS_B, type OllamaModelClassification } from '@lib/model/tiers';

const DEFAULT_URL = 'http://localhost:11434';
// The bake-off (Docs/planning/bakeoff_phase2.md) could not name a default —
// only the deliberate 1.5B control was reachable in that environment (§10.1,
// §3.1's "no real candidate was measurable"). Shipped anyway as the interim
// default because architecture.md §3.2's disclosure copy and the Milestone
// Definition both name it explicitly ("Planner — Ollama, qwen2.5:14b") and
// a planner tier with no default at all cannot ship. Re-run the bake-off
// against this model specifically once a real dev machine can pull it —
// tracked as a Phase 4 follow-up, not silently assumed validated.
export const DEFAULT_PLANNER_MODEL = 'qwen2.5:14b';

interface OllamaConfig { baseUrl: string; model: string }

async function getOllamaConfig(): Promise<OllamaConfig> {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ['ollamaBaseUrl', 'ollamaPlannerModel'],
      (r: { ollamaBaseUrl?: string; ollamaPlannerModel?: string }) => {
        resolve({ baseUrl: r.ollamaBaseUrl || DEFAULT_URL, model: r.ollamaPlannerModel || DEFAULT_PLANNER_MODEL });
      },
    );
  });
}

export async function setOllamaConfig(patch: Partial<OllamaConfig>): Promise<void> {
  const update: Record<string, string> = {};
  if (patch.baseUrl !== undefined) update.ollamaBaseUrl = patch.baseUrl;
  if (patch.model !== undefined) update.ollamaPlannerModel = patch.model;
  await chrome.storage.local.set(update);
}

async function listInstalledModels(baseUrl: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.models ?? []).map((m: { name: string }) => m.name);
  } catch {
    return null;
  }
}

export interface OllamaPlannerProbe {
  reachable: boolean;
  baseUrl: string;
  installed: OllamaModelClassification[];
  capable: OllamaModelClassification[];
  chosenModel: string | null;
  reason?: string;
}

/**
 * §5.3 — replaces checkOllamaHealth()'s boolean. Lists installed models and
 * classifies each so a reachable-but-underpowered Ollama gets an actionable
 * reason ("tinyllama is too small; `ollama pull qwen2.5:14b` would work")
 * instead of the same "unavailable" a genuinely offline Ollama would show.
 */
export async function probeOllamaPlanner(): Promise<OllamaPlannerProbe> {
  const { baseUrl, model } = await getOllamaConfig();
  const installed = await listInstalledModels(baseUrl);

  if (installed === null) {
    return {
      reachable: false, baseUrl, installed: [], capable: [], chosenModel: null,
      reason: `Ollama isn't reachable on ${baseUrl.replace(/^https?:\/\//, '')}.`,
    };
  }

  const classified = installed.map(classifyOllamaModel);
  const capable = classified.filter((m) => m.plannerCapable);

  if (capable.length === 0) {
    const suggestion = `ollama pull ${DEFAULT_PLANNER_MODEL}`;
    const reason = classified.length === 0
      ? `Ollama is running, but no models are installed. \`${suggestion}\` would work.`
      : `Ollama is running, but the models installed are too small for planning (need ${PLANNER_MIN_PARAMS_B}B+, instruct-tuned). \`${suggestion}\` would work.`;
    return { reachable: true, baseUrl, installed: classified, capable: [], chosenModel: null, reason };
  }

  // Prefer the configured model if it's actually installed and capable;
  // otherwise the first capable model installed, preferring larger ones.
  const configuredIsCapable = capable.find((m) => m.name === model);
  const chosen = configuredIsCapable ?? [...capable].sort((a, b) => (b.paramsB ?? 0) - (a.paramsB ?? 0))[0];

  return { reachable: true, baseUrl, installed: classified, capable, chosenModel: chosen.name };
}

function buildBody(req: RouteRequest, model: string) {
  return {
    model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: typeof req.user === 'string' ? req.user : req.user.filter((p) => p.type === 'text').map((p) => p.text).join('\n') },
    ],
    stream: false,
    ...(req.schema ? { format: z.toJSONSchema(req.schema) } : {}),
    options: {
      // Planning is a selection task over a fixed set of handles, not a
      // creative one; higher temperature buys variance in exactly the
      // dimension where variance is a hallucinated handle (§5.3).
      temperature: req.temperature ?? 0.2,
      num_predict: req.maxTokens ?? 1_500,
    },
  };
}

export const ollamaEngine: Engine = {
  id: 'ollama',
  isRemote: false,
  async infer(req: RouteRequest): Promise<Result<RouteResponse, RouteError>> {
    const start = performance.now();
    const { baseUrl, model } = await getOllamaConfig();
    const probe = await probeOllamaPlanner();
    const chosenModel = probe.chosenModel ?? model;

    if (req.signal?.aborted) return Err('ABORTED');

    try {
      const res = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: req.signal,
        body: JSON.stringify(buildBody(req, chosenModel)),
      });
      if (!res.ok) return Err('ENGINE_FAILED', `Ollama error (${res.status})`);
      const data = await res.json();
      return Ok({
        content: data.message?.content ?? '',
        constrained: Boolean(req.schema),
        tokensUsed: data.eval_count,
        latencyMs: Math.round(performance.now() - start),
        engine: 'ollama',
        tier: req.tier,
      });
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return Err('ABORTED');
      return Err('ENGINE_FAILED', String(e));
    }
  },
};
