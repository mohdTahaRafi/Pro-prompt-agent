/**
 * relay-backend — the ActuationBackend used wherever chrome.tabs itself is
 * unavailable: inside the offscreen document, the one context Chrome
 * restricts to chrome.runtime alone (developer.chrome.com/docs/extensions/
 * reference/api/offscreen — "the chrome.runtime API is the only extensions
 * API supported by offscreen documents"; see lib/platform/storage.ts's
 * header for how this was confirmed against real Chrome). Supervisor and
 * TabAgent live there (phase_5_agent_loop.md §3), but lib/actuation/
 * dom-backend.ts's own header has always said it "lives in the service
 * worker" — that was the intended design; TabAgent importing it directly
 * bypassed it by accident (nothing exercised a live offscreen Supervisor
 * against a real Chrome until the Phase 6 e2e investigation that added
 * this file). This restores that design instead of reinventing chrome.tabs:
 * every method here is a chrome.runtime.sendMessage to
 * entrypoints/background.ts's AGENT_ACTUATION_* handlers, which call the
 * real domBackend (chrome.tabs IS attached in the service worker) and
 * return its Result verbatim — already JSON-serialisable, so no reshaping
 * is needed on either side.
 *
 * lib/agent/tab-agent.ts picks this over domBackend purely by feature-
 * testing `chrome.tabs` — see its selectActuationBackend().
 */
import { Ok, Err, type Result } from '@lib/utils/result';
import type { ActuationBackend, ActEffect, DismissResult, PerceiveArgs } from '@lib/actuation/backend';
import type { Action } from '@lib/schemas/action.schema';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import type { BackendError, FailureCause } from '@lib/types/agent.types';

async function relay<T, E extends string>(type: string, payload: unknown, fallback: E): Promise<Result<T, E>> {
  const res = await chrome.runtime.sendMessage({ type, payload }).catch(() => undefined);
  if (res?.status === 'success') return res.data as Result<T, E>;
  return Err(fallback);
}

export const relayBackend: ActuationBackend = {
  kind: 'dom',

  // domBackend.attach()/detach() are unconditional no-ops (the content
  // script is already there) — mirrored directly, no round trip needed.
  async attach() {
    return Ok(undefined);
  },
  async detach() {},

  perceive(tabId, runId, req: PerceiveArgs) {
    return relay<PerceptionSnapshot, BackendError>(
      'AGENT_ACTUATION_PERCEIVE', { tabId, runId, req }, 'TARGET_MISSING',
    );
  },

  act(tabId, runId, action: Action, epoch) {
    return relay<ActEffect, FailureCause>(
      'AGENT_ACTUATION_ACT', { tabId, runId, action, epoch }, 'TARGET_MISSING',
    );
  },

  dismissOverlay(tabId, runId, handle, epoch) {
    return relay<DismissResult, FailureCause>(
      'AGENT_ACTUATION_DISMISS_OVERLAY', { tabId, runId, handle, epoch }, 'TARGET_MISSING',
    );
  },

  // [Phase 10] domBackend.capture() is itself NOT_IMPLEMENTED — nothing to relay yet.
  async capture() {
    return Err('NOT_IMPLEMENTED' satisfies BackendError);
  },
};
