/**
 * The extension harness every e2e spec imports. Headless is not used — an
 * extension with chrome.permissions.request needs a real browser UI, and
 * --headless=new does not reliably drive permission prompts. CI runs it
 * under xvfb-run.
 *
 * [Phase 5 acceptance audit, 2026-09-13] `headless` was never actually set
 * here, so `launchPersistentContext()` defaulted to headless despite the
 * paragraph above (confirmed via the launched process's own args). Fixed
 * below to match this file's stated intent — real, worth keeping, but it
 * turned out NOT to be the fix for the bigger problem this audit was
 * chasing: `chrome.offscreen.createDocument()`'s document never executes
 * ANY of its script in this environment, headless or not. Verified
 * thoroughly, not assumed: the exact same offscreen.html (module bundle,
 * and separately a trivial inline classic `<script>`) runs perfectly the
 * instant it's loaded as an ordinary navigated page (logs its full startup
 * sequence, writes to chrome.storage.local, registers a working
 * chrome.runtime.onMessage listener) — but created via chrome.offscreen
 * instead, under `headless: false`, with every `reasons` value tried
 * (WORKERS, DOM_PARSER), it never writes so much as its first line to
 * storage, and every message to `target: 'offscreen'` fails "Receiving end
 * does not exist" indefinitely. No crash report is ever generated. This is
 * a genuine limitation of `chrome.offscreen` in this Chromium build/sandbox
 * (Google Chrome for Testing 151.0.7922.34 here), not an application bug —
 * lib/model/offscreen-bridge.ts's ensureOffscreen() readiness-race fix is
 * still real and still correct (it turns the old silent-forever hang into
 * a clear, timely error), but it cannot succeed if the document underneath
 * it never runs at all. This blocks any e2e spec that needs a live,
 * message-reachable Supervisor (task 5.17's form-fill.spec.ts, and a
 * genuine Take-over/Interrupted-run round trip) until this environment's
 * Chromium build is swapped for one where chrome.offscreen actually works —
 * confirmed NOT specific to this repo's code.
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
