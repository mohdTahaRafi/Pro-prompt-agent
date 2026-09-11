/**
 * Remote engine — OpenAI-compatible chat completions on a user-held key.
 * §5.4. Covers Groq, OpenAI, OpenRouter, Together and most local gateways.
 *
 * Absorbs lib/adapters/groq-adapter.ts (Phase 1 PRE-5's key-migration
 * behaviour is kept, generalised from `groqApiKey`/`groqModel` to a
 * provider-agnostic `remoteApiKey`/`remoteBaseUrl`/`remoteModel` — a user
 * who already configured Groq keeps working with zero action; the fields
 * below migrate the legacy keys exactly once, the same way the old code
 * migrated storage.sync → storage.local).
 *
 * The host permission is optional and requested at key-entry time
 * (Phase 1 §4.1) — see setRemoteConfig()'s grantRemoteHost(). A user who
 * never configures a remote key never grants the extension access to any
 * remote host at all.
 */
import { Ok, Err, type Result } from '@lib/utils/result';
import * as journal from '@lib/agent/journal';
import type { RouteRequest, RouteResponse, RouteError } from '@lib/model/router-types';
import type { Engine } from '@lib/model/engine';

export const DEFAULT_REMOTE_BASE_URL = 'https://api.groq.com/openai/v1';
export const DEFAULT_REMOTE_MODEL = 'llama-3.3-70b-versatile';
export const DEFAULT_REMOTE_LABEL = 'Groq';

interface RemoteConfig { apiKey: string; baseUrl: string; model: string; label: string }
interface RemoteStorageShape {
  remoteApiKey?: string; remoteBaseUrl?: string; remoteModel?: string; remoteLabel?: string;
  groqApiKey?: string; groqModel?: string;   // legacy, migrated once below
}

async function getRemoteConfig(): Promise<RemoteConfig> {
  const local = await chrome.storage.local.get<RemoteStorageShape>([
    'remoteApiKey', 'remoteBaseUrl', 'remoteModel', 'remoteLabel', 'groqApiKey', 'groqModel',
  ]);
  if (local.remoteApiKey) {
    return {
      apiKey: local.remoteApiKey,
      baseUrl: local.remoteBaseUrl || DEFAULT_REMOTE_BASE_URL,
      model: local.remoteModel || DEFAULT_REMOTE_MODEL,
      label: local.remoteLabel || DEFAULT_REMOTE_LABEL,
    };
  }
  // [Phase 4] one-time migration of the Phase 1 Groq-only fields into the
  // provider-agnostic ones, mirroring groq-adapter.ts's own sync→local
  // migration so a key entered before this phase shipped is never lost.
  if (local.groqApiKey) {
    const migrated: RemoteConfig = {
      apiKey: local.groqApiKey, baseUrl: DEFAULT_REMOTE_BASE_URL,
      model: local.groqModel || DEFAULT_REMOTE_MODEL, label: DEFAULT_REMOTE_LABEL,
    };
    await chrome.storage.local.set({
      remoteApiKey: migrated.apiKey, remoteBaseUrl: migrated.baseUrl,
      remoteModel: migrated.model, remoteLabel: migrated.label,
    });
    return migrated;
  }
  return { apiKey: '', baseUrl: DEFAULT_REMOTE_BASE_URL, model: DEFAULT_REMOTE_MODEL, label: DEFAULT_REMOTE_LABEL };
}

export async function hasRemoteKeyConfigured(): Promise<boolean> {
  const { apiKey } = await getRemoteConfig();
  return apiKey.length > 0;
}

export async function getRemoteDestination(): Promise<{ host: string; label: string } | null> {
  const { apiKey, baseUrl, label } = await getRemoteConfig();
  if (!apiKey) return null;
  try { return { host: new URL(baseUrl).host, label }; } catch { return { host: baseUrl, label }; }
}

/** Called from the dashboard's key-entry flow, inside the user gesture
 *  handler — chrome.permissions.request throws otherwise (§5.4, mirroring
 *  lib/policy/scope.ts's grantOrigin doc comment). */
export async function setRemoteConfig(patch: Partial<Omit<RemoteConfig, 'apiKey'>> & { apiKey?: string }): Promise<boolean> {
  if (patch.baseUrl) {
    let origin: string;
    try { origin = new URL(patch.baseUrl).origin; } catch { return false; }
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) return false;
  }
  const update: Record<string, string> = {};
  if (patch.apiKey !== undefined) update.remoteApiKey = patch.apiKey;
  if (patch.baseUrl !== undefined) update.remoteBaseUrl = patch.baseUrl;
  if (patch.model !== undefined) update.remoteModel = patch.model;
  if (patch.label !== undefined) update.remoteLabel = patch.label;
  await chrome.storage.local.set(update);
  return true;
}

function userText(user: RouteRequest['user']): string {
  return typeof user === 'string' ? user : user.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

export const remoteEngine: Engine = {
  id: 'remote',
  isRemote: true,
  async infer(req: RouteRequest): Promise<Result<RouteResponse, RouteError>> {
    const start = performance.now();
    const { apiKey, baseUrl, model, label } = await getRemoteConfig();
    if (!apiKey) return Err('ENGINE_UNAVAILABLE', 'No remote API key configured.');
    if (req.signal?.aborted) return Err('ABORTED');

    const jsonSchema = req.schema ? (await import('zod')).z.toJSONSchema(req.schema) : undefined;

    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: req.signal,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: userText(req.user) },
          ],
          max_tokens: req.maxTokens ?? 1_500,
          temperature: req.temperature ?? 0.2,
          // §6.1: structured output where the provider supports it (Groq,
          // OpenAI). A provider that rejects this field for an unknown
          // reason falls through to inferStructured's validate-and-repair
          // path (§6.2) exactly like a provider that never supported it.
          ...(jsonSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'response', schema: jsonSchema, strict: true } } } : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return Err('ENGINE_FAILED', `Remote provider error (${res.status}): ${body.slice(0, 500)}`);
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content ?? '';
      const promptTokens = data.usage?.prompt_tokens;
      const completionTokens = data.usage?.completion_tokens;
      const latencyMs = Math.round(performance.now() - start);

      // §5.4, defence 5 (§7.3): every remote call is journaled with tier,
      // provider, host and token counts — never the payload itself, which
      // would defeat the retention story a Class B condensation exists for.
      if (req.runId !== undefined) {
        let host = baseUrl;
        try { host = new URL(baseUrl).host; } catch { /* keep raw baseUrl */ }
        await journal.append(req.runId, 'inference.remote', null, {
          tier: req.tier, provider: label, host, promptTokens, completionTokens,
          disclosureClass: req.disclosureClass ?? null,
        });
      }

      return Ok({ content, constrained: Boolean(jsonSchema), tokensUsed: data.usage?.total_tokens, latencyMs, engine: 'remote', tier: req.tier });
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return Err('ABORTED');
      return Err('ENGINE_FAILED', String(e));
    }
  },
};
