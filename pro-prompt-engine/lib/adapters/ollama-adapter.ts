/**
 * Ollama HTTP Adapter — Local model inference via Ollama desktop app.
 */
import type { LLMRequest, LLMResponse } from '@lib/types/llm.types';

const DEFAULT_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3.1';

export async function ollamaInfer(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
  const start = performance.now();
  const { baseUrl, model } = await getOllamaConfig();

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages: [
        ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
        { role: 'user', content: request.userPrompt },
      ],
      stream: false,
      options: {
        temperature: request.temperature ?? 0.7,
        num_predict: request.maxTokens ?? 1024,
        ...(request.stopSequences?.length ? { stop: request.stopSequences } : {}),
      },
    }),
  });

  if (!res.ok) throw new Error(`Ollama error (${res.status})`);
  const data = await res.json();

  return {
    content: data.message?.content ?? '',
    provider: 'ollama',
    tokensUsed: data.eval_count,
    latencyMs: Math.round(performance.now() - start),
    wasFallback: false,
  };
}

export async function checkOllamaHealth(): Promise<boolean> {
  try {
    const { baseUrl } = await getOllamaConfig();
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

async function getOllamaConfig(): Promise<{ baseUrl: string; model: string }> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['ollamaBaseUrl', 'ollamaModel'], (r: { ollamaBaseUrl?: string; ollamaModel?: string }) => {
      resolve({ baseUrl: r.ollamaBaseUrl || DEFAULT_URL, model: r.ollamaModel || DEFAULT_MODEL });
    });
  });
}
