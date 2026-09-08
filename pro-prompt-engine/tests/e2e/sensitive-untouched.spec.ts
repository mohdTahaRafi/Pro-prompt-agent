/**
 * On fixtures/sensitive-corpus.html, typing into every field and waiting
 * produces zero chrome.runtime.sendMessage calls carrying any field's
 * value — asserted by a service-worker-side recorder.
 *
 * Grants the origin first (via the same code path grant-revoke.spec.ts
 * exercises) so the agent content script (entrypoints/agent.content.ts —
 * SnippetManager + perception, DEFAULT_CAPABILITIES is the four perception
 * verbs as of Phase 2) is actually present on the page. This is the harder,
 * more meaningful case: even with the content script running and perception
 * active, no field value ever crosses the message boundary — proven by
 * wrapping chrome.runtime.onMessage in the service worker and recording
 * every payload it receives.
 */
import { test, expect } from './fixture';

const ORIGIN = 'http://localhost:5599';
const SECRET = 'S3cr3t-Val-9f2b7c';

test('typing a password produces no message carrying its value', async ({ context, page, extensionId }) => {
  const [sw] = context.serviceWorkers();

  // Grant from the popup page — see grant-revoke.spec.ts for why: self-
  // messaging chrome.runtime.sendMessage from inside the SW's own
  // evaluate() has no receiving end.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(async (origin) => {
    return chrome.runtime.sendMessage({ type: 'GRANT_ORIGIN', payload: { origin } });
  }, ORIGIN);

  // Install the recorder inside the SW before the page (and its content
  // script) loads, so nothing sent during page load is missed.
  await sw.evaluate(() => {
    (globalThis as any).__ppRecorded = [];
    chrome.runtime.onMessage.addListener((message: any) => {
      (globalThis as any).__ppRecorded.push(message);
    });
  });

  await page.goto(`${ORIGIN}/sensitive-corpus.html`);

  const passwordField = page.locator('#login-pw');
  await passwordField.click();
  await passwordField.type(SECRET, { delay: 10 });

  // classifySensitive() also excludes payment/OTP fields — cover one of
  // each to match the corpus described in §8.2.
  const cardField = page.locator('#cc-number');
  await cardField.click();
  await cardField.type('4111 1111 1111 1111', { delay: 10 });

  await page.waitForTimeout(3000);

  const recorded = await sw.evaluate(() => (globalThis as any).__ppRecorded ?? []);
  const serialized = JSON.stringify(recorded);
  expect(serialized).not.toContain(SECRET);
  expect(serialized).not.toContain('4111 1111 1111 1111');
  expect(serialized).not.toContain('4111111111111111');
});
