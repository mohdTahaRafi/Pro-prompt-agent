/**
 * The extension harness every e2e spec imports. Headless is not used — an
 * extension with chrome.permissions.request needs a real browser UI, and
 * --headless=new does not reliably drive permission prompts. CI runs it
 * under xvfb-run.
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
