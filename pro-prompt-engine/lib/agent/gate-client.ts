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
  const res = await chrome.runtime.sendMessage({ type: 'AGENT_GATE_CHECK', payload: req }).catch(() => undefined);
  if (res?.status === 'success') return res.data as ActionDecision;

  // [Phase 6 §16, e2e build only] AGENT_BENCH_TAB_STEP (see
  // entrypoints/background.ts's comment) runs a real TabAgent directly in
  // the service worker, not the offscreen document production runs it in —
  // there is no test-only way to drive TabAgent.executeStep()'s real
  // recovery loop otherwise without a live planner. A service worker
  // cannot chrome.runtime.sendMessage a message to ITSELF and receive it
  // through its own onMessage listener (a genuine, unrelated Chrome
  // messaging limitation — self-sent runtime messages are simply never
  // delivered back to the sender), so the cross-process hop above always
  // fails there, independent of anything this boundary is meant to enforce.
  // Falling back to calling gate() in-process ONLY in that build (and only
  // once the real cross-process attempt has already failed) keeps
  // production's actual boundary — enforcement never in the same process
  // as the thing enforced, architecture.md §3.7.1 — fully intact; this
  // branch does not exist in a production bundle, same as every other
  // __PP_E2E__ branch (tests/unit/bundle-size.spec.ts, manifest.spec.ts).
  if (__PP_E2E__) {
    const { gate } = await import('@lib/policy/gate');
    return gate(req);
  }
  // The service worker is unreachable (terminated mid-round-trip, or the
  // message channel closed). Treated as a hard refusal, never as
  // permitted-by-default — a silent-fail-open here would be the exact
  // failure this whole boundary exists to prevent.
  return { permitted: false, code: 'UNKNOWN_RUN' };
}
