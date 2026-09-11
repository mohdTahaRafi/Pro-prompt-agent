/**
 * Offscreen Document — local inference engine host.
 *
 * Hosts TWO engines for in-browser inference, both reachable only from a
 * document context (Phase 1's Q11 spike; lib/model/offscreen-bridge.ts's
 * header):
 *  - @mlc-ai/web-llm, the WebLLM judge-tier fallback (unchanged mechanism —
 *    Docs/planning/phase_4_model_tiers_routing.md §5.2, task 4.4).
 *  - Chrome's built-in Prompt API (`LanguageModel`) — the judge/vision/
 *    inline primary engine (§5.1, task 4.3). ONE warm base session per
 *    system prompt, `clone()`'d per request — the mechanism the 400ms
 *    inline budget (§9) depends on.
 *
 * Communicates with the service worker via chrome.runtime messaging.
 *
 * WebLLM model lifecycle:
 *   cold → loading (CreateMLCEngine) → hot → inference → hot
 *                                     → error (catch + report)
 *
 * Keep-alive: 20-second GPU no-op to prevent VRAM eviction.
 *
 * NOTE: This file is a WXT entrypoint so that bare module specifiers
 * (e.g. '@mlc-ai/web-llm') are properly resolved by the bundler.
 * Previously, this code lived in a raw <script> in public/offscreen.html,
 * which broke because browsers cannot resolve bare specifiers without a bundler.
 */

// [Phase 4 §12] `@mlc-ai/web-llm` is dynamic-imported, not a static import,
// so it is excluded from offscreen.html's eager modulepreload (§12's
// "Offscreen bundle ≤ 250KB gzipped, excluding lazily-loaded WebLLM" row) —
// a Local-only user on the Prompt API path, or a Hybrid user who never
// loads the WebLLM fallback, never pays for its multi-megabyte bundle at
// all. Loaded once, on the FIRST WEBGPU_LOAD_MODEL call, and cached in
// `webllmModule` for every call after.
import type { CreateMLCEngine as CreateMLCEngineType, MLCEngine } from '@mlc-ai/web-llm';
let webllmModule: { CreateMLCEngine: typeof CreateMLCEngineType } | null = null;
async function loadWebllmModule() {
  if (!webllmModule) webllmModule = await import('@mlc-ai/web-llm');
  return webllmModule;
}

let engine: MLCEngine | null = null;
let modelState: 'cold' | 'loading' | 'hot' | 'error' = 'cold';
let currentModel: string | null = null;

// ═══ Prompt API — warm base session + clone() per request (§5.1) ═══

let promptApiBase: LanguageModelSession | null = null;
let promptApiBaseSystem = '';
const promptApiInflight = new Map<string, AbortController>();
// §5.1's "warm-session hit rate is a budget line (≥95%)" — instrumented
// here (every infer records clone vs create) and surfaced through
// PROMPT_API_STATS for the Models tab / a bench script to read.
const promptApiStats = { clones: 0, creates: 0 };

type BaseResult = { ok: true; value: LanguageModelSession } | { ok: false; error: string };

async function ensurePromptApiBase(system: string): Promise<BaseResult> {
  if (promptApiBase && promptApiBaseSystem === system) return { ok: true, value: promptApiBase };
  if (typeof LanguageModel === 'undefined') return { ok: false, error: 'ENGINE_UNAVAILABLE' };

  const availability = await LanguageModel.availability();
  if (availability === 'unavailable') return { ok: false, error: 'ENGINE_UNAVAILABLE' };
  if (availability === 'downloadable' || availability === 'downloading') {
    // Trigger the download once, report progress, and fail THIS call rather
    // than blocking a 400ms inline budget behind a multi-hundred-megabyte
    // fetch (§5.1).
    void LanguageModel.create({
      initialPrompts: [{ role: 'system', content: system }],
      // Reuses the exact MODEL_STATE_CHANGED broadcast the WebLLM path
      // already emits (and entrypoints/background.ts already special-cases
      // before schema validation) rather than inventing a second type.
      monitor: (m) => m.addEventListener('downloadprogress', (e) => {
        chrome.runtime.sendMessage({
          type: 'MODEL_STATE_CHANGED',
          payload: { state: 'loading', progress: e.loaded, text: 'Downloading the Chrome built-in model…' },
        }).catch(() => {});
      }),
    }).catch(() => {});
    return { ok: false, error: 'ENGINE_DOWNLOADING' };
  }

  promptApiBase?.destroy();
  promptApiStats.creates++;
  promptApiBase = await LanguageModel.create({ initialPrompts: [{ role: 'system', content: system }] });
  promptApiBaseSystem = system;
  return { ok: true, value: promptApiBase };
}

// ═══ Keep-Alive: Prevent VRAM eviction ═══
let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
let gpuDevice: GPUDevice | null = null;

async function initGPUKeepAlive() {
  try {
    if (!navigator.gpu) {
      console.warn('[Offscreen] WebGPU not available');
      return;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return;
    gpuDevice = await adapter.requestDevice();
    gpuDevice.lost.then(() => {
      console.warn('[Offscreen] GPU device lost — re-acquiring in 5s');
      modelState = 'cold';
      gpuDevice = null;
      setTimeout(initGPUKeepAlive, 5000);
    });

    // No-op GPU tick every 20 seconds to prevent VRAM eviction
    keepAliveInterval = setInterval(() => {
      if (!gpuDevice) return;
      try {
        const buf = gpuDevice.createBuffer({
          size: 4,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        buf.destroy();
      } catch {
        // GPU device may have been lost
      }
    }, 20_000);
  } catch (e) {
    console.error('[Offscreen] GPU init failed:', e);
  }
}

initGPUKeepAlive();

// ═══ Message Handler ═══
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  const handler = async (): Promise<any> => {
    try {
      switch (message.type) {
        case 'WEBGPU_LOAD_MODEL': {
          const { model } = message.payload;
          modelState = 'loading';
          currentModel = model;

          try {
            const { CreateMLCEngine } = await loadWebllmModule();
            engine = await CreateMLCEngine(model, {
              initProgressCallback: (report: { progress: number; text: string }) => {
                console.log(`[WebLLM] ${report.text}`);
                // Notify SW of progress
                chrome.runtime
                  .sendMessage({
                    type: 'MODEL_STATE_CHANGED',
                    payload: {
                      state: 'loading',
                      progress: report.progress,
                      text: report.text,
                    },
                  })
                  .catch(() => {});
              },
            });
            modelState = 'hot';
            return { status: 'success', data: { state: 'hot', model } };
          } catch (err: any) {
            modelState = 'error';
            return { error: err.message || String(err) };
          }
        }

        case 'WEBGPU_INFERENCE': {
          if (!engine || modelState !== 'hot') {
            return { error: `Model not ready (state: ${modelState})` };
          }

          const { messages, maxTokens, temperature, stop } = message.payload;
          const result = await engine.chat.completions.create({
            messages,
            max_tokens: maxTokens || 1024,
            temperature: temperature || 0.7,
            stream: false,
            ...(stop ? { stop } : {}),
          });

          const content = result.choices?.[0]?.message?.content || '';
          const tokensUsed = result.usage?.total_tokens;
          return { data: { content, tokensUsed } };
        }

        case 'WEBGPU_UNLOAD': {
          if (engine) {
            await engine.unload?.();
            engine = null;
          }
          modelState = 'cold';
          currentModel = null;
          return { status: 'success' };
        }

        case 'WEBGPU_CHECK_MODEL': {
          // Check if model weights exist in cache/IndexedDB
          const { model } = message.payload;
          try {
            // WebLLM stores models in Cache API
            const cache = await caches.open('webllm/model');
            const keys = await cache.keys();
            const found = keys.some((key) => key.url.includes(model));
            return { data: { downloaded: found } };
          } catch {
            return { data: { downloaded: false } };
          }
        }

        case 'GET_STATE':
        case 'HEARTBEAT_PING':
          return {
            status: 'alive',
            data: { state: modelState, model: currentModel },
          };

        // ═══ Prompt API (§5.1) ═══

        case 'PROMPT_API_AVAILABILITY': {
          if (typeof LanguageModel === 'undefined') return { data: { availability: 'unavailable' } };
          try {
            return { data: { availability: await LanguageModel.availability() } };
          } catch {
            return { data: { availability: 'unavailable' } };
          }
        }

        case 'PROMPT_API_STATS':
          return { data: { ...promptApiStats } };

        case 'PROMPT_API_ABORT': {
          const { requestId } = message.payload;
          promptApiInflight.get(requestId)?.abort();
          return { status: 'success' };
        }

        case 'PROMPT_API_INFER': {
          const { requestId, system, user, maxTokens, temperature, jsonSchema } = message.payload;
          const t0 = performance.now();
          const b = await ensurePromptApiBase(system);
          if (!b.ok) return { error: b.error };

          const controller = new AbortController();
          promptApiInflight.set(requestId, controller);
          let session: LanguageModelSession | null = null;
          try {
            // clone() shares the base's already-processed system prompt and
            // costs single-digit ms; a fresh create() per request costs
            // hundreds — this is the mechanism the 400ms budget depends on.
            session = await b.value.clone({ signal: controller.signal });
            promptApiStats.clones++;
            const out = await session.prompt(user, {
              signal: controller.signal,
              ...(jsonSchema ? { responseConstraint: jsonSchema, omitResponseConstraintInput: true } : {}),
            });
            return {
              data: { content: out, tokensUsed: session.inputUsage, latencyMs: Math.round(performance.now() - t0) },
            };
          } catch (err: any) {
            if (err?.name === 'AbortError') return { error: 'ABORTED' };
            // The prompt is larger than the session's input quota.
            if (err?.name === 'QuotaExceededError') return { error: 'CONTEXT_TOO_LARGE' };
            return { error: `ENGINE_FAILED: ${err?.message ?? String(err)}` };
          } finally {
            session?.destroy();
            promptApiInflight.delete(requestId);
          }
        }

        default:
          return { error: `Unknown offscreen message type: ${message.type}` };
      }
    } catch (err: any) {
      return { error: err.message || String(err) };
    }
  };

  handler()
    .then(sendResponse)
    .catch((err) => sendResponse({ error: String(err) }));
  return true; // Async response
});

console.log('[Offscreen] WebLLM host ready');
