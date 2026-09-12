/**
 * SC-2 — zero reads or writes on password/payment/OTP fields.
 * Docs/planning/phase_3_gate_actuation_verification.md §12 task 3.16.
 * (Phase 2's sensitive-untouched.spec.ts already covers the raw
 * message-boundary property this exercises again through gate + actuation.)
 *
 * [Phase 5 §16] Rewritten from the old Copilot-panel wording ("it has no
 * handle to name") to assert the SAME property more directly: these
 * fields never even appear among a real PERCEIVE_STRUCTURE's elements, so
 * there is nothing for any caller — planner, judge, or a test — to build a
 * handle-bearing action against. Never tier (lib/policy/tiers.ts) is the
 * defence-in-depth backstop IF one somehow did.
 */
import { test, expect } from './fixture';
import { grant, tabIdFor } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';

test('password/OTP/card fields never appear in a real perceived snapshot — no handle to name', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await grant(popup, ORIGIN);

  const [sw] = context.serviceWorkers();
  await sw.evaluate(() => {
    (globalThis as any).__ppSent = [];
    const orig = chrome.tabs.sendMessage.bind(chrome.tabs);
    (chrome.tabs as any).sendMessage = (...args: any[]) => {
      (globalThis as any).__ppSent.push(args[1]);
      return orig(...args);
    };
  });

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/sensitive-corpus.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/sensitive-corpus.html`);

  const res: any = await popup.evaluate(async (tabId) => {
    return chrome.tabs.sendMessage(tabId, { type: 'PERCEIVE_STRUCTURE', runId: 'e2e', tokenBudget: 6_000 });
  }, tabId);
  expect(res.status).toBe('success');
  const names = (res.data.elements as Array<{ name: string }>).map((e) => e.name.toLowerCase());
  expect(names.some((n) => n.includes('password'))).toBe(false);
  expect(names.some((n) => n.includes('one time code') || n.includes('otp'))).toBe(false);
  expect(names.some((n) => n.includes('card number'))).toBe(false);

  // No ACTUATE message for a `type` verb was ever sent to the content
  // script — nothing in this test ever had a handle to build one with.
  const sent = await sw.evaluate(() => (globalThis as any).__ppSent ?? []);
  const actuateTypes = sent.filter((m: any) => m?.type === 'ACTUATE' && m?.action?.verb === 'type');
  expect(actuateTypes).toEqual([]);

  const pwField = await page.locator('#login-pw').inputValue();
  expect(pwField).toBe('');
});
