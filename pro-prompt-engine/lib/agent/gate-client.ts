/**
 * Gate client — crosses the offscreen-document → service-worker boundary
 * for a single ActionRequest. Docs/planning/phase_5_agent_loop.md §3.
 *
 * The Supervisor and Tab Agent run in the offscreen document; the gate
 * (lib/policy/gate.ts) runs in the service worker, on purpose — enforcement
 * is never in the same process as the thing being enforced (architecture.md
 * §3.7.1). This is the one call that crosses that boundary; every other
 * offscreen module (domBackend, ownership, journal, db) talks to its own
 * storage directly, because IndexedDB and chrome.storage are shared across
 * every extension context, not scoped to the service worker.
 */
import type { ActionRequest } from '@lib/schemas/action.schema';
import type { ActionDecision } from '@lib/types/agent.types';

export async function requestAction(req: ActionRequest): Promise<ActionDecision> {
  const res = await chrome.runtime.sendMessage({ type: 'AGENT_GATE_CHECK', payload: req });
  if (!res || res.status !== 'success') {
    // The service worker is unreachable (terminated mid-round-trip, or the
    // message channel closed). Treated as a hard refusal, never as
    // permitted-by-default — a silent-fail-open here would be the exact
    // failure this whole boundary exists to prevent.
    return { permitted: false, code: 'UNKNOWN_RUN' };
  }
  return res.data as ActionDecision;
}
