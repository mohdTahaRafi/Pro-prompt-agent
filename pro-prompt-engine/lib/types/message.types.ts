export interface ExtensionMessage<T = unknown> {
  type: MessageType;
  payload?: T;
  requestId?: string;
}

// [Phase 1] Trimmed to the message types an actual handler exists for.
// The ghost-text completion feature's toggle pair, the bidirectional SW/CS
// ping-pong pair the three-layer keep-alive used (§5.6), SCAN_WEBPAGE,
// INJECT_TOOLBAR, TOGGLE_TEXT_SELECT, SNIPPET_QUERY, PROVIDER_CHANGED,
// MODEL_DOWNLOAD_REQUIRED and one dead heartbeat-ping variant were removed:
// each was either part of that keep-alive, part of the ghost-text feature
// removed in §5.1, or dead — no source file ever sent it.
// [Phase 4] 'INFERENCE' (the old flat cascade's generic passthrough — no
// caller ever sent it), 'GET_PROVIDER_STATUS' and 'SET_ACTIVE_PROVIDER'
// (the single-"active provider" concept the no-cascade router replaces,
// §2) are removed the same way. Added: 'GET_POSTURE_CAPABILITY' (the
// Models tab, §11), 'SET_OLLAMA_CONFIG'/'SET_REMOTE_CONFIG' (§5.3, §5.4),
// 'INLINE_COMPLETE' (§9), 'TOGGLE_AUTOCOMPLETE' (restored alongside it),
// and 'AGENT_PLAN' (the Plan panel, §8.3, task 4.14).
// Every member below is validated by lib/schemas/message.schema.ts.
export type MessageType =
  | 'PING' | 'SCORE' | 'REFACTOR' | 'GENERATE'
  | 'GET_PROFILE' | 'SET_PROFILE' | 'GET_ALL_PROFILES' | 'SET_ACTIVE_PROFILE' | 'DELETE_PROFILE'
  | 'GET_SNIPPETS' | 'SAVE_SNIPPET' | 'DELETE_SNIPPET'
  | 'SAVE_CONTEXT' | 'CONTEXT_FEED' | 'GET_SETTINGS' | 'SET_SETTINGS'
  | 'LOAD_MODEL' | 'UNLOAD_MODEL' | 'GET_STATE'
  | 'CHECK_PII'
  | 'GET_PROMPT_HISTORY' | 'MODEL_STATE_CHANGED'
  | 'WEBGPU_GET_STATE' | 'OPEN_DASHBOARD'
  | 'GRANT_ORIGIN' | 'REVOKE_ORIGIN'
  // [Phase 2] agent.content.ts has no direct API for its own tab id; it asks
  // the service worker once and caches the answer (entrypoints/agent.content.ts).
  | 'GET_TAB_ID'
  // [Phase 2] the Perception debug tab's granted-origin dropdown (§9).
  | 'GET_ACTIVE_GRANTS'
  // [Phase 3] the Copilot panel — one instruction, gated, acted, verified.
  | 'AGENT_ACT' | 'AGENT_APPROVAL_RESPONSE' | 'AGENT_STOP'
  | 'AGENT_GET_RUN_EVENTS' | 'AGENT_LIST_RUNS'
  // [Phase 3 §15, e2e build only] tests/e2e/gate-wake.bench.ts — see
  // lib/schemas/message.schema.ts's AgentBenchGateRequest comment.
  | 'AGENT_BENCH_GATE'
  // [Phase 4] §11's Models tab, §5.3/§5.4's config, §9's inline completion,
  // §8.3/§8.4's Plan panel.
  | 'GET_POSTURE_CAPABILITY' | 'SET_OLLAMA_CONFIG' | 'SET_REMOTE_CONFIG'
  | 'INLINE_COMPLETE' | 'TOGGLE_AUTOCOMPLETE' | 'AGENT_PLAN';

export interface ExtensionResponse<T = unknown> {
  status: 'success' | 'error' | 'not_implemented' | 'unknown_type';
  data?: T;
  message?: string;
  timestamp?: number;
}

export interface ScoreResult { score: number; critique: string; }
export interface RefactorResult {
  originalPrompt: string;
  refinedPrompt: string;
  score: number;
  iterations: number;
  critique: string;
}
