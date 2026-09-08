/**
 * LLM Router — Hybrid Fallback Chain
 * WebGPU (local) → Ollama (local) → Groq (cloud)
 *
 * NEW: Pre-checks model download state before routing to WebGPU.
 * If model is missing/errored, sends MODEL_DOWNLOAD_REQUIRED to UI and falls back.
 */

import { groqInfer, checkGroqHealth } from './groq-adapter';
import { ollamaInfer, checkOllamaHealth } from './ollama-adapter';
import { webgpuInfer, getWebGPUState, checkModelDownloaded, loadWebGPUModel } from './webgpu-adapter';
import { scrubPII } from '@lib/utils/pii-scrubber';
import type { LLMRequest, LLMResponse, ModelProvider } from '@lib/types/llm.types';

const FALLBACK_ORDER: ModelProvider[] = ['webgpu', 'ollama', 'groq'];

export async function routeInference(request: LLMRequest): Promise<LLMResponse> {
  const preferred = request.provider || await getActiveProvider();
  const order = [preferred, ...FALLBACK_ORDER.filter(p => p !== preferred)];

  let lastError: Error | null = null;

  for (const provider of order) {
    try {
      switch (provider) {
        case 'webgpu': {
          const { state, model } = getWebGPUState();
          if (state !== 'hot' || !model) {
            // Check if model is downloaded but not loaded
            if (model && state === 'cold') {
              const downloaded = await checkModelDownloaded(model);
              if (!downloaded) {
                console.warn('[Router] WebGPU model not downloaded — skipping');
                continue;
              }
              // Auto-load it since it's cached!
              console.log('[Router] Auto-waking WebGPU model into VRAM...');
              await loadWebGPUModel(model);
            } else {
              console.log(`[Router] WebGPU state is ${state} — skipping to next provider`);
              continue;
            }
          }
          const result = await webgpuInfer(request);
          result.wasFallback = provider !== preferred;
          return result;
        }

        case 'ollama': {
          const healthy = await checkOllamaHealth();
          if (!healthy) { console.log('[Router] Ollama offline — skipping'); continue; }
          const result = await ollamaInfer(request);
          result.wasFallback = provider !== preferred;
          return result;
        }

        case 'groq': {
          // PII scrubbing for cloud API
          const scrubbedRequest = { ...request };
          const { cleaned: cleanedUser } = scrubPII(request.userPrompt);
          scrubbedRequest.userPrompt = cleanedUser;
          if (request.systemPrompt) {
            const { cleaned: cleanedSystem } = scrubPII(request.systemPrompt);
            scrubbedRequest.systemPrompt = cleanedSystem;
          }
          const result = await groqInfer(scrubbedRequest);
          result.wasFallback = provider !== preferred;
          return result;
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Router] ${provider} failed:`, lastError.message);
    }
  }

  throw lastError || new Error('All LLM providers failed');
}

export async function getActiveProvider(): Promise<ModelProvider> {
  return new Promise((resolve) => {
    chrome.storage.local.get('activeProvider', (r: { activeProvider?: ModelProvider }) => resolve(r.activeProvider || 'webgpu'));
  });
}

export async function setActiveProvider(provider: ModelProvider): Promise<void> {
  await chrome.storage.local.set({ activeProvider: provider });
}

export async function getProviderStatus(): Promise<Record<ModelProvider, { available: boolean; state?: string }>> {
  const [groqOk, ollamaOk] = await Promise.all([checkGroqHealth(), checkOllamaHealth()]);
  const { state: webgpuState } = getWebGPUState();
  return {
    groq: { available: groqOk },
    ollama: { available: ollamaOk },
    webgpu: { available: webgpuState === 'hot', state: webgpuState },
  };
}
