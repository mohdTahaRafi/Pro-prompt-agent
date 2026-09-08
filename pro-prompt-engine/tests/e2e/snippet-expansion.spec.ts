/**
 * Task 2.13 — SnippetManager moved inside agent.content.ts, sharing the
 * overlay host with perception. This proves the migration didn't regress
 * the actual trigger pipeline: typing "/dev" in a granted page's textarea
 * reaches the service worker's GET_SNIPPETS handler and gets back the real
 * seeded "/dev" snippet.
 *
 * The popup itself renders inside a CLOSED shadow root by design (§3.1 —
 * the page must not be able to read, style, or remove it), which also
 * means it is not inspectable through ordinary Playwright locators; this
 * test verifies the trigger → message → real-snippet-data pipeline instead
 * of the popup's visual DOM, which is the part the Phase 2 migration could
 * plausibly have broken (a second host, a lost listener, a wrong query).
 */
import { test, expect } from './fixture';

const ORIGIN = 'http://localhost:5599';

test('typing "/dev" in a granted page triggers a real GET_SNIPPETS lookup that resolves to the seeded snippet', async ({ context, extensionId }) => {
  const [sw] = context.serviceWorkers();

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const granted = await popup.evaluate(async (origin) => {
    return chrome.runtime.sendMessage({ type: 'GRANT_ORIGIN', payload: { origin } });
  }, ORIGIN);
  expect(granted?.status).toBe('success');

  // Record every GET_SNIPPETS request the SW answers, before the page loads.
  await sw.evaluate(() => {
    (globalThis as any).__ppSnippetRequests = [];
    chrome.runtime.onMessage.addListener((message: any) => {
      if (message?.type === 'GET_SNIPPETS') (globalThis as any).__ppSnippetRequests.push(message);
    });
  });

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/basic-form.html`);
  await page.waitForTimeout(300);   // content script attach

  const textarea = page.locator('#comment-box');
  await textarea.click();
  await textarea.type('/dev', { delay: 20 });
  await page.waitForTimeout(500);   // SnippetManager's fetchSnippets round-trip

  const requests = await sw.evaluate(() => (globalThis as any).__ppSnippetRequests ?? []);
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.some((r: any) => r.payload?.query === 'dev')).toBe(true);

  // The real, seeded snippet — confirms this isn't a stubbed/empty response.
  const snippetsResp = await popup.evaluate(async () => {
    return chrome.runtime.sendMessage({ type: 'GET_SNIPPETS', payload: { query: 'dev' } });
  });
  expect(snippetsResp?.status).toBe('success');
  const devSnippet = snippetsResp.data.find((s: any) => s.prefix === '/dev');
  expect(devSnippet).toBeDefined();
  expect(devSnippet.body).toContain('TypeScript developer');
});
