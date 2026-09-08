/**
 * A real Chrome run of the perception pipeline (Phase 2 §9, §12 milestone).
 * Grants the fixture origin (same code path grant-revoke.spec.ts exercises),
 * then sends PERCEIVE_STRUCTURE, WAIT_FOR_SETTLE and PERCEIVE_ELEMENT
 * straight to the content script via chrome.tabs.sendMessage — the same
 * path the Perception debug tab (entrypoints/options/App.tsx) uses — and
 * asserts the response is schema-valid and describes the fixture page
 * correctly. This is the one thing the unit suite (happy-dom) cannot prove
 * on its own: that agent.content.ts actually answers these messages inside
 * a real, running Chrome content script.
 */
import { test, expect } from './fixture';

const ORIGIN = 'http://localhost:5599';

test('PERCEIVE_STRUCTURE returns a schema-valid snapshot describing the real page', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/basic-form.html`);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const granted = await popup.evaluate(async (origin) => {
    return chrome.runtime.sendMessage({ type: 'GRANT_ORIGIN', payload: { origin } });
  }, ORIGIN);
  expect(granted?.status).toBe('success');

  await page.reload();
  // Content script needs a beat to attach its onMessage listener after
  // document_idle registration + reload.
  await page.waitForTimeout(300);

  const tabs = await popup.evaluate(async (origin) => {
    return chrome.tabs.query({ url: `${origin}/*` });
  }, ORIGIN);
  expect(tabs.length).toBeGreaterThan(0);
  const tabId = (tabs[0] as { id: number }).id;

  const response = await popup.evaluate(async (tid) => {
    return chrome.tabs.sendMessage(tid, {
      type: 'PERCEIVE_STRUCTURE', runId: 'e2e-run', tokenBudget: 6000,
    });
  }, tabId);

  expect(response?.status).toBe('success');
  const snapshot = response.data;
  expect(snapshot.url).toContain('basic-form.html');
  expect(typeof snapshot.epoch).toBe('number');
  expect(snapshot.epoch).toBeGreaterThan(0);
  expect(Array.isArray(snapshot.elements)).toBe(true);

  // The named field, the placeholder-named textarea, and the submit button
  // must all appear with real accessible names.
  const names = snapshot.elements.map((e: { name: string }) => e.name);
  expect(names).toContain('Full name');
  expect(names).toContain('Submit');
  expect(snapshot.elements.some((e: { name: string }) => e.name.includes('Type a comment'))).toBe(true);

  // Region derivation: the form should be its own region, complete.
  const formRegion = snapshot.regions.find((r: { regionId: string }) => r.regionId.startsWith('form:'));
  expect(formRegion).toBeDefined();
  expect(formRegion.complete).toBe(true);

  // Settle: on a static fixture with no ongoing mutation, this should
  // settle well inside the 8s visible cap.
  expect(typeof snapshot.settled).toBe('boolean');
  expect(snapshot.settleCalibration).toBe('visible');
});

test('WAIT_FOR_SETTLE and PERCEIVE_ELEMENT answer real messages against the real content script', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/basic-form.html`);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(async (origin) => {
    return chrome.runtime.sendMessage({ type: 'GRANT_ORIGIN', payload: { origin } });
  }, ORIGIN);

  await page.reload();
  await page.waitForTimeout(300);

  const tabs = await popup.evaluate(async (origin) => chrome.tabs.query({ url: `${origin}/*` }), ORIGIN);
  const tabId = (tabs[0] as { id: number }).id;

  const settleResp = await popup.evaluate(async (tid) => {
    return chrome.tabs.sendMessage(tid, { type: 'WAIT_FOR_SETTLE', runId: 'e2e-settle', maxMs: 2000 });
  }, tabId);
  expect(settleResp?.status).toBe('success');
  expect(settleResp.data.settled).toBe(true);

  const structureResp = await popup.evaluate(async (tid) => {
    return chrome.tabs.sendMessage(tid, { type: 'PERCEIVE_STRUCTURE', runId: 'e2e-for-element', tokenBudget: 6000 });
  }, tabId);
  const submitHandle = structureResp.data.elements.find((e: { name: string }) => e.name === 'Submit').handle;

  const elementResp = await popup.evaluate(async (args: { tid: number; handle: string }) => {
    return chrome.tabs.sendMessage(args.tid, { type: 'PERCEIVE_ELEMENT', runId: 'e2e-element', handle: args.handle });
  }, { tid: tabId, handle: submitHandle });

  expect(elementResp?.status).toBe('success');
  expect(elementResp.data.kind).toBe('exact');
  expect(elementResp.data.element.name).toBe('Submit');
});
