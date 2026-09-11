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
 */

// A promise, not a boolean: a boolean guard only stops a second caller from
// starting a second createDocument() — it does not make that second caller
// wait for the first one to actually finish, so it can return early and let
// its caller message an offscreen document that isn't ready yet. Every
// concurrent caller awaits the same in-flight creation.
let creatingOffscreen: Promise<void> | null = null;

export async function ensureOffscreen(): Promise<void> {
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
        justification: 'Hosts the local inference engines (WebLLM, the Prompt API base session) — GPU and model state must live in a persistent document, not the service worker.',
      });
    } finally {
      creatingOffscreen = null;
    }
  })();
  return creatingOffscreen;
}
