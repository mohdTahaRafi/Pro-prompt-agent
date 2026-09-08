/**
 * WebGPU Adapter — @mlc-ai/web-llm via Offscreen Document
 *
 * Architecture:
 *   Service Worker → chrome.runtime.sendMessage → Offscreen Document → WebLLM engine
 *
 * NEW: Robust model error handling
 * - Pre-checks if model is downloaded (IndexedDB check via offscreen)
 * - Wraps engine.reload() in try/catch
 * - Sends MODEL_DOWNLOAD_REQUIRED to UI on failure
 */
import type { LLMRequest, LLMResponse, ModelState, WebGPUModel } from '@lib/types/llm.types';

let currentState: ModelState = 'cold';
let currentModel: WebGPUModel | null = null;

// Initialize on load to restore state across SW restarts
chrome.storage.local.get(['webGpuActiveModel'], (res: { webGpuActiveModel?: WebGPUModel }) => {
  if (res.webGpuActiveModel) {
    currentModel = res.webGpuActiveModel;
    currentState = 'cold'; // Will be verified on demand
  }
});

/**
 * Run inference via the offscreen document's WebLLM engine.
 * Checks model state first — if cold/error, throws with actionable message.
 */
export async function webgpuInfer(request: LLMRequest): Promise<LLMResponse> {
  const start = performance.now();

  if (currentState !== 'hot') {
    throw new Error(`WebGPU model is ${currentState}. ${
      currentState === 'cold'
        ? 'Please download and load a model from the Options page.'
        : currentState === 'loading'
          ? 'Model is still loading. Please wait.'
          : 'Model encountered an error. Try re-downloading from Options.'
    }`);
  }

  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'WEBGPU_INFERENCE',
    payload: {
      messages: [
        ...(request.systemPrompt
          ? [{ role: 'system', content: request.systemPrompt }]
          : []),
        { role: 'user', content: request.userPrompt },
      ],
      maxTokens: request.maxTokens ?? 1024,
      temperature: request.temperature ?? 0.7,
      stop: request.stopSequences,
    },
  });

  if (response?.error) throw new Error(response.error);

  return {
    content: response?.data?.content ?? '',
    provider: 'webgpu',
    tokensUsed: response?.data?.tokensUsed,
    latencyMs: Math.round(performance.now() - start),
    wasFallback: false,
  };
}

/**
 * Load a WebLLM model via the offscreen document.
 * Includes robust error handling with specific error types.
 */
export async function loadWebGPUModel(model: WebGPUModel): Promise<void> {
  currentState = 'loading';
  currentModel = model;
  chrome.storage.local.set({ webGpuActiveModel: model });

  try {
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'WEBGPU_LOAD_MODEL',
      payload: { model },
    });

    if (response?.error) {
      currentState = 'error';
      const errorMsg = response.error as string;

      // Classify error for UI messaging
      if (errorMsg.includes('not found') || errorMsg.includes('404') || errorMsg.includes('fetch')) {
        throw new Error(`MODEL_NOT_DOWNLOADED: Model "${model}" needs to be downloaded first. Go to Options → Settings to download.`);
      }
      if (errorMsg.includes('memory') || errorMsg.includes('OOM') || errorMsg.includes('allocation')) {
        throw new Error(`INSUFFICIENT_VRAM: Not enough GPU memory for "${model}". Try a smaller model like Qwen2.5-1.5B.`);
      }
      throw new Error(`WEBGPU_ERROR: ${errorMsg}`);
    }

    currentState = 'hot';
    console.log(`[WebGPU] Model ${model} loaded successfully`);
  } catch (err) {
    currentState = 'error';
    throw err;
  }
}

export async function unloadWebGPUModel(): Promise<void> {
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'WEBGPU_UNLOAD' });
  currentState = 'cold';
  currentModel = null;
  chrome.storage.local.remove('webGpuActiveModel');
}

export function getWebGPUState(): { state: ModelState; model: WebGPUModel | null } {
  return { state: currentState, model: currentModel };
}

export function setWebGPUState(state: ModelState): void {
  currentState = state;
}

/**
 * Check if a WebGPU model's weights exist in IndexedDB (already downloaded).
 */
export async function checkModelDownloaded(model: WebGPUModel): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'WEBGPU_CHECK_MODEL',
      payload: { model },
    });
    return response?.data?.downloaded === true;
  } catch {
    return false;
  }
}
