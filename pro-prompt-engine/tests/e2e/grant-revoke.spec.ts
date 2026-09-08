/**
 * Granting http://localhost:5599 registers a script
 * (chrome.scripting.getRegisteredContentScripts() contains
 * "pp-agent-http://localhost:5599") and the fixture page's
 * window.__proPromptPing() answers. Revoking unregisters it and the ping
 * times out.
 *
 * chrome.permissions.request() opens a native Chrome permission bubble that
 * is browser chrome, not page content — Playwright cannot click it
 * (verified empirically: the call hangs indefinitely regardless of whether
 * it is invoked from a real click-driven user gesture). This build
 * (npm run build:e2e, see wxt.config.ts) makes http://localhost:5599 a
 * genuinely-held mandatory host permission so GRANT_ORIGIN's
 * chrome.permissions.request() call resolves immediately (Chrome resolves a
 * request for a permission already held without any prompt) — every other
 * step of grantOrigin() runs for real against real Chrome APIs, including
 * the part that actually matters here: real script registration and real
 * injection.
 *
 * The "revoke" half calls chrome.scripting.unregisterContentScripts
 * directly — the exact API revokeOrigin() uses — rather than sending
 * REVOKE_ORIGIN, because chrome.permissions.remove() rejects with "You
 * cannot remove required permissions" for a mandatory permission (an
 * artifact of this test's own scaffolding, not a real code path: production
 * origins are never mandatory). That call, and revokeOrigin()'s full
 * sequence, is covered against a mocked chrome.permissions by
 * tests/unit/scope.spec.ts.
 */
import { test, expect } from './fixture';

const ORIGIN = 'http://localhost:5599';

test('grant registers the agent script and the fixture page answers a ping; unregistering it makes the ping time out', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/basic-form.html`);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  const granted = await popup.evaluate(async (origin) => {
    return chrome.runtime.sendMessage({ type: 'GRANT_ORIGIN', payload: { origin } });
  }, ORIGIN);
  expect(granted?.status).toBe('success');

  const registered = await popup.evaluate(async () => chrome.scripting.getRegisteredContentScripts());
  expect((registered as any[]).some((s) => s.id === `pp-agent-${ORIGIN}`)).toBe(true);

  // Reload so the freshly-registered content script actually runs on this page.
  await page.reload();
  const pinged = await page.evaluate(() => (window as any).__proPromptPing(2000));
  expect(pinged).toBe(true);

  // Revoke (the registration half — see header comment)
  await popup.evaluate(async (origin) => {
    await chrome.scripting.unregisterContentScripts({ ids: [`pp-agent-${origin}`] });
  }, ORIGIN);

  const registeredAfter = await popup.evaluate(async () => chrome.scripting.getRegisteredContentScripts());
  expect((registeredAfter as any[]).some((s) => s.id === `pp-agent-${ORIGIN}`)).toBe(false);

  await page.reload();
  const pingedAfterRevoke = await page.evaluate(() => (window as any).__proPromptPing(2000));
  expect(pingedAfterRevoke).toBe(false);
});
