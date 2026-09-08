/**
 * Two specific claims from Phase 2 §12's milestone narrative, checked
 * directly against a real Chrome content script:
 *
 * 1. "They scroll the page and press Read structure again: the epoch
 *    increments to 2" — two PERCEIVE_STRUCTURE calls against the same tab
 *    produce increasing epoch numbers.
 * 2. "They collapse a section on the page, press Read element on a handle
 *    inside it, and get visible: false rather than an error" — a hidden
 *    (display:none) element is still described, not omitted or errored.
 */
import { test, expect } from './fixture';

const ORIGIN = 'http://localhost:5599';

test('epoch increments across repeated PERCEIVE_STRUCTURE calls on the same tab', async ({ context, extensionId }) => {
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

  const first = await popup.evaluate(async (tid) => {
    return chrome.tabs.sendMessage(tid, { type: 'PERCEIVE_STRUCTURE', runId: 'epoch-1', tokenBudget: 6000 });
  }, tabId);
  const second = await popup.evaluate(async (tid) => {
    return chrome.tabs.sendMessage(tid, { type: 'PERCEIVE_STRUCTURE', runId: 'epoch-2', tokenBudget: 6000 });
  }, tabId);

  expect(first.data.epoch).toBeGreaterThanOrEqual(1);
  expect(second.data.epoch).toBeGreaterThan(first.data.epoch);
});

test('a hidden element is described with visible:false, not omitted or errored', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/basic-form.html`);
  // Collapse the comment-box the way a real "Show more" toggle would.
  await page.evaluate(() => {
    const el = document.getElementById('comment-box');
    if (el) el.style.display = 'none';
  });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(async (origin) => {
    return chrome.runtime.sendMessage({ type: 'GRANT_ORIGIN', payload: { origin } });
  }, ORIGIN);

  await page.reload();
  await page.evaluate(() => {
    const el = document.getElementById('comment-box');
    if (el) el.style.display = 'none';
  });
  await page.waitForTimeout(300);

  const tabs = await popup.evaluate(async (origin) => chrome.tabs.query({ url: `${origin}/*` }), ORIGIN);
  const tabId = (tabs[0] as { id: number }).id;

  const structureResp = await popup.evaluate(async (tid) => {
    return chrome.tabs.sendMessage(tid, { type: 'PERCEIVE_STRUCTURE', runId: 'hidden-check', tokenBudget: 6000 });
  }, tabId);

  const hidden = structureResp.data.elements.find((e: { name: string }) => e.name.includes('Type a comment'));
  expect(hidden).toBeDefined();
  expect(hidden.visible).toBe(false);

  const elementResp = await popup.evaluate(async (args: { tid: number; handle: string }) => {
    return chrome.tabs.sendMessage(args.tid, { type: 'PERCEIVE_ELEMENT', runId: 'hidden-element', handle: args.handle });
  }, { tid: tabId, handle: hidden.handle });

  expect(elementResp.status).toBe('success');
  expect(elementResp.data.kind).not.toBe('missing');
  expect(elementResp.data.element.visible).toBe(false);
});
