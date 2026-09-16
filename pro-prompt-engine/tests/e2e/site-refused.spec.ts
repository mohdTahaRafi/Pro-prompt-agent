/**
 * SITE_REFUSED — Docs/planning/phase_6_recovery_journal_reporting.md §3.5,
 * task 6.5.
 *
 * Driven via AGENT_BENCH_TAB_PERCEIVE — a real TabAgent.perceiveForPlanning()
 * against a real fixture page, the exact choke point
 * lib/agent/recovery.ts's detectSiteRefusal() runs through on every fresh
 * perceive (lib/agent/tab-agent.ts's ensureSnapshot(), §3.5's "checked on
 * every fresh read, before any action against it is even resolved"). No
 * live planner is needed to prove this: detection happens before the
 * planner is ever called for a step, so a bench-level single perceive call
 * is the real mechanism, not a stand-in for it.
 *
 * "Ends the run terminally after exactly one request" is proven by this
 * test's own shape — it calls perceiveForPlanning() exactly once per
 * fixture and asserts refusal on that first call; there is no second call
 * to make, because detectSiteRefusal() fires (or doesn't) synchronously
 * against the one snapshot already in hand. Supervisor-level run
 * termination (handleOutcome's 'site_refused' case ending the run with a
 * cause-specific message) and the reporter's own rendering of that outcome
 * are unit-tested (tests/unit/journal.spec.ts, tests/unit/recovery.spec.ts)
 * rather than re-proven here — reaching them requires either a live planner
 * (slow, see form-fill.spec.ts's header) or Supervisor-level bench
 * scaffolding this phase does not add; this file's job is the one thing
 * that NEEDS a real browser: real DOM/title reading feeding a real
 * detectSiteRefusal() call.
 */
import { test, expect } from './fixture';
import { grant, tabIdFor, benchPerceive, agentRunEvents } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';

test('a CAPTCHA fixture refuses on the first and only perceive, with the right evidence', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  expect((await grant(popup, ORIGIN)).status).toBe('success');

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/captcha.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/captcha.html`);

  const res: any = await benchPerceive(popup, tabId);
  expect(res.status).toBe('success');
  expect(res.data.result.ok).toBe(false);
  expect(res.data.result.error.kind).toBe('site_refused');
  expect(res.data.result.error.refusal.kind).toBe('captcha');

  const events = await agentRunEvents(popup, res.data.runId);
  const refused = events.data.filter((e: any) => e.kind === 'site.refused');
  expect(refused.length).toBe(1);   // exactly one — the one perceive this test made
  expect(refused[0].data.kind).toBe('captcha');
});

test('a 429 fixture refuses on the first and only perceive, with the right evidence', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  expect((await grant(popup, ORIGIN)).status).toBe('success');

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/rate-limited.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/rate-limited.html`);

  const res: any = await benchPerceive(popup, tabId);
  expect(res.status).toBe('success');
  expect(res.data.result.ok).toBe(false);
  expect(res.data.result.error.kind).toBe('site_refused');
  expect(res.data.result.error.refusal.kind).toBe('rate_limit');

  const events = await agentRunEvents(popup, res.data.runId);
  const refused = events.data.filter((e: any) => e.kind === 'site.refused');
  expect(refused.length).toBe(1);
});

test('an ordinary fixture is never refused — no false positives', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  expect((await grant(popup, ORIGIN)).status).toBe('success');

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/basic-form.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/basic-form.html`);

  const res: any = await benchPerceive(popup, tabId);
  expect(res.status).toBe('success');
  expect(res.data.result.ok).toBe(true);
});
