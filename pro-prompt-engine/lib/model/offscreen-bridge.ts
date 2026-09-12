/**
 * Offscreen bridge — the one place that knows how to stand the offscreen
 * document up. Phase 1 introduced the document (webgpu-adapter.ts); Phase 4
 * splits it out of entrypoints/background.ts so the model engines
 * (lib/model/engines/{prompt-api,webllm}.ts) can call it too without either
 * duplicating the creation dance or importing from an entrypoint file.
 *
 * `entrypoints/offscreen/main.ts` hosts two real, stateful engines this
 * phase: the existing WebLLM host (unchanged — task 4.4) and the Prompt API
 * base-session host (new — task 4.3). Both need `chrome.runtime.getContexts`
 * probed and `chrome.offscreen.createDocument` awaited exactly once even
 * under concurrent callers, which is what `creatingOffscreen` guards below.
 *
 * [Phase 5 acceptance audit, 2026-09-13] — READINESS RACE, real bug found
 * against real Chrome (never caught by unit tests, which mock chrome.runtime
 * as an in-process, always-delivered call — there is no "listener not
 * registered yet" state to reproduce there). Neither `getContexts()`
 * reporting the document exists NOR `chrome.offscreen.createDocument()`
 * resolving means the document's own `chrome.runtime.onMessage` listener
 * (registered near the end of entrypoints/offscreen/main.ts, after its
 * module graph — dexie, zod, the WebLLM/Prompt API host code — finishes
 * loading) is registered yet. A message sent the instant either of those
 * signals fires can fail with "Could not establish connection. Receiving
 * end does not exist." — and `lib/agent/reconcile.ts`'s `askOffscreen()`
 * swallows exactly that failure (`.catch(() => undefined)`), so a caller
 * like `admitRun()` sees its `RUN_ADMITTED` message "succeed" (the outer
 * promise resolves) when it was actually silently dropped: no Supervisor is
 * ever constructed, and the run's `runs` row — already written as
 * `state: 'planning'` before the message was sent — never advances again.
 * This was the root cause of task 5.17's real-model test hanging forever in
 * `planning`, reproduced twice against a real, otherwise-healthy Ollama.
 * Fixed by having `ensureOffscreen()` not return until a real round-trip
 * message (`HEARTBEAT_PING`, already a handled case) actually succeeds —
 * retried with backoff, since "no response yet" during the loading window
 * is expected and not an error. `confirmedReady` caches a positive result
 * so the hot path (every gate-adjacent call, once the document is actually
 * up) pays no extra round trip; it is not persisted, so a service-worker
 * restart — a fresh evaluation of this whole module — correctly re-verifies
 * rather than trusting a previous instance's belief.
 */

// A promise, not a boolean: a boolean guard only stops a second caller from
// starting a second createDocument() — it does not make that second caller
// wait for the first one to actually finish, so it can return early and let
// its caller message an offscreen document that isn't ready yet. Every
// concurrent caller awaits the same in-flight creation.
let creatingOffscreen: Promise<void> | null = null;

// Set once a real message round-trip has succeeded against the current
// offscreen document. Reset whenever getContexts() reports it gone (closed,
// or this is a fresh SW evaluation) so the next ensureOffscreen() call
// re-verifies instead of trusting a stale belief.
let confirmedReady = false;

/** Test-only seam (mirrors lib/model/posture.ts's __resetPostureCache) —
 *  production code never calls this; a fresh service-worker evaluation
 *  resets the underlying module state for free. */
export function __resetOffscreenBridgeState(): void {
  creatingOffscreen = null;
  confirmedReady = false;
}

/** Polls with backoff until the offscreen document's message listener is
 *  actually live, or gives up. "Receiving end does not exist" during this
 *  window is the document's module graph still loading — expected, not a
 *  failure — so it is retried rather than propagated. */
async function pingUntilReady(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 20;
  for (;;) {
    try {
      const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'HEARTBEAT_PING' });
      if (res) { confirmedReady = true; return; }
    } catch {
      // Not ready yet — fall through to retry.
    }
    if (Date.now() >= deadline) {
      throw new Error('Offscreen document did not become ready to receive messages in time');
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 300);
  }
}

export async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL('offscreen.html');
  const contexts = await (chrome.runtime as any).getContexts?.({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  }).catch(() => []);

  if (contexts?.length > 0) {
    if (confirmedReady) return;
    await pingUntilReady();
    return;
  }

  confirmedReady = false;
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS' as any],
        justification: 'Hosts the local inference engines (WebLLM, the Prompt API base session) — GPU and model state must live in a persistent document, not the service worker.',
      });
      await pingUntilReady();
    } finally {
      creatingOffscreen = null;
    }
  })();
  return creatingOffscreen;
}
