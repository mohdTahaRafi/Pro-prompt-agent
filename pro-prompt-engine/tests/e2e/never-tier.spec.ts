/**
 * SC-2 — zero reads or writes on password/payment/OTP fields, across the
 * Copilot pipeline this time (Phase 2's sensitive-untouched.spec.ts already
 * covers the raw message-boundary property). Docs/planning/phase_3_gate_actuation_verification.md
 * §12 task 3.16.
 */
import { test, expect } from './fixture';
import { grant, tabIdFor, agentAct } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';

test('the Copilot cannot type into a password field — it has no handle to name', async ({ context, extensionId }) => {
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

  const result: any = await agentAct(popup, tabId, 'type "hunter2" into the password field');
  expect(result.data.phase).toBe('unmatched');

  const otp: any = await agentAct(popup, tabId, 'type "123456" into the one time code field');
  expect(otp.data.phase).toBe('unmatched');

  const card: any = await agentAct(popup, tabId, 'type "4111111111111111" into the card number field');
  expect(card.data.phase).toBe('unmatched');

  // No ACTUATE message for a `type` verb was ever sent to the content
  // script — the resolver never had a handle to build one with.
  const sent = await sw.evaluate(() => (globalThis as any).__ppSent ?? []);
  const actuateTypes = sent.filter((m: any) => m?.type === 'ACTUATE' && m?.action?.verb === 'type');
  expect(actuateTypes).toEqual([]);

  const pwField = await page.locator('#login-pw').inputValue();
  expect(pwField).toBe('');
});
