/**
 * Groq REST API Adapter
 * Cloud fallback with PII scrubbing pre-applied by the service worker.
 */
import type { LLMRequest, LLMResponse } from '@lib/types/llm.types';

// [Phase 1 PRE-5] llama-3.1-70b-versatile was decommissioned by Groq.
// Also surfaced as an editable field in the dashboard (options/App.tsx) so a
// hard-coded provider model id going stale again doesn't need an extension
// update to fix.
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

export async function groqInfer(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
  const start = performance.now();

  const { apiKey, model } = await getGroqConfig();
  if (!apiKey) throw new Error('Groq API key not configured. Set it in Settings.');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    signal,
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages: [
        ...(request.systemPrompt ? [{ role: 'system' as const, content: request.systemPrompt }] : []),
        { role: 'user' as const, content: request.userPrompt },
      ],
      max_tokens: request.maxTokens ?? 1024,
      temperature: request.temperature ?? 0.7,
      ...(request.stopSequences?.length ? { stop: request.stopSequences } : {}),
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(`Groq API error (${res.status}): ${errorBody}`);
  }

  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    provider: 'groq',
    tokensUsed: data.usage?.total_tokens,
    latencyMs: Math.round(performance.now() - start),
    wasFallback: false,
  };
}

export async function checkGroqHealth(): Promise<boolean> {
  try {
    const { apiKey } = await getGroqConfig();
    if (!apiKey) return false;
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch { return false; }
}

/**
 * [Phase 1 PRE-5] The key lives in storage.local, never storage.sync — sync
 * replicates to every browser signed into the same Google account, so a key
 * entered on a work machine would appear on a personal one. On first read
 * after upgrade this migrates any existing synced copy into storage.local
 * and DELETES the synced copy — leaving it behind would mean the key is
 * still replicated and the fix would be cosmetic only. keyMigrationNotice is
 * how the dashboard shows a one-time notice explaining the move.
 */
interface GroqStorageShape { groqApiKey?: string; groqModel?: string }

async function getGroqConfig(): Promise<{ apiKey: string; model: string }> {
  const local = await chrome.storage.local.get<GroqStorageShape>(['groqApiKey', 'groqModel']);
  if (local.groqApiKey) return { apiKey: local.groqApiKey, model: local.groqModel || DEFAULT_MODEL };

  const synced = await chrome.storage.sync.get<GroqStorageShape>(['groqApiKey', 'groqModel']);
  if (synced.groqApiKey) {
    await chrome.storage.local.set({ groqApiKey: synced.groqApiKey, groqModel: synced.groqModel || DEFAULT_MODEL });
    await chrome.storage.sync.remove(['groqApiKey', 'groqModel']);
    await chrome.storage.local.set({ keyMigrationNotice: Date.now() });
    return { apiKey: synced.groqApiKey, model: synced.groqModel || DEFAULT_MODEL };
  }
  return { apiKey: '', model: DEFAULT_MODEL };
}
