/**
 * SC-3 — zero actions on a non-granted origin. Docs/planning/phase_3_gate_actuation_verification.md
 * §12 task 3.16.
 *
 * http://localhost:5601 (see playwright.config.ts's second webServer) is
 * genuinely, never granted — unlike :5599, it is not a mandatory host
 * permission on the e2e build, so chrome.permissions.contains() actually
 * reports false for it.
 *
 * An ungranted origin has no registered content script at all
 * (lib/policy/scope.ts), so every verb here is refused OUT_OF_SCOPE at the
 * PERCEIVE step, before a gate check on an ActionRequest is even reached —
 * gate.ts's own checks 3b/3c (tests/unit/gate.spec.ts) cover that boundary
 * directly. This test is the end-to-end, user-visible half of SC-3: no
 * matter the verb, nothing reaches an ungranted page.
 */
import { test, expect } from './fixture';
import { tabIdFor, benchAct } from './agent-helpers';

const UNGRANTED_ORIGIN = 'http://localhost:5601';

test('every verb against an ungranted origin is refused OUT_OF_SCOPE — zero actions reach the page', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  const page = await context.newPage();
  await page.goto(`${UNGRANTED_ORIGIN}/basic-form.html`);
  const tabId = await tabIdFor(popup, `${UNGRANTED_ORIGIN}/basic-form.html`);

  const readResult: any = await benchAct(popup, tabId, { verb: 'read_page' });
  expect(readResult.data.phase).toBe('refused');
  expect(readResult.data.code).toBe('OUT_OF_SCOPE');

  const clickResult: any = await benchAct(popup, tabId, { verb: 'click', handle: 'e0' });
  expect(clickResult.data.phase).toBe('refused');
  expect(clickResult.data.code).toBe('OUT_OF_SCOPE');

  const typeResult: any = await benchAct(popup, tabId, { verb: 'type', handle: 'e0', text: 'x', mode: 'replace' });
  expect(typeResult.data.phase).toBe('refused');
  expect(typeResult.data.code).toBe('OUT_OF_SCOPE');

  // Nothing on the page moved: the field is still empty.
  const value = await page.locator('#full-name').inputValue();
  expect(value).toBe('');
});
