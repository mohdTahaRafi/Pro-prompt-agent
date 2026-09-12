/**
 * Message schema — every payload the service worker's message router accepts.
 *
 * Every message chrome.runtime.onMessage receives (other than one explicitly
 * targeted at the offscreen document) is parsed through ExtensionRequest
 * before its handler runs. A message that fails validation is answered with
 * {status:'error', message:'INVALID_MESSAGE'} and never partially handled.
 * See Docs/planning/phase_1_foundation_preconditions.md §7.1.
 */
import { z } from 'zod';
import { ActionRequestSchema } from '@lib/schemas/action.schema';

// ── Shared building blocks ──

export const OriginSchema = z.string().refine(
  (s) => { try { const u = new URL(s); return u.origin === s && /^https?:$/.test(u.protocol); }
           catch { return false; } },
  'must be a bare http(s) origin with no path',
);

const AgentWeightsSchema = z.object({
  refactor: z.number(),
  scorer: z.number(),
  generator: z.number(),
  comprehension: z.number(),
});

// SET_PROFILE carries either a full new profile (no id — cacheManager.saveProfile
// routes it to db.profiles.add(), which needs every required field) or a
// partial update to an existing one (id present — routed to db.profiles.update(),
// which only touches the keys supplied, e.g. toolbar.content.tsx clearing
// just contextMd). The union mirrors that branch exactly.
const ProfileUpdateSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  isActive: z.union([z.literal(0), z.literal(1)]).optional(),
  isCustom: z.boolean().optional(),
  contextMd: z.string().optional(),
  promptGuidelinesMd: z.string().optional(),
  profileDescriptionMd: z.string().optional(),
  scoringGuidelinesMd: z.string().optional(),
  agentWeights: AgentWeightsSchema.optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});
const ProfileCreateSchema = z.object({
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  isActive: z.union([z.literal(0), z.literal(1)]),
  isCustom: z.boolean(),
  contextMd: z.string(),
  promptGuidelinesMd: z.string(),
  profileDescriptionMd: z.string(),
  scoringGuidelinesMd: z.string().optional(),
  agentWeights: AgentWeightsSchema,
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});
const ProfileSchema = z.union([ProfileUpdateSchema, ProfileCreateSchema]);

const SnippetSchema = z.object({
  id: z.number().optional(),
  prefix: z.string(),
  description: z.string(),
  body: z.string(),
  profileId: z.number().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
});

// ── Per-type requests ──

const req = <Type extends string, Payload extends z.ZodTypeAny>(type: Type, payload: Payload) =>
  z.object({ type: z.literal(type), payload, requestId: z.string().optional() });

const reqNoPayload = <Type extends string>(type: Type) =>
  z.object({ type: z.literal(type), payload: z.undefined().optional(), requestId: z.string().optional() });

export const PingRequest = reqNoPayload('PING');
export const ScoreRequest = req('SCORE', z.object({ prompt: z.string() }));
export const RefactorRequest = req('REFACTOR', z.object({
  prompt: z.string(),
  profileContext: z.string().optional(),
  profileGuidelines: z.string().optional(),
  scoringGuidelinesMd: z.string().optional(),
  profileId: z.number().optional(),
}));
export const GenerateRequest = req('GENERATE', z.object({
  description: z.string(),
  profileContext: z.string().optional(),
  profileGuidelines: z.string().optional(),
  profileId: z.number().optional(),
  detailLevel: z.number().optional(),
}));

export const GetProfileRequest = req('GET_PROFILE', z.object({ id: z.number().optional() }).optional());
export const SetProfileRequest = req('SET_PROFILE', ProfileSchema);
export const GetAllProfilesRequest = reqNoPayload('GET_ALL_PROFILES');
export const SetActiveProfileRequest = req('SET_ACTIVE_PROFILE', z.object({ id: z.number() }));
export const DeleteProfileRequest = req('DELETE_PROFILE', z.object({ id: z.number() }));

export const GetSnippetsRequest = req('GET_SNIPPETS', z.object({ query: z.string().optional() }).optional());
export const SaveSnippetRequest = req('SAVE_SNIPPET', SnippetSchema);
export const DeleteSnippetRequest = req('DELETE_SNIPPET', z.object({ id: z.number() }));

export const SaveContextRequest = req('SAVE_CONTEXT', z.object({
  context: z.string().optional(),
  text: z.string().optional(),
  profileId: z.number().optional(),
  source: z.string().optional(),
}));
export const ContextFeedRequest = req('CONTEXT_FEED', z.object({
  context: z.string().optional(),
  text: z.string().optional(),
  profileId: z.number().optional(),
  source: z.string().optional(),
}));

export const GetSettingsRequest = req('GET_SETTINGS', z.object({ key: z.string() }));
export const SetSettingsRequest = req('SET_SETTINGS', z.object({ key: z.string(), value: z.unknown() }));

export const LoadModelRequest = req('LOAD_MODEL', z.object({ model: z.string() }));
export const UnloadModelRequest = reqNoPayload('UNLOAD_MODEL');
export const WebgpuGetStateRequest = reqNoPayload('WEBGPU_GET_STATE');

export const CheckPiiRequest = req('CHECK_PII', z.object({ text: z.string() }));

// [Phase 4 §11] the Models tab — the posture the Models tab or the Copilot
// panel is currently showing capability for. Not the run's OWN posture
// (that is stored on the run row, lib/types/run.types.ts) — this is a
// capability PROBE, made before any run exists.
export const GetPostureCapabilityRequest = req('GET_POSTURE_CAPABILITY', z.object({
  posture: z.enum(['local-only', 'hybrid']),
}));

export const SetOllamaConfigRequest = req('SET_OLLAMA_CONFIG', z.object({
  baseUrl: z.string().optional(),
  model: z.string().optional(),
}));

export const SetRemoteConfigRequest = req('SET_REMOTE_CONFIG', z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  label: z.string().optional(),
}));

// [Phase 4 §9] content-script-only in practice (lib/ui/autocomplete-manager.ts),
// but validated at the same boundary as every other message.
export const InlineCompleteRequest = req('INLINE_COMPLETE', z.object({
  text: z.string().max(1_200),
  maxTokens: z.number().int().positive().max(64).optional(),
}));

export const ToggleAutocompleteRequest = req('TOGGLE_AUTOCOMPLETE', z.object({ enabled: z.boolean() }));

// [Phase 4 §8.3, §8.4, task 4.14] the Plan panel — display only, no Execute
// button this phase (§1).
export const AgentPlanRequest = req('AGENT_PLAN', z.object({
  tabId: z.number(),
  goal: z.string().min(1).max(2_000),
  posture: z.enum(['local-only', 'hybrid']),
}));

export const GetPromptHistoryRequest = req('GET_PROMPT_HISTORY', z.object({
  profileId: z.number().optional(),
  limit: z.number().optional(),
}).optional());

export const OpenDashboardRequest = reqNoPayload('OPEN_DASHBOARD');

export const ModelStateChangedRequest = req('MODEL_STATE_CHANGED', z.object({
  state: z.string(),
  progress: z.number().optional(),
  text: z.string().optional(),
}));

export const GrantOriginRequest = req('GRANT_ORIGIN', z.object({ origin: OriginSchema }));
export const RevokeOriginRequest = req('REVOKE_ORIGIN', z.object({ origin: OriginSchema }));

// [Phase 2] entrypoints/agent.content.ts asks the service worker for its own
// tab id once (a content script has no direct API for this) and caches the
// answer. The background handler reads it off chrome.runtime.onMessage's
// `sender.tab.id`.
export const GetTabIdRequest = reqNoPayload('GET_TAB_ID');

// [Phase 2] the Perception debug tab's granted-origin dropdown (§9) — lists
// every sitePolicy row Chrome still actually holds the permission for.
export const GetActiveGrantsRequest = reqNoPayload('GET_ACTIVE_GRANTS');

// [Phase 3 §11] the Copilot panel — one free-typed instruction against one
// selected, granted tab. The whole perceive → resolve → gate → act →
// settle → verify → journal pipeline runs in the service worker; the panel
// only ever sees the outcome.
export const AgentActRequest = req('AGENT_ACT', z.object({
  tabId: z.number(),
  instruction: z.string().min(1).max(500),
}));

// A pending Always-tier approval, answered from the panel's Approve/Reject
// buttons. The token is the original request's requestId — an approval
// granted for one action can never be replayed onto another (§9).
// [Phase 5 §11 task 5.13] repurposed: every real run's Always-tier approvals
// are now tracked by the offscreen Supervisor (lib/agent/supervisor.ts),
// not the Copilot panel's old pendingApprovals map — this message now
// carries a `runId` too, so the handler knows which Supervisor to forward
// it to.
export const AgentApprovalResponseRequest = req('AGENT_APPROVAL_RESPONSE', z.object({
  runId: z.number().int(),
  requestId: z.string().uuid(),
  approve: z.boolean(),
  // §9.1's "Reject with reason" control — journaled on approval.denied,
  // never sent to a model (PP-3: enforcement stays outside model reach).
  reason: z.string().max(300).optional(),
}));

export const AgentStopRequest = req('AGENT_STOP', z.object({ runId: z.number().int() }));

// [Phase 5 §3, §7, §8, §11 task 5.9] admits a new run: creates the `runs`
// row in 'planning' state, ensures the offscreen document exists, and
// starts its Supervisor — which immediately calls the planner (trigger 1,
// §4.3) and holds at `awaiting_plan_approval`.
export const AgentAdmitRunRequest = req('AGENT_ADMIT_RUN', z.object({
  tabId: z.number().int(),
  goal: z.string().min(1).max(2_000),
  mode: z.enum(['suggest', 'step', 'supervised']),
  posture: z.enum(['local-only', 'hybrid']),
}));

// The plan panel's Start button (approve, optionally with the user's edits
// already applied) or its Reject. `editedPlan` is the user's version,
// already validated client-side against PlanSchema by the constrained
// editor (§8) — re-validated server-side before it is trusted.
export const AgentPlanApprovalRequest = req('AGENT_PLAN_APPROVAL', z.object({
  runId: z.number().int(),
  approve: z.boolean(),
  editedPlan: z.unknown().optional(),
}));

export const AgentAskUserAnswerRequest = req('AGENT_ASK_USER_ANSWER', z.object({
  runId: z.number().int(),
  answer: z.string().max(500),
}));

export const AgentPauseRequest = req('AGENT_PAUSE', z.object({ runId: z.number().int() }));
// Resolves whichever wait the Supervisor is actually in — a plain Pause or
// a Take-over — the run-state table allows 'running' from both (§4.5), and
// the panel shows exactly one of the two buttons at a time, so there is
// never an ambiguity about which the user meant.
export const AgentResumeRequest = req('AGENT_RESUME', z.object({ runId: z.number().int() }));
export const AgentTakeOverRequest = req('AGENT_TAKE_OVER', z.object({ runId: z.number().int() }));

// The offscreen Supervisor/Tab Agent's own gate check (lib/agent/gate-client.ts)
// — the one message that crosses offscreen → service worker for every
// single action a run wants to take. Never sent by a UI surface.
export const AgentGateCheckRequest = req('AGENT_GATE_CHECK', ActionRequestSchema);

export const AgentGetRunEventsRequest = req('AGENT_GET_RUN_EVENTS', z.object({ runId: z.number().int() }));

export const AgentListRunsRequest = reqNoPayload('AGENT_LIST_RUNS');

// [Phase 3 §15, e2e-build behavior only — see wxt.config.ts's __PP_E2E__
// comment] tests/e2e/gate-wake.bench.ts's cold-SW-wake → gate-decision
// benchmark. Calls lib/policy/gate.ts directly against a real (or
// just-created) run, skipping the perceive()/resolveIntent() that AGENT_ACT
// always does first — those measure Phase 2's perception budget, not the
// gate's. The schema is declared unconditionally like every other message
// type; only entrypoints/background.ts's handler is compiled out in
// production builds.
export const AgentBenchGateRequest = req('AGENT_BENCH_GATE', z.object({ tabId: z.number().int() }));

// [Phase 5 §16, e2e build only] the actuation/verification e2e suite
// (actuation.spec.ts, false-confirm.spec.ts, never-tier.spec.ts,
// scope.spec.ts, stop.spec.ts, copilot.bench.ts — all Phase 3's) drove the
// gate -> act -> verify pipeline through AGENT_ACT, resolving a plain-
// language instruction via lib/agent/intent.ts. Phase 5 deletes intent.ts
// (§2: "Phase 3 labelled it throwaway") — replaced in real runs by the
// planner + step-resolver, which need a real inference call to produce a
// plan and are wrong tools for a test asserting "a click on a
// pointerdown-only control fires the handler" against real Chrome. This
// takes an already-resolved Action directly (the test finds the handle
// itself via a plain PERCEIVE_STRUCTURE call, unchanged since Phase 2) and
// runs the SAME gate -> dispatch -> verify path lib/agent/tab-agent.ts's
// dispatchPermitted() takes in production, minus planning and admission —
// the same "skip the part this test isn't about" precedent as
// AgentBenchGateRequest above.
export const AgentBenchActRequest = req('AGENT_BENCH_ACT', z.object({
  tabId: z.number().int(),
  action: ActionRequestSchema.shape.action,
}));

export const AgentBenchApproveRequest = req('AGENT_BENCH_APPROVE', z.object({
  requestId: z.string().uuid(),
  approve: z.boolean(),
}));

// [Phase 5 acceptance audit, 2026-09-13, e2e build only] see
// entrypoints/background.ts's AGENT_BENCH_SET_STATE case — lets
// tests/e2e/takeover.spec.ts and interrupted.spec.ts drive
// lib/policy/gate.ts's real RUN_STATE enforcement and
// lib/agent/reconcile.ts's real halt-on-unreachable logic directly against
// a bench-created run row, in real Chrome, without needing a live
// offscreen Supervisor to reach the same `run.state` field through
// AGENT_PAUSE/AGENT_TAKE_OVER's normal, production path.
export const AgentBenchSetStateRequest = req('AGENT_BENCH_SET_STATE', z.object({
  runId: z.number().int(),
  state: z.enum([
    'planning', 'awaiting_plan_approval', 'running', 'awaiting_approval',
    'awaiting_user', 'paused', 'taken_over', 'halted', 'stopped', 'failed', 'completed',
  ]),
}));

// [Phase 5 acceptance audit, 2026-09-13, e2e build only] see
// entrypoints/background.ts's AGENT_BENCH_RECONCILE comment.
export const AgentBenchReconcileRequest = reqNoPayload('AGENT_BENCH_RECONCILE');

export const ExtensionRequest = z.discriminatedUnion('type', [
  PingRequest, ScoreRequest, RefactorRequest, GenerateRequest,
  GetProfileRequest, SetProfileRequest, GetAllProfilesRequest, SetActiveProfileRequest, DeleteProfileRequest,
  GetSnippetsRequest, SaveSnippetRequest, DeleteSnippetRequest,
  SaveContextRequest, ContextFeedRequest, GetSettingsRequest, SetSettingsRequest,
  LoadModelRequest, UnloadModelRequest, WebgpuGetStateRequest,
  CheckPiiRequest, GetPostureCapabilityRequest, SetOllamaConfigRequest, SetRemoteConfigRequest,
  InlineCompleteRequest, ToggleAutocompleteRequest, AgentPlanRequest,
  GetPromptHistoryRequest, OpenDashboardRequest, ModelStateChangedRequest,
  GrantOriginRequest, RevokeOriginRequest, GetTabIdRequest, GetActiveGrantsRequest,
  AgentActRequest, AgentApprovalResponseRequest, AgentStopRequest,
  AgentGetRunEventsRequest, AgentListRunsRequest, AgentBenchGateRequest, AgentBenchActRequest, AgentBenchApproveRequest,
  AgentAdmitRunRequest, AgentPlanApprovalRequest, AgentAskUserAnswerRequest,
  AgentPauseRequest, AgentResumeRequest, AgentTakeOverRequest, AgentGateCheckRequest,
  AgentBenchSetStateRequest, AgentBenchReconcileRequest,
]);

export type ExtensionRequestType = z.infer<typeof ExtensionRequest>;
