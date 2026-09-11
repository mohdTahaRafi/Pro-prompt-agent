/**
 * SC-3 — zero actions on a non-granted origin. Docs/planning/phase_3_gate_actuation_verification.md
 * §12 task 3.16.
 *
 * http://localhost:5601 (see playwright.config.ts's second webServer) is
 * genuinely, never granted — unlike :5599, it is not a mandatory host
 * permission on the e2e build, so chrome.permissions.contains() actually
 * reports false for it.
 */
import { test, expect } from './fixture';
import { tabIdFor, agentAct } from './agent-helpers';

const UNGRANTED_ORIGIN = 'http://localhost:5601';

test('every verb against an ungranted origin is refused OUT_OF_SCOPE — zero actions reach the page', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  const page = await context.newPage();
  await page.goto(`${UNGRANTED_ORIGIN}/basic-form.html`);
  const tabId = await tabIdFor(popup, `${UNGRANTED_ORIGIN}/basic-form.html`);

  // The content script itself is never even registered on an ungranted
  // origin (lib/policy/scope.ts) — but the gate's own check 3 is the
  // property under test here, independent of that: even a hand-built
  // ActionRequest against this tab is refused before anything is dispatched.
  const readResult: any = await agentAct(popup, tabId, 'read the page');
  expect(readResult.data.phase).toBe('refused');
  expect(readResult.data.code).toBe('OUT_OF_SCOPE');

  const clickResult: any = await agentAct(popup, tabId, 'click Submit');
  expect(clickResult.data.phase).toBe('refused');
  expect(clickResult.data.code).toBe('OUT_OF_SCOPE');

  const typeResult: any = await agentAct(popup, tabId, 'type "x" into the full name field');
  expect(typeResult.data.phase).toBe('refused');
  expect(typeResult.data.code).toBe('OUT_OF_SCOPE');

  // Nothing on the page moved: the field is still empty.
  const value = await page.locator('#full-name').inputValue();
  expect(value).toBe('');
});
