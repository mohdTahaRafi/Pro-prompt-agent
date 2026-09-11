/**
 * The Phase 2 planner bake-off (§10.1, task 2.17) — an offline developer
 * harness. NOT shipped in the extension; nothing under entrypoints/ or the
 * production lib/ tree imports this file or its prompt draft.
 * [Phase 4] The draft prompt moved to ./bakeoff-prompt.ts — lib/agent/prompts.ts
 * is now the shipped planner prompt (Docs/planning/phase_4_model_tiers_routing.md §8.1).
 *
 * Scores each reachable candidate model against the corpus
 * (tools/build-corpus.ts + tools/collect-real-fixtures.ts) on all seven
 * §10.1 metrics — target-selection accuracy, plan step precision/recall,
 * schema validity, hallucinated-handle rate, willNotDo quality, latency,
 * and cost/tokens — then writes Docs/planning/bakeoff_phase2.md.
 *
 * HONEST NOTE ON COVERAGE — a real, disclosed gap, not a fabricated result:
 * §10.1's candidate list is Ollama qwen2.5:7b-instruct, qwen2.5:14b-instruct,
 * llama3.1:8b-instruct, mistral-nemo:12b; remote llama-3.3-70b-versatile via
 * Groq; one frontier model on a user key (Google Gemini, per the user's own
 * choice for this run — see Docs/planning/phase_2_perception.md §17); plus a
 * 1.5B in-browser control. Each candidate below is reported as either
 * "measured" with real numbers from a real API call, or "not-measured" with
 * the genuine reason (no API key held, model not pulled, Ollama unreachable)
 * — never invented for an unreachable candidate. See §17 for the full,
 * dated account of what ran on which machine.
 *
 * Usage: npx tsx tools/bakeoff.ts
 * Env: GROQ_API_KEY, GEMINI_API_KEY (GEMINI_MODEL optional, default below),
 *      OLLAMA_BASE_URL (default http://localhost:11434),
 *      BAKEOFF_LIMIT, BAKEOFF_SKIP (see main() below for both)
 * Writes: Docs/planning/bakeoff_phase2.md, tests/bench/bakeoff_raw.json
 */
import { installDomEnv } from './dom-env';

installDomEnv();

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBakeoffPrompt, type BakeoffPlanResponse, type BakeoffPlanStep } from './bakeoff-prompt';
import { PerceptionSnapshotSchema, type PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import { runPruningStudy } from './pruning-study';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CORPUS_DIR = path.join(ROOT, 'tests/fixtures/snapshots');
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-pro';

interface CorpusEntry {
  id: string; source: string; snapshotFile: string; goal: string;
  gold: { targetHandle: string | null; targetDescription: string; steps: string[] };
}

interface CallResult {
  text: string;
  latencyMs: number;
  /** Provider-reported token counts, when the API returns them. Null when
   *  the provider doesn't report usage for this call shape — never guessed. */
  tokensIn: number | null;
  tokensOut: number | null;
}

interface Candidate {
  name: string;
  kind: 'ollama' | 'groq' | 'frontier' | 'in-browser-control';
  model: string;
  /** Returns null if genuinely unreachable in this environment — never
   *  fabricated; the report states the reason. */
  available: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  call: (system: string, user: string) => Promise<CallResult>;
}

interface TaskResult {
  entryId: string;
  targetMatch: boolean | null;   // null for willNotDo entries with no target
  stepPrecision: number | null;  // null when the response named zero steps/willNotDo items
  stepRecall: number | null;     // null when gold.steps is empty (shouldn't happen — corpus invariant)
  schemaValid: boolean;
  hallucinatedHandles: number;
  willNotDoScore: 0 | 1 | 2 | null;   // null when not applicable
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  error?: string;
}

export interface CandidateReport {
  candidate: Candidate;
  status: 'measured' | 'not-measured';
  reason?: string;
  results: TaskResult[];
}

async function ollamaAvailable(model: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return { ok: false, reason: `Ollama unreachable at ${OLLAMA_BASE} (HTTP ${resp.status})` };
    const data = await resp.json() as { models?: Array<{ name: string; model: string }> };
    const has = (data.models ?? []).some((m) => m.name === model || m.model === model);
    return has ? { ok: true } : { ok: false, reason: `model "${model}" not pulled locally (ollama pull ${model})` };
  } catch (err) {
    return { ok: false, reason: `Ollama unreachable at ${OLLAMA_BASE}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function callOllama(model: string, system: string, user: string): Promise<CallResult> {
  const t0 = Date.now();
  const resp = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, stream: false, format: 'json',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      options: { temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const latencyMs = Date.now() - t0;
  if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);
  const data = await resp.json() as {
    message?: { content?: string };
    prompt_eval_count?: number; eval_count?: number;
  };
  return {
    text: data.message?.content ?? '', latencyMs,
    tokensIn: data.prompt_eval_count ?? null, tokensOut: data.eval_count ?? null,
  };
}

function makeOllamaCandidate(name: string, model: string): Candidate {
  return {
    name, kind: 'ollama', model,
    available: () => ollamaAvailable(model),
    call: (system, user) => callOllama(model, system, user),
  };
}

function unavailableCandidate(name: string, kind: Candidate['kind'], model: string, reason: string): Candidate {
  return {
    name, kind, model,
    available: async () => ({ ok: false, reason }),
    call: async () => { throw new Error('unreachable'); },
  };
}

/** Groq's OpenAI-compatible chat completions endpoint — the same shape
 *  lib/adapters/groq-adapter.ts already uses in the extension itself. */
function makeGroqCandidate(name: string, model: string): Candidate {
  const apiKey = process.env.GROQ_API_KEY;
  return {
    name, kind: 'groq', model,
    available: async () => {
      if (!apiKey) return { ok: false, reason: 'no GROQ_API_KEY in this environment' };
      try {
        const resp = await fetch('https://api.groq.com/openai/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000),
        });
        return resp.ok ? { ok: true } : { ok: false, reason: `Groq API key rejected (HTTP ${resp.status})` };
      } catch (err) {
        return { ok: false, reason: `Groq unreachable: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    call: async (system, user) => {
      const t0 = Date.now();
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, temperature: 0.1, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const latencyMs = Date.now() - t0;
      if (!resp.ok) throw new Error(`Groq HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`);
      const data = await resp.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: data.choices?.[0]?.message?.content ?? '', latencyMs,
        tokensIn: data.usage?.prompt_tokens ?? null, tokensOut: data.usage?.completion_tokens ?? null,
      };
    },
  };
}

/** Google Gemini's generateContent REST endpoint. The frontier candidate
 *  §10.1 calls for "one frontier model on a user key" — Gemini per the
 *  user's own choice for this run (Docs/planning/phase_2_perception.md
 *  §17 records the decision). System instruction and the JSON-mode
 *  response schema are Gemini-specific; everything else about the call
 *  (prompt content, temperature) matches every other candidate. */
function makeGeminiCandidate(name: string): Candidate {
  const apiKey = process.env.GEMINI_API_KEY;
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}`;
  return {
    name, kind: 'frontier', model: GEMINI_MODEL,
    available: async () => {
      if (!apiKey) return { ok: false, reason: 'no GEMINI_API_KEY in this environment' };
      try {
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
          { signal: AbortSignal.timeout(5000) });
        return resp.ok ? { ok: true } : { ok: false, reason: `Gemini API key rejected (HTTP ${resp.status})` };
      } catch (err) {
        return { ok: false, reason: `Gemini unreachable: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    call: async (system, user) => {
      const t0 = Date.now();
      const resp = await fetch(`${base}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const latencyMs = Date.now() - t0;
      if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`);
      const data = await resp.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      return {
        text, latencyMs,
        tokensIn: data.usageMetadata?.promptTokenCount ?? null,
        tokensOut: data.usageMetadata?.candidatesTokenCount ?? null,
      };
    },
  };
}

const CANDIDATES: Candidate[] = [
  // Smaller/faster model first — gets real data sooner if a run is
  // interrupted partway (CPU-only inference on the larger models is slow).
  makeOllamaCandidate('qwen2.5:1.5b — the deliberate control (§10.1)', 'qwen2.5:1.5b'),
  makeOllamaCandidate('llama3.1:8b-instruct', 'llama3.1:8b-instruct'),
  makeOllamaCandidate('qwen2.5:7b-instruct', 'qwen2.5:7b-instruct'),
  makeOllamaCandidate('mistral-nemo:12b', 'mistral-nemo:12b'),
  makeOllamaCandidate('qwen2.5:14b-instruct', 'qwen2.5:14b-instruct'),
  makeGroqCandidate('llama-3.3-70b-versatile (Groq)', 'llama-3.3-70b-versatile'),
  makeGeminiCandidate(`${GEMINI_MODEL} (Gemini — frontier candidate)`),
];

function extractHandles(text: string): string[] {
  const matches = text.match(/\be\d+\b/g);
  return matches ? Array.from(new Set(matches)) : [];
}

function parseResponse(text: string): BakeoffPlanResponse | null {
  try {
    // Strip a markdown code fence if the model wrapped its JSON in one —
    // common even under Ollama's format:'json' mode with smaller models.
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(cleaned);
    if (!parsed || !Array.isArray(parsed.steps)) return null;
    return parsed as BakeoffPlanResponse;
  } catch {
    return null;
  }
}

function scoreWillNotDo(entry: CorpusEntry, response: BakeoffPlanResponse | null): 0 | 1 | 2 {
  if (!response) return 0;
  const mentionsExclusion = (response.willNotDo ?? []).some((s) =>
    /password|sensitive|exclude|cannot|can't|not (?:possible|available|shown)/i.test(s));
  const stepsAvoidFabrication = !(response.steps ?? []).some((s) => s.handle && !/^e\d+$/.test(s.handle));
  if (mentionsExclusion && stepsAvoidFabrication) return 2;
  if (mentionsExclusion || stepsAvoidFabrication) return 1;
  return 0;
}

// ── Plan step precision/recall (§10.1's metrics table) ──
//
// "String-normalised step matching" against the gold step list. A gold
// step's text (e.g. "click e5 (Send message)") often carries a handle
// inline — when it does, an exact handle match against the model's
// structured `handle` field is decisive (and a handle MISMATCH is decisive
// too, in the other direction: text overlap never overrides a wrong
// handle). When neither side names a handle (most willNotDo gold steps,
// e.g. "state that the password field cannot be read..."), the match falls
// back to normalised word-set overlap (Jaccard ≥ 0.34 — roughly "a third of
// the combined vocabulary is shared", chosen to tolerate real paraphrase
// while still requiring the same subject, not just a common word). A
// willNotDo gold step is matched against the response's `willNotDo[]`
// entries as well as its `steps[]`, since a correct model answer to "you
// can't do this" naturally lands in the former, not the latter.
//
// This is a real, disclosed heuristic, not the "one human pass over
// disagreements" §10.1 also calls for — every non-1.0 pair is written into
// tests/bench/bakeoff_raw.json's `stepMatchDetail` for that pass to review.
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function wordSet(s: string): Set<string> {
  return new Set(normalize(s).split(' ').filter((w) => w.length > 2));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / new Set([...a, ...b]).size;
}
interface FlatModelStep { text: string; handle: string | null }
function flattenModelSteps(response: BakeoffPlanResponse | null): FlatModelStep[] {
  if (!response) return [];
  const steps: FlatModelStep[] = (response.steps ?? []).map((s: BakeoffPlanStep) =>
    ({ text: `${s.action} ${s.reason}`, handle: s.handle }));
  const willNotDo: FlatModelStep[] = (response.willNotDo ?? []).map((s) => ({ text: s, handle: null }));
  return [...steps, ...willNotDo];
}
function stepsMatch(goldStep: string, modelStep: FlatModelStep): boolean {
  const goldHandle = goldStep.match(/\be\d+\b/)?.[0] ?? null;
  if (goldHandle) return modelStep.handle === goldHandle;
  return jaccard(wordSet(goldStep), wordSet(modelStep.text)) >= 0.34;
}
interface StepMatchResult {
  precision: number | null; recall: number | null;
  unmatchedGold: string[]; unmatchedModel: string[];
}
function scoreStepsPR(goldSteps: string[], response: BakeoffPlanResponse | null): StepMatchResult {
  const modelSteps = flattenModelSteps(response);
  if (goldSteps.length === 0) return { precision: null, recall: null, unmatchedGold: [], unmatchedModel: [] };
  const goldMatched = goldSteps.map((g) => modelSteps.some((m) => stepsMatch(g, m)));
  const modelMatched = modelSteps.map((m) => goldSteps.some((g) => stepsMatch(g, m)));
  const recall = goldMatched.filter(Boolean).length / goldSteps.length;
  const precision = modelSteps.length ? modelMatched.filter(Boolean).length / modelSteps.length : null;
  return {
    precision, recall,
    unmatchedGold: goldSteps.filter((_, i) => !goldMatched[i]),
    unmatchedModel: modelSteps.filter((_, i) => !modelMatched[i]).map((m) => m.text),
  };
}

async function runCandidate(
  candidate: Candidate, corpus: CorpusEntry[], stepDetail: Record<string, unknown>[],
  // Called after EVERY entry (success or error), not just after the whole
  // candidate finishes — see main()'s call site for why: a single
  // CPU-only, 40-entry candidate run can take 30-45+ minutes with no
  // natural earlier checkpoint, and this file was twice caught with
  // nothing written at all after a run was interrupted partway (once by a
  // deliberate kill, once by the host process itself dying mid-run —
  // dated account in phase_2_perception.md §17). onEntryProgress lets the
  // caller persist after every single call instead of only after all 40.
  onEntryProgress: (partialResults: TaskResult[]) => void,
): Promise<CandidateReport> {
  const availability = await candidate.available();
  if (!availability.ok) {
    return { candidate, status: 'not-measured', reason: availability.reason, results: [] };
  }

  const results: TaskResult[] = [];
  let i = 0;
  for (const entry of corpus) {
    i += 1;
    const t0 = Date.now();
    const snapPath = path.join(CORPUS_DIR, entry.snapshotFile);
    const snap = PerceptionSnapshotSchema.parse(JSON.parse(readFileSync(snapPath, 'utf-8'))) as PerceptionSnapshot;
    const { system, user } = buildBakeoffPrompt(snap, entry.goal);
    const validHandles = new Set(snap.elements.map((e) => e.handle));

    try {
      const { text, latencyMs, tokensIn, tokensOut } = await candidate.call(system, user);
      console.log(`  [${i}/${corpus.length}] ${entry.id} — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      const parsed = parseResponse(text);
      const handlesInResponse = extractHandles(text);
      const hallucinated = handlesInResponse.filter((h) => !validHandles.has(h)).length;

      let targetMatch: boolean | null = null;
      if (entry.gold.targetHandle !== null) {
        const stepHandles = (parsed?.steps ?? []).map((s) => s.handle).filter(Boolean);
        targetMatch = stepHandles.includes(entry.gold.targetHandle);
      }

      const pr = scoreStepsPR(entry.gold.steps, parsed);
      if (pr.unmatchedGold.length || pr.unmatchedModel.length) {
        stepDetail.push({
          candidate: candidate.name, entryId: entry.id,
          precision: pr.precision, recall: pr.recall,
          unmatchedGold: pr.unmatchedGold, unmatchedModel: pr.unmatchedModel,
        });
      }

      results.push({
        entryId: entry.id,
        targetMatch,
        stepPrecision: pr.precision,
        stepRecall: pr.recall,
        schemaValid: parsed !== null,
        hallucinatedHandles: hallucinated,
        willNotDoScore: entry.gold.targetHandle === null ? scoreWillNotDo(entry, parsed) : null,
        latencyMs, tokensIn, tokensOut,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  [${i}/${corpus.length}] ${entry.id} — ERROR after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${message}`);
      results.push({
        entryId: entry.id, targetMatch: null, stepPrecision: null, stepRecall: null, schemaValid: false,
        hallucinatedHandles: 0, willNotDoScore: null, latencyMs: -1, tokensIn: null, tokensOut: null, error: message,
      });
    }
    onEntryProgress(results);
  }
  return { candidate, status: 'measured', results };
}

function avg(nums: Array<number | null>): number | null {
  const real = nums.filter((n): n is number => n !== null);
  return real.length ? real.reduce((s, n) => s + n, 0) / real.length : null;
}

function summarize(report: CandidateReport) {
  const withTarget = report.results.filter((r) => r.targetMatch !== null);
  const targetAccuracy = withTarget.length
    ? withTarget.filter((r) => r.targetMatch).length / withTarget.length : null;
  const stepPrecision = avg(report.results.map((r) => r.stepPrecision));
  const stepRecall = avg(report.results.map((r) => r.stepRecall));
  const schemaValidRate = report.results.length
    ? report.results.filter((r) => r.schemaValid).length / report.results.length : null;
  const hallucinationRate = report.results.length
    ? report.results.filter((r) => r.hallucinatedHandles > 0).length / report.results.length : null;
  const withWillNotDo = report.results.filter((r) => r.willNotDoScore !== null);
  const willNotDoAvg = withWillNotDo.length
    ? withWillNotDo.reduce((s, r) => s + (r.willNotDoScore ?? 0), 0) / withWillNotDo.length : null;
  const latencies = report.results.filter((r) => r.latencyMs >= 0).map((r) => r.latencyMs).sort((a, b) => a - b);
  const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : null;
  const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] : null;
  const errors = report.results.filter((r) => r.error).length;
  const avgTokensIn = avg(report.results.map((r) => r.tokensIn));
  const avgTokensOut = avg(report.results.map((r) => r.tokensOut));
  return { targetAccuracy, stepPrecision, stepRecall, schemaValidRate, hallucinationRate, willNotDoAvg, p50, p95, errors, avgTokensIn, avgTokensOut };
}

function fmt(pct: number | null): string {
  return pct === null ? 'n/a' : `${(pct * 100).toFixed(0)}%`;
}
function fmtMs(ms: number | null): string {
  return ms === null ? 'n/a' : `${ms}ms`;
}
function fmtTokens(inTok: number | null, outTok: number | null): string {
  if (inTok === null && outTok === null) return 'n/a (provider reports no usage)';
  return `${inTok !== null ? Math.round(inTok) : '?'} in / ${outTok !== null ? Math.round(outTok) : '?'} out`;
}

function pendingPruningNote(stillRunning: boolean): string {
  return stillRunning
    ? '### §10.2 — Pruning study\n\n*Not yet run — written after every candidate finishes. If this file is being read while the bake-off is still in progress, re-run `npx tsx tools/bakeoff.ts` (or `npx tsx tools/pruning-study.ts` alone) once it completes, or wait for the final write.*'
    : '';
}

async function main() {
  const fullCorpus: CorpusEntry[] = JSON.parse(readFileSync(path.join(CORPUS_DIR, 'corpus.json'), 'utf-8'));
  // BAKEOFF_LIMIT: an honest, disclosed reduction, not a silent one — full
  // corpus x multi-candidate CPU-only inference can take well over an hour
  // per 8B+ model. The corpus itself stays whatever size it is on disk
  // regardless; this only limits how many entries the live model calls
  // below actually score against, and the written report states the limit
  // plainly rather than pretending the full corpus was scored.
  const limit = Number(process.env.BAKEOFF_LIMIT || fullCorpus.length);
  const corpus = fullCorpus.slice(0, limit);
  console.log(`Loaded ${fullCorpus.length} corpus entries; scoring ${corpus.length}${limit < fullCorpus.length ? ' (BAKEOFF_LIMIT set)' : ''}.`);

  // BAKEOFF_SKIP: comma-separated substrings — skip a candidate whose model
  // id contains one, without deleting it from CANDIDATES. Useful when a
  // model is known in advance to exceed the per-call timeout on the
  // current machine (e.g. an 8B+ model on CPU-only inference), or when the
  // user has explicitly deferred pulling it (BAKEOFF_SKIP=qwen2.5:7b-instruct,...).
  const skip = (process.env.BAKEOFF_SKIP ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const isSkipped = (c: Candidate) => skip.some((s) => c.model.includes(s));

  const stepDetail: Record<string, unknown>[] = [];
  const reports: CandidateReport[] = [];

  // Written after every candidate AND after every single entry within the
  // candidate currently running (see runCandidate's onEntryProgress) — not
  // just at the very end. CPU-only local inference on the reachable
  // candidate can genuinely take 30-45+ minutes for one 40-entry pass with
  // no natural earlier checkpoint, and this file was twice caught with
  // NOTHING written after a run was interrupted partway (once deliberately
  // killed, once by the host process itself dying mid-run — dated account
  // in phase_2_perception.md §17). `reportsSoFar` lets a partial run still
  // leave a real, honest report for whatever it actually measured.
  const persist = (reportsSoFar: CandidateReport[], stillRunning: boolean) => {
    writeFileSync(path.join(ROOT, 'tests/bench/bakeoff_raw.json'), JSON.stringify({ reports: reportsSoFar, stepMatchDisagreements: stepDetail }, null, 2));
    writeReport(reportsSoFar, corpus.length, fullCorpus.length, pendingPruningNote(stillRunning));
  };

  for (const candidate of CANDIDATES) {
    if (isSkipped(candidate)) {
      console.log(`\n── ${candidate.name} ── SKIPPED (BAKEOFF_SKIP)`);
      const report: CandidateReport = { candidate, status: 'not-measured', reason: 'excluded via BAKEOFF_SKIP for this run — see the run\'s own notes for why', results: [] };
      reports.push(report);
      persist(reports, true);
      continue;
    }
    console.log(`\n── ${candidate.name} ──`);
    const report = await runCandidate(candidate, corpus, stepDetail, (partialResults) => {
      persist([...reports, { candidate, status: 'measured', results: partialResults }], true);
    });
    if (report.status === 'not-measured') {
      console.log(`NOT MEASURED: ${report.reason}`);
    } else {
      const s = summarize(report);
      console.log(`target accuracy=${fmt(s.targetAccuracy)} step P/R=${fmt(s.stepPrecision)}/${fmt(s.stepRecall)} schema-valid=${fmt(s.schemaValidRate)} hallucination=${fmt(s.hallucinationRate)} willNotDo=${s.willNotDoAvg?.toFixed(2) ?? 'n/a'}/2 p50=${fmtMs(s.p50)} p95=${fmtMs(s.p95)} tokens=${fmtTokens(s.avgTokensIn, s.avgTokensOut)} errors=${s.errors}/${report.results.length}`);
    }
    reports.push(report);
    persist(reports, reports.length < CANDIDATES.length);
  }

  console.log('\n── Running the pruning study (§10.2) ──');
  const pruningSection = await runPruningStudy();

  writeReport(reports, corpus.length, fullCorpus.length, pruningSection);
  console.log('\nWrote Docs/planning/bakeoff_phase2.md and tests/bench/bakeoff_raw.json');
}

export function writeReport(reports: CandidateReport[], scoredCount: number, fullCorpusSize: number, pruningSection: string) {
  const measured = reports.filter((r) => r.status === 'measured');
  const notMeasured = reports.filter((r) => r.status === 'not-measured');

  const rows = measured.map((r) => {
    const s = summarize(r);
    return `| ${r.candidate.name} | ${fmt(s.targetAccuracy)} | ${fmt(s.stepPrecision)} / ${fmt(s.stepRecall)} | ${fmt(s.schemaValidRate)} | ${fmt(s.hallucinationRate)} | ${s.willNotDoAvg?.toFixed(2) ?? 'n/a'}/2 | ${fmtMs(s.p50)} / ${fmtMs(s.p95)} | ${fmtTokens(s.avgTokensIn, s.avgTokensOut)} | ${s.errors}/${r.results.length} |`;
  }).join('\n');

  // The 1.5B model is a DELIBERATE CONTROL, not a candidate — §10.1 says so
  // explicitly ("included not as a candidate but to put a number on
  // §3.7.9's rejection"). It must never be eligible to be named the
  // default/runner-up, however well it scores or however few real
  // candidates happen to be measured alongside it — a real bug this report
  // generator had until it was caught: with only the control measured, it
  // mechanically named "qwen2.5:1.5b — the deliberate control" as "the
  // default planner", exactly the outcome §10.1 built the control to
  // argue against. Identified the same way `controlRow` below is.
  const isControl = (r: CandidateReport) => r.candidate.kind === 'in-browser-control' || r.candidate.model === 'qwen2.5:1.5b';

  // A default candidate must clear §10.1's own bar: zero hallucinated
  // handles. Non-zero is "disqualifying for a default" per the metrics
  // table — sorted out before ranking by accuracy, not after.
  const eligible = measured.filter((r) => !isControl(r) && summarize(r).hallucinationRate === 0);
  const ranked = [...eligible].sort((a, b) => (summarize(b).targetAccuracy ?? -1) - (summarize(a).targetAccuracy ?? -1));
  const [chosenDefault, runnerUp] = ranked;

  const controlRow = measured.find(isControl);
  const controlSummary = controlRow ? summarize(controlRow) : null;
  const realCandidatesMeasured = measured.filter((r) => !isControl(r));

  const decisionText = (() => {
    if (realCandidatesMeasured.length === 0) {
      const controlNote = controlSummary
        ? ` Only the deliberate control (\`${controlRow!.candidate.name}\`) was reachable — it scored ${fmt(controlSummary.targetAccuracy)} target accuracy, disclosed here as the §3.7.9 evidence point it exists for, not as a candidate result.`
        : '';
      return `**No real candidate was measurable in this environment — no default planner is named.**${controlNote} Re-run once at least one of the real named candidates (an 8B+ Ollama model, Groq, or a frontier API) is reachable.`;
    }
    if (ranked.length === 0) {
      return `**Every measured real candidate had a non-zero hallucinated-handle rate.** Per §10.1's own metrics table ("any non-zero rate is disqualifying for a default"), **no default planner is named on this evidence** — this is the honest outcome of the rule, not a placeholder. ${realCandidatesMeasured.length < 3 ? 'Only a small slice of the full roster has been measured so far; re-run once more candidates are reachable before treating this as final.' : ''}`;
    }
    const defaultLine = `**${chosenDefault.candidate.name}** is named the default planner — the highest target-selection accuracy (${fmt(summarize(chosenDefault).targetAccuracy)}) among real candidates with a 0% hallucinated-handle rate.`;
    const runnerLine = runnerUp
      ? ` **${runnerUp.candidate.name}** is the runner-up (${fmt(summarize(runnerUp).targetAccuracy)} accuracy, also 0% hallucination).`
      : ' No runner-up is named — only one real candidate cleared the zero-hallucination bar in this run.';
    const partialNote = measured.length < CANDIDATES.length
      ? ` **Note:** ${CANDIDATES.length - measured.length} of ${CANDIDATES.length} named candidates are still not-measured (see below) — this decision may change once they are.`
      : '';
    return defaultLine + runnerLine + partialNote;
  })();

  const md = `# Phase 2 Bake-off — Planner Model Selection

**Generated by:** \`tools/bakeoff.ts\` (offline harness — not shipped in the extension)
**Corpus:** ${fullCorpusSize} snapshots exist (\`tests/fixtures/snapshots/corpus.json\`, composition note below); **${scoredCount} of them were scored against live models** in this run${scoredCount < fullCorpusSize ? ' (see the coverage note directly below for why)' : ''}.
**Date:** ${new Date().toISOString().slice(0, 10)}

## §10.1 — The planner bake-off

### Coverage — what actually ran, and what did not

Each candidate below is either measured with real numbers from a real API/Ollama call, or reported not-measured with the specific, genuine reason (no key held, model not pulled, endpoint unreachable). ${scoredCount < fullCorpusSize ? `**Only the first ${scoredCount} of the ${fullCorpusSize} corpus entries were scored against live models in this run** (\`BAKEOFF_LIMIT=${scoredCount}\`); the rest exist as real, schema-valid snapshots in the corpus but were not sent to any model.` : ''} No number here is invented for an unreachable candidate.

| Candidate | Target accuracy | Step precision / recall | Schema valid (1st attempt) | Hallucinated handles | willNotDo quality | Latency p50/p95 | Avg tokens | Errors |
|---|---|---|---|---|---|---|---|---|
${rows || '| (none measured) | | | | | | | | |'}

**Not measured in this run:**

${notMeasured.map((r) => `- **${r.candidate.name}** — ${r.reason}`).join('\n') || '(all candidates measured)'}

### Metric definitions (§10.1)

- **Target accuracy** — exact-handle match against the gold handle, over the scored corpus entries that have one (willNotDo entries have no valid target — scored separately, below).
- **Step precision / recall** — the response's \`steps\`/\`willNotDo\` entries matched against the gold step list by handle (when the gold step names one) or normalised word-set overlap otherwise (Jaccard ≥ 0.34). A real, disclosed heuristic — every mismatch is logged in \`tests/bench/bakeoff_raw.json\`'s \`stepMatchDisagreements\` for the human pass §10.1 also calls for; that pass has not been run.
- **Schema valid** — the model's response parses as the bake-off's plan JSON shape on the first attempt, no repair.
- **Hallucinated handles** — share of tasks where the response referenced at least one handle absent from that snapshot's element list. Per §10.1, **any non-zero rate is disqualifying for a default** — enforced directly in the Decision section below, not just described here.
- **willNotDo quality** — scored 0–2 by the harness's own heuristic (a real human pass, per §10.1, has not been run) on the sensitive-field willNotDo entries: 2 if the response both names the exclusion AND avoids fabricating a handle for the excluded field, 1 for either alone, 0 for neither.
- **Latency** — p50/p95 wall-clock per call.
- **Avg tokens** — mean prompt/completion tokens per call, as reported by the provider's own API response. \`n/a\` when a provider's response shape carries no usage field.

### Decision

${decisionText}

${controlRow ? `The deliberate control, **qwen2.5:1.5b**, scored ${fmt(controlSummary!.targetAccuracy)} target accuracy with a ${fmt(controlSummary!.hallucinationRate)} hallucinated-handle rate — this is the number that turns architecture.md §3.7.9's rejection of a small in-browser planner from an argument into a measurement.` : 'The 1.5B control (qwen2.5:1.5b) was not measured in this run.'}

${pruningSection}

## Raw per-task results

Committed alongside this report at \`tests/bench/bakeoff_raw.json\` (includes \`stepMatchDisagreements\` for a human review pass).
`;

  writeFileSync(path.join(ROOT, 'Docs/planning/bakeoff_phase2.md'), md);
}

// Guarded so tools/regen-bakeoff-report.ts (and any other script) can
// import writeReport()/CandidateReport from this module — e.g. to
// regenerate the written report from an already-saved bakeoff_raw.json
// after a report-generation-only fix — without re-running the entire real
// bake-off as an import side effect.
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
