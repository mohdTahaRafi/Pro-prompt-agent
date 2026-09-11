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
import { db, seedDefaultProfiles, seedDefaultSnippets } from '@lib/db/dexie-db';
import { scrubPII, hasPII } from '@lib/utils/pii-scrubber';
import { scorePrompt } from '@lib/agents/scorer';
import { generatePrompt } from '@lib/agents/generator';
import { runRefactorLoop } from '@lib/agents/loop-controller';
import { comprehendContext } from '@lib/agents/comprehension';
import { grantOrigin, revokeOrigin, reconcileGrants, toOrigin } from '@lib/policy/scope';
import { getActiveSitePolicies } from '@lib/db/policy-store';
import { ExtensionRequest } from '@lib/schemas/message.schema';
// [Phase 3] the Policy Gate, actuation, verification and journal — see
// Docs/planning/phase_3_gate_actuation_verification.md §11.
import { gate } from '@lib/policy/gate';
import * as ownership from '@lib/policy/ownership';
import * as journal from '@lib/agent/journal';
import { transition } from '@lib/agent/run-state';
import { domBackend } from '@lib/actuation/dom-backend';
import { verify } from '@lib/page/verifier';
import { resolveIntent, UNMATCHED_COPY } from '@lib/agent/intent';
import { ActionRequestSchema, handleOf } from '@lib/schemas/action.schema';
import { formatRefusal } from '@lib/types/agent.types';
import type { LLMRequest } from '@lib/types/llm.types';
import type { ExtensionMessage, ExtensionResponse } from '@lib/types/message.types';
import type { Profile } from '@lib/types/profile.types';
import type { Snippet } from '@lib/types/snippet.types';
import type { Action, ActionRequest } from '@lib/schemas/action.schema';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import type { RunRecord } from '@lib/types/run.types';
import type { Tier } from '@lib/types/agent.types';

export default defineBackground(() => {
  console.log('[Pro Prompt Engine] Service Worker initialized (WXT)');

  // chrome.storage.session defaults to trusted (extension-page/SW) contexts
  // only in MV3. lib/page/actuator.ts's stop check runs in the content
  // script and needs to read it — this is the one call that opens that
  // door. Harmless to call every SW start; setAccessLevel is idempotent.
  chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch((e: unknown) => console.error('[SW] storage.session.setAccessLevel failed', e));

  // ════════════════════════════════════════
  // Phase 3 — Agent orchestration (§11)
  //
  // The Copilot panel sends one free-typed instruction; everything from
  // "resolve it against the current snapshot" through "journal the
  // verified outcome" happens here, in the service worker, on the other
  // side of the gate from the requester (architecture.md §3.7.1).
  // ════════════════════════════════════════

  const TERMINAL_RUN_STATES = new Set<RunRecord['state']>(['halted', 'stopped', 'failed', 'completed']);

  // KNOWN LIMITATION: a pending Always-tier approval lives only in this
  // in-memory map. A service-worker restart while one is outstanding loses
  // it — the run stays 'awaiting_approval' with no path back. Recovery is
  // explicitly out of scope this phase (§1: "Recovery from failure is
  // reported, never attempted — that is Phase 6"); the same run can always
  // be abandoned and a fresh instruction started against the same tab.
  const pendingApprovals = new Map<string, {
    runId: number; tabId: number; req: ActionRequest; tier: Tier; preSnapshot: PerceptionSnapshot;
  }>();

  /** One run per (currently-selected) tab, reused while it is still alive.
   *  Roster length is always 1 this phase (§1) — Phase 7 is what makes this
   *  a real multi-tab lookup. */
  async function ensureRun(tabId: number): Promise<(RunRecord & { id: number }) | null> {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url) return null;
    const origin = toOrigin(tab.url);
    if (!origin) return null;

    const existing = await db.runs
      .filter((r) => r.roster.length === 1 && r.roster[0] === tabId && !TERMINAL_RUN_STATES.has(r.state))
      .first();
    if (existing?.id !== undefined) return existing as RunRecord & { id: number };

    const now = Date.now();
    const record: RunRecord = {
      goal: '', state: 'running', mode: 'supervised', posture: 'local-only', backend: 'dom',
      origin, scope: [origin], roster: [tabId],
      budgets: { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 },
      startedAt: now,
    };
    const id = await db.runs.add(record);
    await journal.append(id, 'run.created', tabId, { origin, tabId });
    return { ...record, id };
  }

  // read_page/read_structure/read_element/wait_for_settle are Phase 2's
  // perception verbs, not actuation — they are answered by
  // entrypoints/agent.content.ts's EXISTING PerceptionRequest listener
  // (unchanged since Phase 2), never by lib/page/actuator.ts's ACTUATE
  // handler, which has no case for them at all. They are not mutating, so
  // there is nothing for lib/page/verifier.ts to verify either — the read
  // itself, succeeding or not, is the whole outcome.
  const PERCEPTION_VERBS = new Set(['read_page', 'read_structure', 'read_element', 'wait_for_settle']);

  async function performRead(run: RunRecord & { id: number }, tabId: number, req: ActionRequest) {
    const t0 = performance.now();
    const a = req.action as Extract<Action, { verb: 'read_page' | 'read_structure' | 'read_element' | 'wait_for_settle' }>;
    const message = a.verb === 'read_page' ? { type: 'PERCEIVE_PAGE', runId: String(run.id) }
      : a.verb === 'read_structure' ? { type: 'PERCEIVE_STRUCTURE', runId: String(run.id), region: (a as any).region, tokenBudget: 6_000 }
      : a.verb === 'read_element' ? { type: 'PERCEIVE_ELEMENT', runId: String(run.id), handle: (a as any).handle }
      : { type: 'WAIT_FOR_SETTLE', runId: String(run.id), maxMs: (a as any).maxMs };

    const res = await chrome.tabs.sendMessage(tabId, message).catch(() => null);
    const elapsedMs = Math.round(performance.now() - t0);
    if (!res || res.status === 'error') {
      const code = res?.message ?? 'TARGET_MISSING';
      await journal.append(run.id, 'action.refused', tabId, { code, verb: a.verb });
      return { phase: 'failed' as const, failureCause: code };
    }
    await journal.append(run.id, 'action.dispatched', tabId, { verb: a.verb, elapsedMs });
    await journal.append(run.id, 'action.observed', tabId, { verb: a.verb, verified: 'confirmed', check: 'state' });
    return { phase: 'done' as const, verb: a.verb, tier: 'low' as const, verified: 'confirmed' as const, check: 'state' as const, data: res.data, elapsedMs };
  }

  /** act → settle+re-read (perceive already waits for settle, §7.6) →
   *  verify → journal. Shared by the direct-permit path and the
   *  after-approval path so both produce the same five-line story
   *  (§13's milestone: requested, permitted, acted, settled, confirmed). */
  async function performAction(
    run: RunRecord & { id: number }, tabId: number, req: ActionRequest, pre: PerceptionSnapshot, tier: Tier,
  ) {
    const effect = await domBackend.act(tabId, run.id, req.action, req.epoch);
    if (!effect.ok) {
      await journal.append(run.id, 'action.refused', tabId, { code: effect.error, verb: req.action.verb });
      return { phase: 'failed' as const, failureCause: effect.error };
    }
    await journal.append(run.id, 'action.dispatched', tabId, { verb: req.action.verb, elapsedMs: effect.value.elapsedMs });

    const post = await domBackend.perceive(tabId, run.id, {});
    if (!post.ok) {
      return { phase: 'failed' as const, failureCause: 'TARGET_MISSING' as const };
    }
    await ownership.record(run.id, tabId, post.value);

    const verdict = await verify(req.action, effect.value, post.value, pre);
    const handle = handleOf(req.action);
    await journal.append(run.id, 'action.observed', tabId, {
      verb: req.action.verb, handle, tier, verified: verdict.verified,
      check: verdict.check, evidence: verdict.evidence, failureCause: verdict.failureCause,
    });

    return {
      phase: 'done' as const, verb: req.action.verb, tier, verified: verdict.verified,
      check: verdict.check, evidence: verdict.evidence, failureCause: verdict.failureCause,
      elapsedMs: effect.value.elapsedMs,
    };
  }

  async function runAgentAct(tabId: number, instruction: string) {
    const run = await ensureRun(tabId);
    if (!run) return { phase: 'refused' as const, code: 'TAB_GONE' as const, message: formatRefusal('TAB_GONE') };

    const pre = await domBackend.perceive(tabId, run.id, {});
    if (!pre.ok) {
      return {
        phase: 'refused' as const, code: 'OUT_OF_SCOPE' as const,
        message: 'Could not read the page — is Pro Prompt granted on it, and is it open in this tab?',
      };
    }
    await ownership.record(run.id, tabId, pre.value);

    const intent = resolveIntent(instruction, pre.value);
    if (intent.kind === 'unmatched') return { phase: 'unmatched' as const, message: UNMATCHED_COPY };
    if (intent.kind === 'ambiguous') {
      return {
        phase: 'ambiguous' as const,
        candidates: intent.candidates.map((c) => ({ handle: c.handle, name: c.name, role: c.role, regionId: c.regionId })),
      };
    }

    const rawReq = {
      requestId: crypto.randomUUID(), runId: run.id, tabId, epoch: pre.value.epoch,
      action: intent.action, reason: instruction,
    };
    const validated = ActionRequestSchema.safeParse(rawReq);
    if (!validated.success) {
      return { phase: 'refused' as const, code: 'MALFORMED_ACTION' as const, message: formatRefusal('MALFORMED_ACTION') };
    }
    const req = validated.data;

    await journal.append(run.id, 'action.requested', tabId, { verb: req.action.verb, reason: instruction });

    const decision = await gate(req);
    if (decision.needsApproval) {
      pendingApprovals.set(req.requestId, { runId: run.id, tabId, req, tier: decision.tier, preSnapshot: pre.value });
      await db.runs.update(run.id, { state: 'awaiting_approval' });
      return { phase: 'needs_approval' as const, requestId: req.requestId, prompt: decision.prompt };
    }
    if (!decision.permitted) {
      return { phase: 'refused' as const, code: decision.code, message: formatRefusal(decision.code, { origin: run.origin }) };
    }

    if (PERCEPTION_VERBS.has(req.action.verb)) {
      return performRead(run, tabId, req);
    }
    return performAction(run, tabId, req, pre.value, decision.tier);
  }

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

      // ── Phase 3: the Copilot panel ──
      case 'AGENT_ACT': {
        const { tabId, instruction } = message.payload as { tabId: number; instruction: string };
        const data = await runAgentAct(tabId, instruction);
        return { status: 'success', data };
      }

      case 'AGENT_APPROVAL_RESPONSE': {
        const { requestId, approve } = message.payload as { requestId: string; approve: boolean };
        const pending = pendingApprovals.get(requestId);
        if (!pending) return { status: 'error', message: 'UNKNOWN_APPROVAL' };
        pendingApprovals.delete(requestId);
        const { runId, tabId, req, tier, preSnapshot } = pending;

        const run = await db.runs.get(runId);
        if (!run?.id) return { status: 'error', message: 'UNKNOWN_RUN' };

        if (!approve) {
          await journal.append(runId, 'approval.denied', tabId, { requestId });
          const t = transition(run.state, 'running');
          if (t.ok) await db.runs.update(runId, { state: t.value });
          return { status: 'success', data: { phase: 'denied' } };
        }

        await journal.append(runId, 'approval.granted', tabId, { requestId });
        const t = transition(run.state, 'running');
        if (t.ok) await db.runs.update(runId, { state: t.value });
        // The ORIGINAL pre-approval snapshot and epoch are reused, never
        // re-fetched here — a fresh perceive() would bump the content
        // script's epoch counter and make req.epoch stale before it is
        // ever dispatched (lib/page/registry.ts's beginEpoch() resets on
        // every structure read).
        const data = await performAction({ ...run, id: runId }, tabId, req, preSnapshot, tier);
        return { status: 'success', data };
      }

      case 'AGENT_STOP': {
        const { runId } = message.payload as { runId: number };
        // The stop flag is written FIRST and unconditionally — it is the
        // actual enforcement mechanism (§10), read by the gate and by the
        // content-script actuator. The state transition below is
        // best-effort bookkeeping on top of it.
        await chrome.storage.session.set({ [`stop:${runId}`]: true });
        const run = await db.runs.get(runId);
        if (run) {
          const t = transition(run.state, 'stopped');
          if (t.ok) await db.runs.update(runId, { state: t.value, endedAt: Date.now() });
        }
        return { status: 'success' };
      }

      case 'AGENT_GET_RUN_EVENTS': {
        const { runId } = message.payload as { runId: number };
        return { status: 'success', data: await journal.query(runId) };
      }

      case 'AGENT_LIST_RUNS': {
        const runs = await db.runs.orderBy('startedAt').reverse().limit(20).toArray();
        return { status: 'success', data: runs };
      }

      // [Phase 3 §15, e2e build only] compiled out of every other build —
      // see wxt.config.ts's __PP_E2E__ comment and AgentBenchGateRequest's.
      case 'AGENT_BENCH_GATE': {
        if (!__PP_E2E__) return { status: 'error', message: 'NOT_AVAILABLE' };
        const { tabId } = message.payload as { tabId: number };
        const run = await ensureRun(tabId);
        if (!run) return { status: 'error', message: 'TAB_GONE' };
        const req = {
          requestId: crypto.randomUUID(), runId: run.id, tabId,
          epoch: 1, action: { verb: 'read_page' as const }, reason: 'bench',
        };
        const validated = ActionRequestSchema.safeParse(req);
        if (!validated.success) return { status: 'error', message: 'MALFORMED_ACTION' };
        const decision = await gate(validated.data);
        return { status: 'success', data: { decision } };
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
