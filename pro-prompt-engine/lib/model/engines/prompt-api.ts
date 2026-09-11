/**
 * Prompt API engine — Chrome's built-in `LanguageModel`. §5.1.
 *
 * The warm base session + `clone()`-per-request logic this phase depends on
 * (the 400ms inline budget, §9) needs `LanguageModel` itself, which Phase
 * 1's spike (Q11) found reachable only from the offscreen document, not the
 * service worker — the same reason WebLLM has lived in
 * entrypoints/offscreen/main.ts since Phase 1. So, like
 * lib/model/engines/webllm.ts, THIS file is the thin service-worker-side
 * proxy: it holds no session state and sends one message per call to the
 * offscreen document, which is where the real base/clone/prompt logic lives
 * (entrypoints/offscreen/main.ts's PROMPT_API_* handlers). That split is
 * also what "the two message hops to the offscreen document" (§9) refers
 * to — content script → service worker (this file) → offscreen document.
 *
 * AbortSignal cannot cross chrome.runtime.sendMessage (it is not
 * structured-cloneable in a usable form), so a signal abort here is
 * forwarded as a second, explicit PROMPT_API_ABORT message carrying the
 * same requestId — the offscreen side's in-flight controller answers to it.
 */
import { Ok, Err, type Result } from '@lib/utils/result';
import { ensureOffscreen } from '@lib/model/offscreen-bridge';
import type { RouteRequest, RouteResponse, RouteError } from '@lib/model/router-types';
import type { Engine } from '@lib/model/engine';

export type PromptApiAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unreachable';

export async function probePromptApiAvailability(): Promise<PromptApiAvailability> {
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'PROMPT_API_AVAILABILITY' });
    return (res?.data?.availability as PromptApiAvailability) ?? 'unavailable';
  } catch {
    return 'unreachable';
  }
}

function userToOffscreenPayload(user: RouteRequest['user']) {
  if (typeof user === 'string') return user;
  // Phase 10 is the only caller that will ever pass image parts (vision
  // tier); serialised as-is so the offscreen side's LanguageModel.prompt()
  // multimodal content array receives them unchanged.
  return user;
}

export const promptApiEngine: Engine = {
  id: 'prompt-api',
  isRemote: false,
  async infer(req: RouteRequest): Promise<Result<RouteResponse, RouteError>> {
    if (req.signal?.aborted) return Err('ABORTED');
    await ensureOffscreen();

    const requestId = crypto.randomUUID();
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'PROMPT_API_ABORT', payload: { requestId } }).catch(() => {});
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const jsonSchema = req.schema ? (await import('zod')).z.toJSONSchema(req.schema) : undefined;
      const res = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'PROMPT_API_INFER',
        payload: {
          requestId, system: req.system, user: userToOffscreenPayload(req.user),
          maxTokens: req.maxTokens, temperature: req.temperature, jsonSchema,
        },
      }).catch((e) => ({ error: String(e) }));

      if (aborted || req.signal?.aborted) return Err('ABORTED');
      if (!res || res.error) {
        const message: string = res?.error ?? '';
        if (message.startsWith('ENGINE_DOWNLOADING')) return Err('ENGINE_DOWNLOADING');
        if (message.startsWith('ENGINE_UNAVAILABLE')) return Err('ENGINE_UNAVAILABLE');
        if (message.startsWith('CONTEXT_TOO_LARGE')) return Err('CONTEXT_TOO_LARGE');
        if (message.startsWith('ABORTED')) return Err('ABORTED');
        return Err('ENGINE_FAILED', message);
      }
      return Ok({
        content: res.data.content, constrained: Boolean(jsonSchema),
        tokensUsed: res.data.tokensUsed, latencyMs: res.data.latencyMs,
        engine: 'prompt-api', tier: req.tier,
      });
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }
  },
};
