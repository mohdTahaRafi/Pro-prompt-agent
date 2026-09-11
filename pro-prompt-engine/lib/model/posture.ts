/**
 * Posture — Local-only vs Hybrid, and what the user is told before a run
 * starts. Docs/planning/phase_4_model_tiers_routing.md §3.2, PR-PRV-6.
 */
import { probeOllamaPlanner, DEFAULT_PLANNER_MODEL } from '@lib/model/engines/ollama';
import { hasRemoteKeyConfigured, getRemoteDestination } from '@lib/model/engines/remote';
import { probePromptApiAvailability } from '@lib/model/engines/prompt-api';
import { getWebllmState } from '@lib/model/engines/webllm';

export type Posture = 'local-only' | 'hybrid';

export interface PlannerCapability {
  available: boolean;
  engine: 'ollama' | 'remote' | null;
  model: string | null;
  reason?: string;
}
export interface JudgeCapability { available: boolean; engine: 'prompt-api' | 'webllm' | null; model: string | null }
export interface VisionCapability { available: boolean; engine: 'prompt-api' | 'remote' | null }
export interface InlineCapability { available: boolean; engine: 'prompt-api' | null }

export interface DisclosurePayload {
  classA: { willSend: boolean; destination: string | null; what: string };
  classB: { willSend: boolean; destination: string | null; condensedLocally: boolean };
  /** One sentence, plain language, shown in the cockpit before the run
   *  starts (§3.2's table) — a fixed string with substitution, never
   *  generated. */
  summary: string;
}

export interface PostureCapability {
  posture: Posture;
  planner: PlannerCapability;
  judge: JudgeCapability;
  vision: VisionCapability;
  inline: InlineCapability;
  disclosure: DisclosurePayload;
}

interface CacheEntry { at: number; value: PostureCapability }
const cache = new Map<Posture, CacheEntry>();
const CACHE_MS = 60_000;

export function __resetPostureCache(): void { cache.clear(); }

export async function probePosture(posture: Posture, opts?: { forceRefresh?: boolean }): Promise<PostureCapability> {
  const cached = cache.get(posture);
  if (!opts?.forceRefresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const [ollamaProbe, remoteConfigured, remoteDest, promptApiAvail, webllmState] = await Promise.all([
    probeOllamaPlanner(),
    hasRemoteKeyConfigured(),
    getRemoteDestination(),
    probePromptApiAvailability(),
    Promise.resolve(getWebllmState()),
  ]);

  const promptApiReady = promptApiAvail === 'available';
  const webllmReady = webllmState.state === 'hot';

  const judge: JudgeCapability = promptApiReady
    ? { available: true, engine: 'prompt-api', model: 'Gemini Nano' }
    : webllmReady
      ? { available: true, engine: 'webllm', model: webllmState.model }
      : { available: false, engine: null, model: null };

  const inline: InlineCapability = { available: promptApiReady, engine: promptApiReady ? 'prompt-api' : null };

  // Vision is routable from this phase with no caller (Phase 10, §15) —
  // capability is still reported honestly in the Models tab.
  const vision: VisionCapability = promptApiReady
    ? { available: true, engine: 'prompt-api' }
    : (posture === 'hybrid' && remoteConfigured) ? { available: true, engine: 'remote' } : { available: false, engine: null };

  let planner: PlannerCapability;
  if (posture === 'local-only') {
    // §3.1, §4.1 — no remote entry exists for the planner tier in this
    // posture. Ollama is the only route; the doc's own §11 refusal copy is
    // reproduced verbatim in `summary` below.
    planner = ollamaProbe.chosenModel
      ? { available: true, engine: 'ollama', model: ollamaProbe.chosenModel }
      : { available: false, engine: null, model: null, reason: ollamaProbe.reason };
  } else {
    // Hybrid: remote first (§4.1 — "it is why Hybrid was chosen"), Ollama
    // as the within-locality... no — remote and Ollama are DIFFERENT
    // localities, but both are legitimate planner routes in Hybrid; report
    // whichever is actually reachable, preferring remote for the model name
    // shown since that is the primary entry in CHAINS.planner.hybrid.
    if (remoteConfigured && remoteDest) {
      planner = { available: true, engine: 'remote', model: remoteDest.label };
    } else if (ollamaProbe.chosenModel) {
      planner = { available: true, engine: 'ollama', model: ollamaProbe.chosenModel };
    } else {
      planner = {
        available: false, engine: null, model: null,
        reason: 'No remote key is configured and Ollama isn\'t reachable either.',
      };
    }
  }

  const disclosure = buildDisclosure(posture, planner, remoteDest);

  const value: PostureCapability = { posture, planner, judge, vision, inline, disclosure };
  cache.set(posture, { at: Date.now(), value });
  return value;
}

function buildDisclosure(
  posture: Posture, planner: PlannerCapability, remoteDest: { host: string; label: string } | null,
): DisclosurePayload {
  if (posture === 'local-only') {
    if (planner.available) {
      return {
        classA: { willSend: false, destination: null, what: '' },
        classB: { willSend: false, destination: null, condensedLocally: true },
        summary: `Everything in this run stays on your machine. Planning runs on Ollama (\`${planner.model}\`); verification and text work run in your browser.`,
      };
    }
    return {
      classA: { willSend: false, destination: null, what: '' },
      classB: { willSend: false, destination: null, condensedLocally: true },
      summary: `This run can't start. A multi-step task needs a planning model, and Ollama isn't reachable on localhost:11434.`,
    };
  }

  // Hybrid. The honest form of Class A (§3.7.23) — OQ-9's answer: told in
  // terms of what IS sent, not what is withheld.
  const host = remoteDest?.host ?? 'your configured remote provider';
  return {
    classA: {
      willSend: true, destination: host,
      what: "a description of the page's controls — their roles, labels and whether they're filled — not the page's text or your values",
    },
    classB: { willSend: true, destination: host, condensedLocally: true },
    summary: `Planning for this run is sent to **${host}** using your key. It receives a description of the page's controls — their roles, labels and whether they're filled — not the page's text or your values. Verification, text completion and any page text stay on your machine.`,
  };
}

export { DEFAULT_PLANNER_MODEL };
