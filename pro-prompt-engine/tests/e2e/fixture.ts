/**
 * The extension harness every e2e spec imports. Headless is not used — an
 * extension with chrome.permissions.request needs a real browser UI, and
 * --headless=new does not reliably drive permission prompts. CI runs it
 * under xvfb-run.
 *
 * [Phase 5 acceptance audit, 2026-09-13] `headless` was never actually set
 * here, so `launchPersistentContext()` defaulted to headless despite the
 * paragraph above (confirmed via the launched process's own args). Fixed
 * below to match this file's stated intent.
 *
 * [Phase 6 e2e investigation, 2026-09-13 — SUPERSEDES two earlier notes that
 * stood here] The offscreen document's script runs fine — it always did,
 * once lib/model/engines/webllm.ts's unguarded module-scope
 * `chrome.storage.local` read (which threw before this document's own
 * `chrome.runtime.onMessage.addListener` ever ran) was fixed. What is real,
 * and IS Chrome's documented, permanent design, not a bug in this sandbox:
 * "the chrome.runtime API is the only extensions API supported by offscreen
 * documents" (developer.chrome.com/docs/extensions/reference/api/offscreen)
 * — confirmed directly here too (`Object.keys(chrome)` inside a real
 * offscreen document never grows past `['loadTimes','csi','runtime']`,
 * polled for 15 straight seconds, while the byte-identical page loaded as
 * an ordinary tab has the full API surface instantly). This is universal to
 * every Chrome installation, not specific to this build — so the fix is a
 * relay, not an environment change: lib/platform/storage.ts and
 * lib/actuation/relay-backend.ts route every chrome.storage/chrome.tabs
 * call the offscreen-resident Supervisor/TabAgent make through the service
 * worker over chrome.runtime messaging (the one API that IS there), which
 * is what makes form-fill.spec.ts and Phase 6's J-2/J-3 milestones
 * (tasks 6.14/6.15) able to run a real Supervisor end to end in this
 * environment at all. See those two files' headers for the mechanism.
 */
import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// PP_E2E=1 build (npm run build:e2e) — see wxt.config.ts's header comment
// for why this is a separate output dir from the production `npm run build`.
const EXT = path.resolve(__dirname, '../../.output/e2e/chrome-mv3');

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: false,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    // MV3: the service worker may not have started yet on a cold profile.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
    await use(sw.url().split('/')[2]);
  },
});
export const expect = test.expect;
