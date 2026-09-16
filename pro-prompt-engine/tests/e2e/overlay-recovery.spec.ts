/**
 * OBSCURED recovery, task 6.2 — Docs/planning/phase_6_recovery_journal_reporting.md
 * §3.2. `overlay.spec.ts`'s own acceptance criteria ("a cookie banner
 * covering a button is dismissed and the original click succeeds") are
 * unit-tested (tests/unit/overlay.spec.ts, happy-dom with stubbed
 * getBoundingClientRect/elementFromPoint) and not in this phase doc's own
 * §11 e2e file list — this file is EXTRA, real-browser confidence beyond
 * what the doc requires: the one thing happy-dom cannot exercise is real
 * CSS layout (a fixed-position banner genuinely covering a fixed-position
 * button's real, browser-computed geometry) and a real
 * chrome.tabs.sendMessage round trip to the content script's DISMISS_OVERLAY
 * handler (lib/actuation/dom-backend.ts's dismissOverlay()).
 *
 * Driven via AGENT_BENCH_TAB_STEP — see recovery.bench.ts's header for why
 * that message (not AGENT_BENCH_ACT) is the one that reaches
 * lib/agent/recovery.ts at all. `targetHint` is required here — see this
 * file's own comment at the call site.
 */
import { test, expect } from './fixture';
import { grant, tabIdFor, resolveHandle, benchStep, agentRunEvents } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';

test('a cookie banner covering a button is dismissed and the original click succeeds', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  expect((await grant(popup, ORIGIN)).status).toBe('success');

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/cookie-banner.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/cookie-banner.html`);
  const handle = await resolveHandle(popup, tabId, { role: 'button', nameIncludes: 'Continue' });

  // targetHint matching the resolved element exactly is what
  // lib/agent/step-resolver.ts's step 1 (deterministic exact match) needs
  // to skip resolution's step 3 (the judge tier) — this page has three
  // actionable elements (Continue, Accept all, Manage preferences), so
  // without it step 2's candidate set has more than one member and this
  // test would need a live offscreen document, which is not what OBSCURED
  // recovery is about proving.
  const step = {
    n: 1, intent: 'click Continue', action: { verb: 'click', handle },
    expectation: 'the page proceeds past the cookie banner',
    targetHint: { role: 'button', name: 'Continue' },
  };
  const res: any = await benchStep(popup, tabId, step);
  expect(res.status, JSON.stringify(res)).toBe('success');
  expect(res.data.outcome.kind, JSON.stringify(res.data.outcome)).toBe('done');
  expect(res.data.outcome.result.verified).not.toBe('failed');

  // A plain button click with no bound state to confirm verifies
  // 'unconfirmed' rather than 'confirmed' (§3.7.4) — so `recovery.recovered`
  // (journaled only when the retry's OWN verdict is 'confirmed') is not the
  // right thing to assert here. What proves the recovery actually happened
  // is the shape of the journal itself: exactly one OBSCURED refusal,
  // followed by an attempted recovery, followed by a SECOND dispatch that
  // reaches the page (never a second refusal — the one-attempt constraint,
  // §3.2 constraint 3, holding on the success path too).
  const events = await agentRunEvents(popup, res.data.runId);
  const kinds = events.data.map((e: any) => e.kind);
  expect(kinds.filter((k: string) => k === 'action.refused').length, JSON.stringify(kinds)).toBe(1);
  const attempted = events.data.find((e: any) => e.kind === 'recovery.attempted');
  expect(attempted?.data?.cause, JSON.stringify(kinds)).toBe('OBSCURED');
  expect(kinds.filter((k: string) => k === 'action.dispatched').length, JSON.stringify(kinds)).toBe(1);

  // The banner is genuinely gone — not just that the agent believes so.
  const bannerGone = await page.locator('#cookie-banner').count();
  expect(bannerGone).toBe(0);
});
