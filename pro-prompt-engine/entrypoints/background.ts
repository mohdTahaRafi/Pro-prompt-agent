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

import { loadWebllmModel, unloadWebllmModel } from '@lib/model/engines/webllm';
import { route } from '@lib/model/router';
import { probePosture } from '@lib/model/posture';
import { probeOllamaPlanner, setOllamaConfig } from '@lib/model/engines/ollama';
import { setRemoteConfig } from '@lib/model/engines/remote';
import { ensureOffscreen } from '@lib/model/offscreen-bridge';
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
// [Phase 3] the Policy Gate — see Docs/planning/phase_3_gate_actuation_verification.md §11.
// [Phase 5] the ONLY thing the service worker still does for a real run is
// answer the offscreen Supervisor/Tab Agent's gate checks (§3) and admit /
// reconcile runs — every perceive/act/verify call now happens IN the
// offscreen document, next to the Supervisor that drives it (§3's header).
import { gate } from '@lib/policy/gate';
import * as journal from '@lib/agent/journal';
import { transition } from '@lib/agent/run-state';
import { askOffscreen, reconcileRuns, relayRunControl } from '@lib/agent/reconcile';
import { ActionRequestSchema, handleOf } from '@lib/schemas/action.schema';
import * as ownership from '@lib/policy/ownership';
import { domBackend } from '@lib/actuation/dom-backend';
import { verify } from '@lib/page/verifier';
import type { ExtensionMessage, ExtensionResponse } from '@lib/types/message.types';
import type { Profile } from '@lib/types/profile.types';
import type { Snippet } from '@lib/types/snippet.types';
import type { RunRecord } from '@lib/types/run.types';
import type { Plan } from '@lib/schemas/plan.schema';
import type { Action } from '@lib/schemas/action.schema';
import type { Posture } from '@lib/model/posture';

export default defineBackground(() => {
  console.log('[Pro Prompt Engine] Service Worker initialized (WXT)');

  // chrome.storage.session defaults to trusted (extension-page/SW) contexts
  // only in MV3. lib/page/actuator.ts's stop check runs in the content
  // script and needs to read it — this is the one call that opens that
  // door. Harmless to call every SW start; setAccessLevel is idempotent.
  chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch((e: unknown) => console.error('[SW] storage.session.setAccessLevel failed', e));

  // ════════════════════════════════════════
  // Phase 5 — Run admission, the offscreen relay, and reconciliation (§3,
  // §11 tasks 5.4, 5.15).
  //
  // The service worker's whole job for a real run is now: (1) admit it —
  // create the `runs` row, ensure the offscreen document, and hand the
  // Supervisor its RunAdmitted payload; (2) answer its gate checks
  // (AGENT_GATE_CHECK — the one call lib/agent/gate-client.ts makes); (3)
  // relay every cockpit command (plan approval, action approval, ask_user's
  // answer, pause/resume/take-over) to the Supervisor that owns that run;
  // (4) notice, on every cold wake, any run whose Supervisor did not
  // survive. Planning, execution, perception and verification all happen
  // IN the offscreen document (lib/agent/supervisor.ts, lib/agent/tab-agent.ts).
  // ════════════════════════════════════════

  async function admitRun(tabId: number, goal: string, mode: RunRecord['mode'], postureChoice: Posture) {
    // The posture disclosure (§3.2) is shown BEFORE the run starts — probed
    // first, against no run row at all, so a refusal never even creates one.
    const capability = await probePosture(postureChoice);
    if (!capability.planner.available) {
      return {
        phase: 'no_planner' as const,
        reason: capability.planner.reason ?? "The planner isn't available.",
        ollamaPullCommand: 'ollama pull qwen2.5:14b',
      };
    }

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const origin = tab?.url ? toOrigin(tab.url) : null;
    if (!origin) return { phase: 'refused' as const, code: 'TAB_GONE', message: 'That tab is no longer part of this task.' };

    const now = Date.now();
    const record: RunRecord = {
      goal, state: 'planning', mode, posture: capability.posture, backend: 'dom',
      origin, scope: [origin], roster: [tabId],
      budgets: { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 },
      startedAt: now,
    };
    const runId = await db.runs.add(record);
    await journal.append(runId, 'run.created', tabId, { origin, tabId, goal, mode });

    // The run row above is already 'planning' — if this doesn't truly reach
    // a live Supervisor, the row would otherwise sit there forever with no
    // journal entry explaining why (the 2026-09-13 acceptance audit's root
    // cause: an offscreen-document readiness race silently dropped this
    // exact message — see lib/model/offscreen-bridge.ts's header). Fixing
    // that race is the real fix; this check is the failure-mode declaration
    // CLAUDE.md §5.4 requires for whatever this doesn't catch.
    const ack = await askOffscreen<{ started: boolean }>({
      type: 'RUN_ADMITTED',
      payload: { runId, tabId, goal, mode, posture: capability.posture, origin } satisfies Record<string, unknown>,
    });
    if (!ack?.started) {
      await journal.append(runId, 'run.interrupted', tabId, { atState: 'planning', reason: 'OFFSCREEN_UNREACHABLE' });
      await db.runs.update(runId, { state: 'failed', outcome: 'failed', endedAt: Date.now() });
      return {
        phase: 'refused' as const, code: 'OFFSCREEN_UNREACHABLE',
        message: "This run couldn't start — the background service didn't respond. Try again.",
      };
    }

    return { phase: 'admitted' as const, runId };
  }

  // [Phase 5 §16, e2e build only] AGENT_BENCH_ACT's own run + pending-
  // approval bookkeeping — see AgentBenchActRequest's comment. Never
  // referenced outside the __PP_E2E__-gated case below; a production build
  // allocates these two collections but never populates them.
  const TERMINAL_RUN_STATES = new Set<RunRecord['state']>(['halted', 'stopped', 'failed', 'completed']);
  const benchPendingApprovals = new Map<string, { runId: number; tabId: number; req: any; tier: any; pre: any }>();

  async function ensureBenchRun(tabId: number): Promise<(RunRecord & { id: number }) | null> {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url) return null;
    const origin = toOrigin(tab.url);
    if (!origin) return null;
    const existing = await db.runs
      .filter((r) => r.roster.length === 1 && r.roster[0] === tabId && !TERMINAL_RUN_STATES.has(r.state))
      .first();
    if (existing?.id !== undefined) return existing as RunRecord & { id: number };
    const record: RunRecord = {
      goal: '', state: 'running', mode: 'supervised', posture: 'local-only', backend: 'dom',
      origin, scope: [origin], roster: [tabId],
      budgets: { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 },
      startedAt: Date.now(),
    };
    const id = await db.runs.add(record);
    // A bench-act run has no plan at all (there is no planner call in this
    // path by design — see AgentBenchActRequest's comment) — without this,
    // lib/policy/goal-anchor.ts's check 5.5 would refuse every single
    // action here OFF_GOAL, since goal anchoring is real production
    // behaviour this phase adds, not something a test-only path is exempt
    // from. Same documented escape hatch tests/unit/gate.spec.ts's
    // makeRun() uses, for the same reason: this run's actions are not
    // being checked against a plan.
    await journal.append(id, 'plan.replanned', tabId, { trigger: 'run_start', fromStepIndex: 0 });
    return { ...record, id };
  }

  async function benchDispatch(run: RunRecord & { id: number }, tabId: number, action: Action) {
    const pre = await domBackend.perceive(tabId, run.id, {});
    if (!pre.ok) return { phase: 'refused' as const, code: 'OUT_OF_SCOPE', message: 'Could not read the page.' };
    await ownership.record(run.id, tabId, pre.value);

    const req = ActionRequestSchema.parse({
      requestId: crypto.randomUUID(), runId: run.id, tabId, epoch: pre.value.epoch, action, reason: 'e2e bench',
    });
    await journal.append(run.id, 'action.requested', tabId, { verb: req.action.verb });

    const decision = await gate(req);
    if (decision.needsApproval) {
      benchPendingApprovals.set(req.requestId, { runId: run.id, tabId, req, tier: decision.tier, pre: pre.value });
      return { phase: 'needs_approval' as const, requestId: req.requestId, prompt: decision.prompt };
    }
    if (!decision.permitted) {
      return { phase: 'refused' as const, code: decision.code, message: decision.code };
    }
    return benchPerform(run, tabId, req, pre.value, decision.tier);
  }

  async function benchPerform(run: RunRecord & { id: number }, tabId: number, req: any, pre: any, tier: any) {
    if (['read_page', 'read_structure', 'read_element', 'wait_for_settle'].includes(req.action.verb)) {
      // Non-mutating — nothing to verify; report success directly. Still
      // journals action.dispatched, matching lib/agent/tab-agent.ts's
      // performRead() (reads are dispatched, non-mutating actions).
      // `data: pre` (the SAME snapshot ownership.record() just recorded)
      // lets tests/e2e/agent-helpers.ts's resolveHandle() find a target's
      // handle through this exact epoch-consistent path, rather than a
      // second, independent perceive whose registry epoch could allocate
      // different handle strings for the same elements.
      await journal.append(run.id, 'action.dispatched', tabId, { verb: req.action.verb, elapsedMs: 0 });
      await journal.append(run.id, 'action.observed', tabId, { verb: req.action.verb, verified: 'confirmed', check: 'state' });
      return { phase: 'done' as const, verb: req.action.verb, tier, verified: 'confirmed' as const, check: 'state' as const, data: pre };
    }
    const effect = await domBackend.act(tabId, run.id, req.action, req.epoch);
    if (!effect.ok) return { phase: 'failed' as const, failureCause: effect.error };
    await journal.append(run.id, 'action.dispatched', tabId, { verb: req.action.verb, elapsedMs: effect.value.elapsedMs });

    const post = await domBackend.perceive(tabId, run.id, {});
    if (!post.ok) return { phase: 'failed' as const, failureCause: 'TARGET_MISSING' as const };
    await ownership.record(run.id, tabId, post.value);

    const verdict = await verify(req.action, effect.value, post.value, pre);
    await journal.append(run.id, 'action.observed', tabId, {
      verb: req.action.verb, handle: handleOf(req.action), tier, verified: verdict.verified,
      check: verdict.check, evidence: verdict.evidence, failureCause: verdict.failureCause,
    });
    return { phase: 'done' as const, verb: req.action.verb, tier, verified: verdict.verified, check: verdict.check, evidence: verdict.evidence, failureCause: verdict.failureCause };
  }

  // §3.1 — interrupted runs halt (lib/agent/reconcile.ts). Run once per
  // service-worker EVALUATION — an MV3 service worker
  // terminated on idle re-executes this whole module top-level on its next
  // wake (the same reasoning as storage.session.setAccessLevel above), so
  // this is "on every SW wake" in practice, not merely on browser startup
  // or install. Fire-and-forget: nothing else in this file depends on it
  // having finished.
  reconcileRuns().catch((e) => console.error('[SW] reconcileRuns failed', e));

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

      // ── Scoring (§6.3 — Result-returning, never a fabricated score) ──
      case 'SCORE': {
        const prompt = (message.payload as { prompt: string })?.prompt;
        if (!prompt) return { status: 'error', message: 'No prompt provided' };

        // Load active profile's scoring guidelines for persona-specific evaluation
        const activeProfile = await cacheManager.getActiveProfile();
        const scoreRes = await scorePrompt(prompt, activeProfile?.scoringGuidelinesMd);
        if (!scoreRes.ok) {
          return { status: 'error', message: `Could not score this — ${scoreRes.error}. Try again, or switch models.` };
        }
        return { status: 'success', data: scoreRes.value };
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

      // ── §11 — the Models tab: four tiers, what each is running on ──
      case 'GET_POSTURE_CAPABILITY': {
        const { posture } = message.payload as { posture: Posture };
        const capability = await probePosture(posture);
        return { status: 'success', data: capability };
      }

      case 'SET_OLLAMA_CONFIG': {
        const { baseUrl, model } = message.payload as { baseUrl?: string; model?: string };
        await setOllamaConfig({ baseUrl, model });
        const probe = await probeOllamaPlanner();
        return { status: 'success', data: probe };
      }

      case 'SET_REMOTE_CONFIG': {
        const { apiKey, baseUrl, model, label } = message.payload as {
          apiKey?: string; baseUrl?: string; model?: string; label?: string;
        };
        // MUST run from this user-gesture-originated message handler —
        // chrome.permissions.request throws outside one (§5.4, mirroring
        // lib/policy/scope.ts's grantOrigin).
        const granted = await setRemoteConfig({ apiKey, baseUrl, model, label });
        return granted
          ? { status: 'success' }
          : { status: 'error', message: 'The host permission for that URL was declined.' };
      }

      // ── §9 — inline ghost-text completion, local only ──
      case 'INLINE_COMPLETE': {
        const { text, maxTokens } = message.payload as { text: string; maxTokens?: number };
        const result = await route({
          tier: 'inline', posture: 'local-only',   // CHAINS.inline has no remote entry in EITHER posture
          system: 'Continue the user\'s text naturally, in their own voice. Respond with ONLY the continuation — no repetition of their text, no quotes, no commentary. Keep it short: a phrase or a sentence at most.',
          user: text, maxTokens: maxTokens ?? 24, temperature: 0.4,
        });
        // Suppressed silently on failure — inline completion never blocks
        // or delays typing (§3's inline row).
        return { status: 'success', data: { suggestion: result.ok ? result.value.content.trim() : null } };
      }

      case 'TOGGLE_AUTOCOMPLETE': {
        const { enabled } = message.payload as { enabled: boolean };
        await chrome.storage.local.set({ autocompleteEnabled: enabled });
        return { status: 'success', data: { enabled } };
      }

      // ── §8.3, §8.4, task 4.14 — the Plan panel. Produces a plan; does
      //    NOT execute one (§1). ──
      // ── WebLLM Model Management (the judge tier's fallback engine) ──
      case 'LOAD_MODEL': {
        const { model } = message.payload as { model: string };
        await ensureOffscreen();
        try {
          await loadWebllmModel(model as any);
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
          return { status: 'error', message: `WEBLLM_ERROR: ${msg}` };
        }
      }

      case 'UNLOAD_MODEL': {
        await unloadWebllmModel();
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

      // ── Phase 5: run admission, the offscreen relay (§3, §11 task 5.9…5.14) ──
      case 'AGENT_ADMIT_RUN': {
        const { tabId, goal, mode, posture } = message.payload as {
          tabId: number; goal: string; mode: RunRecord['mode']; posture: Posture;
        };
        // Opened FIRST, before any await, to stay as close as possible to
        // whatever user gesture (a GoalBox click, a Cockpit button) this
        // message is a direct result of — chrome.sidePanel.open() must run
        // inside a user gesture on some Chrome versions. Best-effort: the
        // run proceeds even if this fails, and the side panel can always be
        // reopened later to reattach to its live state (§3.1, §9.4).
        chrome.sidePanel.open({ tabId }).catch(() => {});
        const data = await admitRun(tabId, goal, mode, posture);
        return { status: 'success', data };
      }

      // The offscreen Supervisor/Tab Agent's own gate check
      // (lib/agent/gate-client.ts) — the one message that crosses
      // offscreen -> service worker for every action a run wants to take.
      case 'AGENT_GATE_CHECK': {
        const validated = ActionRequestSchema.safeParse(message.payload);
        if (!validated.success) return { status: 'error', message: 'MALFORMED_ACTION' };
        const decision = await gate(validated.data);
        return { status: 'success', data: decision };
      }

      case 'AGENT_PLAN_APPROVAL': {
        const { runId, approve, editedPlan } = message.payload as { runId: number; approve: boolean; editedPlan?: Plan };
        return relayRunControl('PLAN_APPROVAL_RESPONSE', { runId, approve, editedPlan });
      }

      // [Phase 5 §11 task 5.13] repurposed from Phase 3's single-shot
      // Copilot flow (deleted, §2) — every real run's approvals are owned
      // by its offscreen Supervisor now, addressed by runId.
      case 'AGENT_APPROVAL_RESPONSE': {
        const { runId, requestId, approve, reason } = message.payload as { runId: number; requestId: string; approve: boolean; reason?: string };
        return relayRunControl('ACTION_APPROVAL_RESPONSE', { runId, requestId, approve, reason });
      }

      case 'AGENT_ASK_USER_ANSWER': {
        const { runId, answer } = message.payload as { runId: number; answer: string };
        return relayRunControl('ASK_USER_RESPONSE', { runId, answer });
      }

      case 'AGENT_PAUSE': {
        const { runId } = message.payload as { runId: number };
        return relayRunControl('PAUSE_RUN', { runId });
      }

      case 'AGENT_RESUME': {
        const { runId } = message.payload as { runId: number };
        return relayRunControl('RESUME_RUN', { runId });
      }

      case 'AGENT_TAKE_OVER': {
        const { runId } = message.payload as { runId: number };
        return relayRunControl('TAKE_OVER_RUN', { runId });
      }

      case 'AGENT_STOP': {
        const { runId } = message.payload as { runId: number };
        // The stop flag is written FIRST and unconditionally — it is the
        // actual enforcement mechanism (§3.7.19), read by the gate, by the
        // content-script actuator, and (via chrome.storage.onChanged) by
        // the offscreen Supervisor directly, so a Stop pressed while it is
        // blocked in a pause/approval/ask_user wait unblocks it instantly.
        // The state transition below is best-effort bookkeeping on top of it.
        await chrome.storage.session.set({ [`stop:${runId}`]: true });
        const run = await db.runs.get(runId);
        if (run) {
          const t = transition(run.state, 'stopped');
          if (t.ok) await db.runs.update(runId, { state: t.value, outcome: 'stopped', endedAt: Date.now() });
        }
        await journal.append(runId, 'run.stopped', null, {});
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
      // [Phase 5] ensureRun() (Phase 3's reuse-while-alive run lookup) is
      // gone with the Copilot panel it served — this creates its own
      // minimal 'running' row directly, which is all the gate itself needs.
      case 'AGENT_BENCH_GATE': {
        if (!__PP_E2E__) return { status: 'error', message: 'NOT_AVAILABLE' };
        const { tabId } = message.payload as { tabId: number };
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const origin = tab?.url ? toOrigin(tab.url) : null;
        if (!origin) return { status: 'error', message: 'TAB_GONE' };
        const runId = await db.runs.add({
          goal: '', state: 'running', mode: 'supervised', posture: 'local-only', backend: 'dom',
          origin, scope: [origin], roster: [tabId],
          budgets: { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 },
          startedAt: Date.now(),
        });
        const req = {
          requestId: crypto.randomUUID(), runId, tabId,
          epoch: 1, action: { verb: 'read_page' as const }, reason: 'bench',
        };
        const validated = ActionRequestSchema.safeParse(req);
        if (!validated.success) return { status: 'error', message: 'MALFORMED_ACTION' };
        const decision = await gate(validated.data);
        return { status: 'success', data: { decision } };
      }

      // [Phase 5 §16, e2e build only] see AgentBenchActRequest's comment.
      case 'AGENT_BENCH_ACT': {
        if (!__PP_E2E__) return { status: 'error', message: 'NOT_AVAILABLE' };
        const { tabId, action } = message.payload as { tabId: number; action: Action };
        const run = await ensureBenchRun(tabId);
        if (!run) return { status: 'error', message: 'TAB_GONE' };
        const data = await benchDispatch(run, tabId, action);
        return { status: 'success', data: { ...data, runId: run.id } };
      }

      // [Phase 5 §16, e2e build only] answers an AGENT_BENCH_ACT approval
      // hold — a separate pending-approval map from the real Supervisor's
      // (there is no Supervisor in a bench-act run at all).
      case 'AGENT_BENCH_APPROVE': {
        if (!__PP_E2E__) return { status: 'error', message: 'NOT_AVAILABLE' };
        const { requestId, approve } = message.payload as { requestId: string; approve: boolean };
        const pending = benchPendingApprovals.get(requestId);
        if (!pending) return { status: 'error', message: 'UNKNOWN_APPROVAL' };
        benchPendingApprovals.delete(requestId);
        if (!approve) {
          await journal.append(pending.runId, 'approval.denied', pending.tabId, { requestId });
          return { status: 'success', data: { phase: 'denied' } };
        }
        await journal.append(pending.runId, 'approval.granted', pending.tabId, { requestId });
        const run = await db.runs.get(pending.runId);
        const data = await benchPerform({ ...run!, id: pending.runId }, pending.tabId, pending.req, pending.pre, pending.tier);
        return { status: 'success', data };
      }

      // [Phase 5 acceptance audit, 2026-09-13, e2e build only] Take-over and
      // Pause are enforced entirely by lib/policy/gate.ts's check 7 reading
      // `run.state` (canAct() in lib/agent/run-state.ts) — the offscreen
      // Supervisor only ever gets there via AGENT_PAUSE/AGENT_TAKE_OVER
      // (real production entry points, still real and still tested at the
      // unit level: tests/unit/pause-takeover-askuser.spec.ts). This lets
      // tests/e2e/takeover.spec.ts drive the SAME gate check directly
      // against a real bench run, real Chrome, and a real dispatched
      // action — proving the actual security property (an action is
      // refused RUN_STATE once taken over, and permitted again once
      // resumed) without needing a live Supervisor to reach it.
      case 'AGENT_BENCH_SET_STATE': {
        if (!__PP_E2E__) return { status: 'error', message: 'NOT_AVAILABLE' };
        const { runId, state } = message.payload as { runId: number; state: RunRecord['state'] };
        await db.runs.update(runId, { state });
        return { status: 'success' };
      }

      // [Phase 5 acceptance audit, 2026-09-13, e2e build only] reconcileRuns()
      // (lib/agent/reconcile.ts, §11 task 5.15) normally only runs once per
      // service-worker evaluation — real, but not something an e2e spec can
      // trigger a second time without literally crashing and respawning the
      // SW process. tests/e2e/interrupted.spec.ts found that a CDP-forced
      // `Target.closeTarget` on the SW does not make Chrome respawn it (this
      // extension's SW registration does not survive an explicit debugger-
      // driven kill the way a natural idle timeout does) — a genuine
      // limitation of driving this scenario from outside the browser, not a
      // reason to leave task 5.15 e2e-unverified. This calls the exact same
      // production function on demand instead, against real chrome.storage/
      // IndexedDB/messaging, so the spec still exercises the real halt logic
      // for real — see that file's header for the full scope note.
      case 'AGENT_BENCH_RECONCILE': {
        if (!__PP_E2E__) return { status: 'error', message: 'NOT_AVAILABLE' };
        await reconcileRuns();
        return { status: 'success' };
      }

      default:
        return { status: 'error', message: `Unknown message type: ${message.type}` };
    }
  }

  // ════════════════════════════════════════
  // Offscreen Document Management
  // ════════════════════════════════════════
  // [Phase 4] moved to lib/model/offscreen-bridge.ts, imported above, so the
  // model engines (lib/model/engines/{prompt-api,webllm}.ts) can call it
  // too without either duplicating the creation dance or importing from an
  // entrypoint file.

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
    // [Phase 4] no more single "active provider" to eagerly warm for — the
    // judge/inline tiers stand the offscreen document up lazily, on first
    // real call (lib/model/offscreen-bridge.ts), which is simpler and
    // never wastes the warm-up on a posture that ends up Local-only with
    // no local engine actually used this session.
  });
});
