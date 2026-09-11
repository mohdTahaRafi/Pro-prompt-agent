/**
 * WebLLM engine — the fallback judge. §5.2.
 *
 * Absorbs lib/adapters/webgpu-adapter.ts. entrypoints/offscreen/main.ts's
 * WebLLM host — the model state machine, Cache API download detection,
 * `initProgressCallback`, the VRAM keep-alive tick and the GPU-device-lost
 * recovery — is retained UNCHANGED IN MECHANISM (task 4.4): same message
 * types (`WEBGPU_LOAD_MODEL`/`WEBGPU_INFERENCE`/`WEBGPU_UNLOAD`/
 * `WEBGPU_CHECK_MODEL`), same payload shapes. What changes is that this
 * module — one engine behind lib/model/router.ts — is now the only caller,
 * in place of the old flat `FALLBACK_ORDER` cascade.
 *
 * Has NO constrained-decoding mechanism (§5.2) — a request carrying a
 * `schema` still gets sent (WebLLM ignores it), and lib/model/router.ts's
 * inferStructured() validate-and-repair path (§6.2) is what actually
 * enforces the shape when this engine serves the call.
 */
import { Ok, Err, type Result } from '@lib/utils/result';
import { ensureOffscreen } from '@lib/model/offscreen-bridge';
import type { RouteRequest, RouteResponse, RouteError } from '@lib/model/router-types';
import type { Engine } from '@lib/model/engine';
import type { ModelState, WebGPUModel } from '@lib/types/llm.types';

/** The bake-off's deliberate control (Docs/planning/bakeoff_phase2.md
 *  §10.1) — small, fast, already the WEBGPU_MODELS default a fresh install
 *  ships pointed at. Used as the judge tier's fallback default only; the
 *  planner is never this engine at all (§3.1). */
export const DEFAULT_JUDGE_MODEL: WebGPUModel = 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC';

let currentState: ModelState = 'cold';
let currentModel: WebGPUModel | null = null;

chrome.storage.local.get(['webGpuActiveModel'], (res: { webGpuActiveModel?: WebGPUModel }) => {
  if (res.webGpuActiveModel) {
    currentModel = res.webGpuActiveModel;
    currentState = 'cold';   // verified on demand, mirrors the Phase 1 adapter
  }
});

export function getWebllmState(): { state: ModelState; model: WebGPUModel | null } {
  return { state: currentState, model: currentModel };
}

export function setWebllmState(state: ModelState): void {
  currentState = state;
}

export async function checkModelDownloaded(model: WebGPUModel): Promise<boolean> {
  try {
    await ensureOffscreen();
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'WEBGPU_CHECK_MODEL', payload: { model } });
    return response?.data?.downloaded === true;
  } catch {
    return false;
  }
}

export async function loadWebllmModel(model: WebGPUModel): Promise<void> {
  currentState = 'loading';
  currentModel = model;
  chrome.storage.local.set({ webGpuActiveModel: model });
  await ensureOffscreen();

  try {
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'WEBGPU_LOAD_MODEL', payload: { model } });
    if (response?.error) {
      currentState = 'error';
      const errorMsg = response.error as string;
      if (errorMsg.includes('not found') || errorMsg.includes('404') || errorMsg.includes('fetch')) {
        throw new Error(`MODEL_NOT_DOWNLOADED: Model "${model}" needs to be downloaded first. Go to Options → Models & Settings to download.`);
      }
      if (errorMsg.includes('memory') || errorMsg.includes('OOM') || errorMsg.includes('allocation')) {
        throw new Error(`INSUFFICIENT_VRAM: Not enough GPU memory for "${model}". Try a smaller model like Qwen2.5-1.5B.`);
      }
      throw new Error(`WEBLLM_ERROR: ${errorMsg}`);
    }
    currentState = 'hot';
  } catch (err) {
    currentState = 'error';
    throw err;
  }
}

export async function unloadWebllmModel(): Promise<void> {
  await ensureOffscreen();
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'WEBGPU_UNLOAD' });
  currentState = 'cold';
  currentModel = null;
  chrome.storage.local.remove('webGpuActiveModel');
}

/** Auto-wakes a downloaded-but-cold model exactly like the Phase 1 cascade
 *  did, rather than failing a judge call that could succeed with one more
 *  await — the fallback-within-a-locality freedom §4.2 grants. */
async function ensureHot(): Promise<Result<void, RouteError>> {
  if (currentState === 'hot' && currentModel) return Ok(undefined);

  const target = currentModel ?? DEFAULT_JUDGE_MODEL;
  if (currentState === 'loading') return Err('ENGINE_DOWNLOADING');

  const downloaded = await checkModelDownloaded(target);
  if (!downloaded) return Err('ENGINE_UNAVAILABLE', `WebLLM model ${target} is not downloaded.`);

  try {
    await loadWebllmModel(target);
    return Ok(undefined);
  } catch (e) {
    return Err('ENGINE_UNAVAILABLE', String(e));
  }
}

function userText(user: RouteRequest['user']): string {
  return typeof user === 'string' ? user : user.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

export const webllmEngine: Engine = {
  id: 'webllm',
  isRemote: false,
  async infer(req: RouteRequest): Promise<Result<RouteResponse, RouteError>> {
    if (req.signal?.aborted) return Err('ABORTED');
    const hot = await ensureHot();
    if (!hot.ok) return hot;

    const start = performance.now();
    try {
      const result = await chrome.runtime.sendMessage({
        target: 'offscreen', type: 'WEBGPU_INFERENCE',
        payload: {
          messages: [{ role: 'system', content: req.system }, { role: 'user', content: userText(req.user) }],
          maxTokens: req.maxTokens ?? 1_024, temperature: req.temperature ?? 0.7,
        },
      });
      if (result?.error) return Err('ENGINE_FAILED', result.error);
      return Ok({
        content: result?.data?.content ?? '', constrained: false,
        tokensUsed: result?.data?.tokensUsed, latencyMs: Math.round(performance.now() - start),
        engine: 'webllm', tier: req.tier,
      });
    } catch (e) {
      return Err('ENGINE_FAILED', String(e));
    }
  },
};
