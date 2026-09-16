/**
 * PARTIAL_EFFECT — Docs/planning/phase_6_recovery_journal_reporting.md §3.6,
 * task 6.6.
 *
 * Driven via AGENT_BENCH_TAB_STEP — see recovery.bench.ts's header for why
 * that message (not AGENT_BENCH_ACT) is the one that reaches
 * lib/agent/recovery.ts's table at all. PARTIAL_EFFECT's own RecoveryAction
 * (`approve_retry`) surfaces directly as TabAgent.executeStep()'s
 * `needs_retry_approval` outcome — a Tab-Agent-level result, not a
 * Supervisor one, so no live planner or offscreen Supervisor is needed to
 * prove "never auto-retried, approval required" (task 6.6's own wording).
 * The Supervisor-level continuation of this hold (awaiting_approval,
 * approve-retries/deny-ends) is unit-tested
 * (tests/unit/recovery.spec.ts, and lib/agent/supervisor.ts's
 * awaitRecoveryApproval()) rather than re-proven here — reaching it live
 * needs a real planner, which this sandbox's offscreen documents cannot
 * currently run end-to-end (tests/e2e/fixture.ts's header).
 */
import { test, expect } from './fixture';
import { grant, tabIdFor, resolveHandle, benchStep, agentRunEvents } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';

test('a submit that shows an error banner asks for retry approval, never auto-retries', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  expect((await grant(popup, ORIGIN)).status).toBe('success');

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/error-banner-submit.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/error-banner-submit.html`);
  const handle = await resolveHandle(popup, tabId, { role: 'button', nameIncludes: 'Submit' });

  const step = {
    n: 1, intent: 'submit the checkout form', action: { verb: 'click', handle },
    expectation: 'the order is placed', targetHint: { role: 'button', name: 'Submit' },
  };
  const res: any = await benchStep(popup, tabId, step);
  expect(res.status, JSON.stringify(res)).toBe('success');
  expect(res.data.outcome.kind, JSON.stringify(res.data.outcome)).toBe('needs_retry_approval');
  expect(res.data.outcome.question).toContain('error');

  const events = await agentRunEvents(popup, res.data.runId);
  const kinds = events.data.map((e: any) => e.kind);
  // Exactly one dispatch — the retry this test never approved must never
  // have happened on its own.
  expect(kinds.filter((k: string) => k === 'action.dispatched').length, JSON.stringify(kinds)).toBe(1);
  expect(kinds).toContain('recovery.attempted');
  const attempted = events.data.find((e: any) => e.kind === 'recovery.attempted');
  expect(attempted.data.cause).toBe('PARTIAL_EFFECT');
  expect(attempted.data.action).toBe('approve_retry');
});
