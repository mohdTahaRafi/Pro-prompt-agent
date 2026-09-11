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

const LLMRequestSchema = z.object({
  systemPrompt: z.string(),
  userPrompt: z.string(),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  stopSequences: z.array(z.string()).optional(),
  provider: z.enum(['webgpu', 'ollama', 'groq']).optional(),
});

// ── Per-type requests ──

const req = <Type extends string, Payload extends z.ZodTypeAny>(type: Type, payload: Payload) =>
  z.object({ type: z.literal(type), payload, requestId: z.string().optional() });

const reqNoPayload = <Type extends string>(type: Type) =>
  z.object({ type: z.literal(type), payload: z.undefined().optional(), requestId: z.string().optional() });

export const PingRequest = reqNoPayload('PING');
export const InferenceRequest = req('INFERENCE', LLMRequestSchema);
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

export const GetProviderStatusRequest = reqNoPayload('GET_PROVIDER_STATUS');
export const SetActiveProviderRequest = req('SET_ACTIVE_PROVIDER', z.object({ provider: z.string() }));

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
export const AgentApprovalResponseRequest = req('AGENT_APPROVAL_RESPONSE', z.object({
  requestId: z.string().uuid(),
  approve: z.boolean(),
}));

export const AgentStopRequest = req('AGENT_STOP', z.object({ runId: z.number().int() }));

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

export const ExtensionRequest = z.discriminatedUnion('type', [
  PingRequest, InferenceRequest, ScoreRequest, RefactorRequest, GenerateRequest,
  GetProfileRequest, SetProfileRequest, GetAllProfilesRequest, SetActiveProfileRequest, DeleteProfileRequest,
  GetSnippetsRequest, SaveSnippetRequest, DeleteSnippetRequest,
  SaveContextRequest, ContextFeedRequest, GetSettingsRequest, SetSettingsRequest,
  LoadModelRequest, UnloadModelRequest, WebgpuGetStateRequest,
  CheckPiiRequest, GetProviderStatusRequest, SetActiveProviderRequest,
  GetPromptHistoryRequest, OpenDashboardRequest, ModelStateChangedRequest,
  GrantOriginRequest, RevokeOriginRequest, GetTabIdRequest, GetActiveGrantsRequest,
  AgentActRequest, AgentApprovalResponseRequest, AgentStopRequest,
  AgentGetRunEventsRequest, AgentListRunsRequest, AgentBenchGateRequest,
]);

export type ExtensionRequestType = z.infer<typeof ExtensionRequest>;
