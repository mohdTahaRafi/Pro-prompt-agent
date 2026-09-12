/**
 * The gate -> dispatch -> verify pipeline end to end, against the real
 * content script and real Chrome DOM/event semantics.
 * Docs/planning/phase_3_gate_actuation_verification.md task 3.8 (native-setter
 * type, full pointer click) and task 3.9 (navigation verbs from the
 * service worker). Driven via AGENT_BENCH_ACT — see agent-helpers.ts's
 * header for why (Phase 5 §16: lib/agent/intent.ts, which used to resolve
 * these tests' plain-language instructions, is deleted).
 */
import { test, expect } from './fixture';
import { grant, tabIdFor, resolveHandle, benchAct } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';

test('type on a React-style controlled input lands and survives the framework\'s own re-render', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  expect((await grant(popup, ORIGIN)).status).toBe('success');

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/react-form.html`);
  await page.waitForTimeout(300);   // let the render loop start

  const tabId = await tabIdFor(popup, `${ORIGIN}/react-form.html`);
  const handle = await resolveHandle(popup, tabId, { nameIncludes: 'Full name' });
  const result: any = await benchAct(popup, tabId, { verb: 'type', handle, text: 'Mohd Taha', mode: 'replace' });
  expect(result.status).toBe('success');
  expect(result.data.phase).toBe('done');
  expect(result.data.verified).toBe('confirmed');

  // Give the framework's render loop several more frames a chance to
  // revert a naive write, if the actuator had used one.
  await page.waitForTimeout(500);
  const finalValue = await page.evaluate(() => (window as any).__lastValue());
  expect(finalValue).toBe('Mohd Taha');
});

test('click on a pointerdown-only custom control fires the handler', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await grant(popup, ORIGIN);

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/custom-button.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/custom-button.html`);

  const handle = await resolveHandle(popup, tabId, { role: 'button', nameIncludes: 'Continue' });
  const result: any = await benchAct(popup, tabId, { verb: 'click', handle });
  expect(result.data.phase).toBe('done');

  const fired = await page.locator('#result').textContent();
  expect(fired).toBe('fired');
});

test('type into a contenteditable rich editor lands via execCommand insertText', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await grant(popup, ORIGIN);

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/quill.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/quill.html`);

  const handle = await resolveHandle(popup, tabId, { nameIncludes: 'Message' });
  const result: any = await benchAct(popup, tabId, { verb: 'type', handle, text: 'Hello there', mode: 'replace' });
  expect(result.data.phase).toBe('done');

  const text = await page.evaluate(() => (window as any).__editorText());
  expect(text).toBe('Hello there');
  // `input` is the event verified, empirically, to reliably fire from
  // execCommand('insertText', ...) in this Chromium build — see
  // lib/page/actuator.ts's header note on `beforeinput`.
  const events = await page.locator('#events-log').textContent();
  expect(events).toContain('input');
});

test('navigate to an ungranted origin is refused OUT_OF_SCOPE and the tab does not move', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await grant(popup, ORIGIN);

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/basic-form.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/basic-form.html`);

  const result: any = await benchAct(popup, tabId, { verb: 'navigate', url: 'http://localhost:5601/basic-form.html' });
  expect(result.data.phase).toBe('refused');
  expect(result.data.code).toBe('OUT_OF_SCOPE');
  expect(page.url()).toBe(`${ORIGIN}/basic-form.html`);
});

test('history_back returns to the previous URL and verifies via location', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await grant(popup, ORIGIN);

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/basic-form.html`);
  await page.goto(`${ORIGIN}/index.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/index.html`);

  const result: any = await benchAct(popup, tabId, { verb: 'history_back' });
  expect(result.data.phase).toBe('done');
  expect(result.data.check).toBe('location');
  expect(result.data.verified).toBe('confirmed');
  await expect(page).toHaveURL(`${ORIGIN}/basic-form.html`);
});

test('a click on a real cookie-banner-covered button is refused OBSCURED, against real Chrome layout', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await grant(popup, ORIGIN);

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/modal-cover.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/modal-cover.html`);

  const handle = await resolveHandle(popup, tabId, { role: 'button', nameIncludes: 'Continue' });
  const result: any = await benchAct(popup, tabId, { verb: 'click', handle });
  expect(result.data.phase).toBe('failed');
  expect(result.data.failureCause).toBe('OBSCURED');

  // Dismiss the cookie banner and try again — now it lands. Re-resolved,
  // not reused: handles are per-epoch and the page just changed.
  await page.locator('#accept-cookies').click();
  const handleAfter = await resolveHandle(popup, tabId, { role: 'button', nameIncludes: 'Continue' });
  const after: any = await benchAct(popup, tabId, { verb: 'click', handle: handleAfter });
  expect(after.data.phase).toBe('done');
});
