/**
 * Background Service Worker — Pro Prompt Engine
 *
 * WXT entrypoint: auto-registers as MV3 service worker.
 * Handles all message routing and lifecycle management.
 *
 * [Phase 1 §5.6] The three-layer keep-alive (SW setInterval ping, the
 * 'sw-keepalive' alarm, and content.ts's ping-back) is deleted. It existed
 * to keep the service worker alive across a ~30s WebLLM inference; every
 * action wakes the SW by message anyway, and with the run loop moving to the
 * offscreen document in Phase 5 nothing needs it. It also messaged every
 * open tab every 20 seconds via chrome.tabs, which the extension has no
 * `tabs` permission for — chrome.tabs.query/sendMessage do not throw
 * without it, they silently return stripped results (§2), which is why the
 * defect survived undetected. Retained: the offscreen document's own GPU
 * no-op tick (offscreen/main.ts) — it solves VRAM eviction, a different
 * problem, and is unaffected by any of this.
 */

import { routeInference, getActiveProvider, setActiveProvider, getProviderStatus } from '@lib/adapters/llm-router';
import { loadWebGPUModel, unloadWebGPUModel } from '@lib/adapters/webgpu-adapter';
import { cacheManager } from '@lib/cache/cache-manager';
import { seedDefaultProfiles, seedDefaultSnippets } from '@lib/db/dexie-db';
import { scrubPII, hasPII } from '@lib/utils/pii-scrubber';
import { scorePrompt } from '@lib/agents/scorer';
import { generatePrompt } from '@lib/agents/generator';
import { runRefactorLoop } from '@lib/agents/loop-controller';
import { comprehendContext } from '@lib/agents/comprehension';
import { grantOrigin, revokeOrigin, reconcileGrants } from '@lib/policy/scope';
import { getActiveSitePolicies } from '@lib/db/policy-store';
import { ExtensionRequest } from '@lib/schemas/message.schema';
import type { LLMRequest } from '@lib/types/llm.types';
import type { ExtensionMessage, ExtensionResponse } from '@lib/types/message.types';
import type { Profile } from '@lib/types/profile.types';
import type { Snippet } from '@lib/types/snippet.types';

export default defineBackground(() => {
  console.log('[Pro Prompt Engine] Service Worker initialized (WXT)');

  // ════════════════════════════════════════
  // Message Router
  // ════════════════════════════════════════

  chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
    // Skip messages targeted at the offscreen document — its own listener
    // (entrypoints/offscreen/main.ts) handles those on a separate protocol
    // that this schema does not cover.
    if ((message as { target?: string }).target === 'offscreen') return;

    // [Phase 1 §7.1] Every message is parsed through ExtensionRequest before
    // its handler runs. A message that fails validation is answered with
    // INVALID_MESSAGE and never partially handled — never coerced.
    const parsed = ExtensionRequest.safeParse(message);
    if (!parsed.success) {
      console.error('[SW] Rejected invalid message:', message?.type, parsed.error.issues);
      sendResponse({ status: 'error', message: 'INVALID_MESSAGE' } satisfies ExtensionResponse);
      return;
    }

    if (message.type === 'MODEL_STATE_CHANGED') {
      sendResponse({ status: 'success' });
      return true;
    }

    handleMessage(message, sender)
      .then(sendResponse)
      .catch((error) => {
        console.error('[SW] Handler error:', error);
        sendResponse({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        } satisfies ExtensionResponse);
      });

    return true; // Keep channel open for async
  });

  async function handleMessage(
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
  ): Promise<ExtensionResponse> {
    switch (message.type) {
      case 'PING':
        return { status: 'success', data: { timestamp: Date.now() } };

      // [Phase 2] agent.content.ts's own tab id — see message.schema.ts's
      // GetTabIdRequest comment. -1 when the sender isn't a tab (shouldn't
      // happen for a per-origin content script, but never thrown on).
      case 'GET_TAB_ID':
        return { status: 'success', data: { tabId: sender.tab?.id ?? -1 } };

      case 'GET_ACTIVE_GRANTS': {
        const policies = await getActiveSitePolicies();
        return { status: 'success', data: policies.map((p) => p.origin) };
      }

      // ── Per-Origin Runtime Grants (PRE-4, PR-SEC-5…9) ──
      case 'GRANT_ORIGIN': {
        const { origin } = message.payload as { origin: string };
        const granted = await grantOrigin(origin);
        return granted
          ? { status: 'success', data: { origin } }
          : { status: 'error', message: 'GRANT_DECLINED_OR_FAILED' };
      }

      case 'REVOKE_ORIGIN': {
        const { origin } = message.payload as { origin: string };
        await revokeOrigin(origin);
        return { status: 'success', data: { origin } };
      }

      // ── LLM Inference ──
      case 'INFERENCE': {
        const request = message.payload as LLMRequest;
        const result = await routeInference(request);
        return { status: 'success', data: result };
      }

      // ── Scoring ──
      case 'SCORE': {
        const prompt = (message.payload as { prompt: string })?.prompt;
        if (!prompt) return { status: 'error', message: 'No prompt provided' };

        // Load active profile's scoring guidelines for persona-specific evaluation
        const activeProfile = await cacheManager.getActiveProfile();
        const scoreRes = await scorePrompt(prompt, activeProfile?.scoringGuidelinesMd);
        return { status: 'success', data: scoreRes };
      }

      // ── Refactoring ──
      case 'REFACTOR': {
        const payload = message.payload as any;
        const prompt = payload.prompt;
        if (!prompt) return { status: 'error', message: 'No prompt provided' };

        // Auto-load active profile data if not provided by caller
        let profileContext = payload.profileContext;
        let profileGuidelines = payload.profileGuidelines;
        let scoringGuidelinesMd = payload.scoringGuidelinesMd;
        let profileId = payload.profileId;

        if (!profileContext || !profileGuidelines) {
          const activeProfile = await cacheManager.getActiveProfile();
          if (activeProfile) {
            profileContext = profileContext || activeProfile.contextMd;
            profileGuidelines = profileGuidelines || activeProfile.promptGuidelinesMd;
            scoringGuidelinesMd = scoringGuidelinesMd || activeProfile.scoringGuidelinesMd;
            profileId = profileId || activeProfile.id;
          }
        }

        const result = await runRefactorLoop(prompt, profileContext, profileGuidelines, scoringGuidelinesMd);

        // Save to prompt history
        if (profileId) {
          await cacheManager.savePromptHistory({
            profileId,
            originalPrompt: prompt,
            refinedPrompt: result.refinedPrompt,
            score: result.score,
            iterations: result.iterations,
            provider: result.provider,
            tokensUsed: result.tokensUsed || 0,
          });
        }

        return { status: 'success', data: result };
      }

      // ── Generation ──
      case 'GENERATE': {
        const payload = message.payload as any;
        const description = payload.description;
        if (!description) return { status: 'error', message: 'No description provided' };

        // Load target profile data (explicit profileId or active profile)
        let genContext = payload.profileContext;
        let genGuidelines = payload.profileGuidelines;
        const targetProfileId = payload.profileId;

        if (!genContext || !genGuidelines) {
          const profile = targetProfileId
            ? await cacheManager.getProfile(targetProfileId)
            : await cacheManager.getActiveProfile();
          if (profile) {
            genContext = genContext || profile.contextMd;
            genGuidelines = genGuidelines || profile.promptGuidelinesMd;
          }
        }

        const verbosity = payload.detailLevel ?? 0.5;
        const result = await generatePrompt(description, verbosity, genContext, genGuidelines);

        return { status: 'success', data: { generatedPrompt: result.text, provider: result.provider, latencyMs: result.latencyMs } };
      }

      // ── Provider Management ──
      case 'GET_PROVIDER_STATUS': {
        const status = await getProviderStatus();
        const active = await getActiveProvider();
        return { status: 'success', data: { providers: status, activeProvider: active } };
      }

      case 'SET_ACTIVE_PROVIDER': {
        const { provider } = message.payload as { provider: string };
        await setActiveProvider(provider as any);
        return { status: 'success', data: { provider } };
      }

      // ── WebGPU Model Management ──
      case 'LOAD_MODEL': {
        const { model } = message.payload as { model: string };
        await ensureOffscreen();
        try {
          await loadWebGPUModel(model as any);
          return { status: 'success', data: { model, state: 'hot' } };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Send specific error type to UI
          if (msg.startsWith('MODEL_NOT_DOWNLOADED:')) {
            return { status: 'error', message: msg };
          }
          if (msg.startsWith('INSUFFICIENT_VRAM:')) {
            return { status: 'error', message: msg };
          }
          return { status: 'error', message: `WEBGPU_ERROR: ${msg}` };
        }
      }

      case 'UNLOAD_MODEL': {
        await unloadWebGPUModel();
        return { status: 'success' };
      }

      // ── WebGPU State Query (routed through SW, not direct offscreen bypass) ──
      case 'WEBGPU_GET_STATE': {
        await ensureOffscreen();
        try {
          const stateResp = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'GET_STATE',
          });
          return { status: 'success', data: stateResp?.data || { state: 'cold', model: null } };
        } catch {
          return { status: 'success', data: { state: 'cold', model: null } };
        }
      }

      // ── PII Check ──
      case 'CHECK_PII': {
        const { text } = message.payload as { text: string };
        return { status: 'success', data: { hasPII: hasPII(text), detected: scrubPII(text).detected } };
      }

      // ── Profile Operations ──
      case 'GET_PROFILE': {
        const { id } = (message.payload as { id?: number }) ?? {};
        const profile = id !== undefined ? await cacheManager.getProfile(id) : await cacheManager.getActiveProfile();
        return { status: 'success', data: profile };
      }

      case 'GET_ALL_PROFILES': {
        return { status: 'success', data: await cacheManager.getAllProfiles() };
      }

      case 'SET_PROFILE': {
        const profile = message.payload as Profile;
        const id = await cacheManager.saveProfile(profile);
        return { status: 'success', data: { id } };
      }

      case 'SET_ACTIVE_PROFILE': {
        const { id } = message.payload as { id: number };
        await cacheManager.setActiveProfile(id);
        return { status: 'success' };
      }

      case 'DELETE_PROFILE': {
        const { id } = message.payload as { id: number };
        const result = await cacheManager.deleteProfile(id);
        return result.ok
          ? { status: 'success' }
          : { status: 'error', message: result.error };
      }

      // ── Snippet Operations ──
      case 'GET_SNIPPETS': {
        const { query } = (message.payload as { query?: string }) ?? {};
        const snippets = query
          ? await cacheManager.searchSnippets(query)
          : await cacheManager.getAllSnippets();
        return { status: 'success', data: snippets };
      }

      case 'SAVE_SNIPPET': {
        const snippet = message.payload as Snippet;
        const id = await cacheManager.saveSnippet(snippet);
        return { status: 'success', data: { id } };
      }

      case 'DELETE_SNIPPET': {
        const { id } = message.payload as { id: number };
        await cacheManager.deleteSnippet(id);
        return { status: 'success' };
      }

      // ── Context Feeding (with token enforcement) ──
      case 'SAVE_CONTEXT':
      case 'CONTEXT_FEED': {
        const payload = message.payload as any;
        let contextText = payload.context || payload.text;
        const targetProfileId = payload.profileId || (await cacheManager.getActiveProfile())?.id;

        if (!targetProfileId || !contextText) return { status: 'error', message: 'Missing profileId or context' };

        // Process with Comprehension Agent if raw web text or selection
        if (['web_scan', 'selection', 'manual'].includes(payload.source)) {
           console.log('[SW] Processing raw context with Comprehension Agent...');
           contextText = await comprehendContext(contextText);
        }

        const result = await cacheManager.appendContext(targetProfileId, contextText);
        return { status: 'success', data: result };
      }

      // ── Settings ──
      case 'GET_SETTINGS': {
        const { key } = message.payload as { key: string };
        const value = await cacheManager.getSetting(key);
        return { status: 'success', data: { key, value } };
      }

      case 'SET_SETTINGS': {
        const { key, value } = message.payload as { key: string; value: unknown };
        await cacheManager.setSetting(key, value);
        return { status: 'success' };
      }

      // ── Prompt History ──
      case 'GET_PROMPT_HISTORY': {
        const { profileId, limit } = (message.payload as any) ?? {};
        const history = await cacheManager.getPromptHistory(profileId, limit);
        return { status: 'success', data: history };
      }

      case 'OPEN_DASHBOARD': {
        chrome.tabs.create({ url: chrome.runtime.getURL('/options.html') });
        return { status: 'success' };
      }

      default:
        return { status: 'error', message: `Unknown message type: ${message.type}` };
    }
  }

  // ════════════════════════════════════════
  // Offscreen Document Management
  // ════════════════════════════════════════

  // A promise, not a boolean: a boolean guard only stops a second caller
  // from starting a second createDocument() — it does not make that second
  // caller wait for the first one to actually finish, so it can return
  // early and let its caller message an offscreen document that isn't
  // ready yet. Every concurrent caller awaits the same in-flight creation.
  let creatingOffscreen: Promise<void> | null = null;

  async function ensureOffscreen(): Promise<void> {
    const url = chrome.runtime.getURL('offscreen.html');
    const contexts = await (chrome.runtime as any).getContexts?.({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [url],
    }).catch(() => []);

    if (contexts?.length > 0) return;
    if (creatingOffscreen) return creatingOffscreen;

    creatingOffscreen = (async () => {
      try {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['WORKERS' as any],
          justification: 'Running WebLLM inference via WebGPU',
        });
      } finally {
        creatingOffscreen = null;
      }
    })();
    return creatingOffscreen;
  }

  // ════════════════════════════════════════
  // Per-Origin Grant Drift Reconciliation (§4.3)
  // ════════════════════════════════════════

  // Fires when the user revokes from chrome://extensions directly. Does not
  // fire for revocations that happened while the browser was closed — that
  // case is covered by reconcileGrants() below.
  chrome.permissions.onRemoved.addListener(async ({ origins }) => {
    for (const pattern of origins ?? []) {
      const origin = pattern.replace(/\/\*$/, '');
      await revokeOrigin(origin);   // idempotent; unregister of a missing id is caught
    }
  });

  chrome.runtime.onStartup.addListener(reconcileGrants);
  chrome.runtime.onInstalled.addListener(reconcileGrants);

  // ════════════════════════════════════════
  // Extension Lifecycle
  // ════════════════════════════════════════

  chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('[SW] Installed/Updated:', details.reason);
    if (details.reason === 'install') {
      try {
        await seedDefaultProfiles();
        await seedDefaultSnippets();
        console.log('[SW] Default data seeded');
      } catch (e) { console.error('[SW] Seed failed:', e); }
    }
    cacheManager.warmUp().catch(console.error);
  });

  chrome.runtime.onStartup.addListener(async () => {
    console.log('[SW] Browser startup');
    await cacheManager.warmUp().catch(console.error);
    const result = await chrome.storage.local.get('activeProvider');
    if (result.activeProvider === 'webgpu') {
      console.log('[SW] WebGPU was active — ensuring offscreen');
      await ensureOffscreen().catch(console.error);
    }
  });
});
