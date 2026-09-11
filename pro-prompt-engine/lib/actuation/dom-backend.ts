/**
 * dom-backend — the default ActuationBackend. Lives in the service worker,
 * beneath the gate, and proxies to entrypoints/agent.content.ts over
 * chrome.tabs.sendMessage. It holds no policy — a permitted action arrives
 * and is performed. Docs/planning/phase_3_gate_actuation_verification.md §6.2.
 *
 * `navigate`/`history_back`/`history_forward` are the one exception: they
 * are dispatched from HERE, not proxied to the content script, because a
 * content-script-initiated navigation destroys the script that issued it
 * before it can report (§6.3 "Navigating"). The gate has already confirmed
 * the destination origin is in scope before this runs.
 */
import { Ok, Err, type Result } from '@lib/utils/result';
import { PerceiveStructureResponseSchema } from '@lib/schemas/snapshot.schema';
import type { Action } from '@lib/schemas/action.schema';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import type { BackendError, FailureCause } from '@lib/types/agent.types';
import type { ActuationBackend, ActEffect, PerceiveArgs } from '@lib/actuation/backend';

async function isStopped(runId: number): Promise<boolean> {
  const stopKey = `stop:${runId}`;
  const { [stopKey]: stopped } = await chrome.storage.session.get(stopKey);
  return Boolean(stopped);
}

const NAVIGATION_LOAD_TIMEOUT_MS = 8_000;   // matches settle's own VISIBLE_CAP_MS ceiling

/**
 * chrome.tabs.update/goBack/goForward all resolve as soon as the
 * navigation is REQUESTED, not once the destination has finished loading —
 * a perceive() sent immediately after would race a content script that
 * hasn't re-attached to the new document yet and get no response at all
 * (TARGET_MISSING). Waits for chrome.tabs.onUpdated to report this tab's
 * status as 'complete', bounded so a page that never finishes loading
 * cannot hang the action forever.
 */
function waitForTabComplete(tabId: number, timeoutMs = NAVIGATION_LOAD_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    // Also covers the case where the tab was ALREADY 'complete' by the time
    // this function is called (a same-document history change, e.g. a hash
    // navigation) and onUpdated never fires again.
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(); }).catch(() => finish());
  });
}

async function actNavigation(
  tabId: number, runId: number, action: Extract<Action, { verb: 'navigate' | 'history_back' | 'history_forward' }>,
): Promise<Result<ActEffect, FailureCause>> {
  // The physical floor is one in-flight DOM operation (§10) — checked one
  // last time, immediately before dispatch, mirroring the content-script
  // actuator's own last-instant check for handle-bearing verbs.
  if (await isStopped(runId)) return Err('STOPPED');

  const t0 = performance.now();
  const before = (await chrome.tabs.get(tabId).catch(() => null))?.url;
  try {
    if (action.verb === 'navigate') {
      await chrome.tabs.update(tabId, { url: action.url });
    } else if (action.verb === 'history_back') {
      await chrome.tabs.goBack(tabId);
    } else {
      await chrome.tabs.goForward(tabId);
    }
    await waitForTabComplete(tabId);
  } catch {
    return Err('TARGET_MISSING');
  }
  return Ok({ dispatched: true, preState: before, elapsedMs: Math.round(performance.now() - t0) });
}

export const domBackend: ActuationBackend = {
  kind: 'dom',

  async attach() {
    return Ok(undefined);   // no-op; the content script is already there
  },

  async detach() {},

  async perceive(tabId, runId, req: PerceiveArgs) {
    const res = await chrome.tabs.sendMessage(tabId, {
      type: 'PERCEIVE_STRUCTURE',
      runId: String(runId),
      region: req.region,
      tokenBudget: req.tokenBudget ?? 6_000,
    }).catch(() => null);
    if (!res) return Err('TARGET_MISSING' satisfies BackendError);

    const parsed = PerceiveStructureResponseSchema.safeParse(res);
    if (!parsed.success) return Err('INVALID_SNAPSHOT' satisfies BackendError);
    if (parsed.data.status === 'error') {
      return Err(
        (parsed.data.message === 'PERCEPTION_TOO_LARGE' ? 'PERCEPTION_TOO_LARGE' : 'INVALID_SNAPSHOT') as BackendError,
      );
    }
    return Ok(parsed.data.data as PerceptionSnapshot);
  },

  async act(tabId, runId, action, epoch) {
    if (action.verb === 'navigate' || action.verb === 'history_back' || action.verb === 'history_forward') {
      return actNavigation(tabId, runId, action);
    }
    const res = await chrome.tabs.sendMessage(tabId, {
      type: 'ACTUATE', runId, action, epoch,
    }).catch(() => null);
    if (!res) return Err('TARGET_MISSING');   // no content script = no page we can reach
    return res.ok ? Ok(res.value as ActEffect) : Err(res.error as FailureCause);
  },

  async capture() {
    return Err('NOT_IMPLEMENTED' satisfies BackendError);   // [Phase 10]
  },
};
