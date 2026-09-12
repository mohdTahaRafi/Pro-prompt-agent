/**
 * The false-confirmation gate — Docs/planning/phase_3_gate_actuation_verification.md
 * §7.2, §12 task 3.16. §3.8 makes exactly one verification property a
 * zero-tolerance CI gate: a `confirmed` verdict on an Always-tier action
 * that did not take effect must NEVER occur. fixtures/swallowed-submit.html
 * wires its submit button to swallow the click; this test asserts
 * `verified !== 'confirmed'` and IS the assertion that fails the build.
 */
import { test, expect } from './fixture';
import { grant, tabIdFor, resolveHandle, benchAct, benchApprove } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';

test('a swallowed submit click never reads as confirmed', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await grant(popup, ORIGIN);

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/swallowed-submit.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/swallowed-submit.html`);
  const handle = await resolveHandle(popup, tabId, { nameIncludes: 'Submit application' });

  const requested: any = await benchAct(popup, tabId, { verb: 'click', handle });
  // A submit-type control is Always tier (§5.2) — it holds for approval.
  expect(requested.data.phase).toBe('needs_approval');

  const approved: any = await benchApprove(popup, requested.data.requestId, true);
  expect(approved.data.phase).toBe('done');

  // THE GATE.
  expect(approved.data.verified).not.toBe('confirmed');
  expect(approved.data.verified).toBe('unconfirmed');

  // And the page really is untouched — no navigation happened.
  await expect(page).toHaveURL(`${ORIGIN}/swallowed-submit.html`);
});
