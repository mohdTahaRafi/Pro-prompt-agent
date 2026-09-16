/**
 * AUTH_REQUIRED — Docs/planning/phase_6_recovery_journal_reporting.md §3.4,
 * task 6.4.
 *
 * Driven via AGENT_BENCH_TAB_STEP — see recovery.bench.ts's header. See
 * fixtures/login-redirect.html's own comment for why this is modelled as
 * an in-page login form appearing (a session-timeout modal, mid-run)
 * rather than a real top-level navigation — the jump in excludedCount that
 * follows is exactly what lib/agent/tab-agent.ts's performAndVerify()
 * reads (§3.4), surfacing directly as TabAgent.executeStep()'s
 * `auth_required` outcome, a Tab-Agent-level result the Supervisor is not
 * needed to produce.
 * Supervisor-level pause (`state: 'paused'`) and Resume's re-snapshot are
 * unit-tested (tests/unit/journal.spec.ts,
 * tests/unit/pause-takeover-askuser.spec.ts) rather than re-proven here for
 * the same live-planner-needed reason partial-effect.spec.ts's header
 * names.
 */
import { test, expect } from './fixture';
import { grant, tabIdFor, resolveHandle, benchStep, agentRunEvents } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';

test('a mid-run redirect to a login form pauses, names sign-in, and no credential is ever typed', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  expect((await grant(popup, ORIGIN)).status).toBe('success');

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/login-redirect.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/login-redirect.html`);
  const handle = await resolveHandle(popup, tabId, { role: 'button', nameIncludes: 'Continue' });

  const step = {
    n: 1, intent: 'continue to my account', action: { verb: 'click', handle },
    expectation: 'the account page loads', targetHint: { role: 'button', name: 'Continue' },
  };
  const res: any = await benchStep(popup, tabId, step);
  expect(res.status, JSON.stringify(res)).toBe('success');
  expect(res.data.outcome.kind, JSON.stringify(res.data.outcome)).toBe('auth_required');
  expect(res.data.outcome.message.toLowerCase()).toContain('sign in');

  const events = await agentRunEvents(popup, res.data.runId);
  const kinds = events.data.map((e: any) => e.kind);
  expect(kinds).toContain('auth.required');
  // No `type` action was ever dispatched — this test built no such step,
  // so this is really "the mechanism never reaches for a credential
  // field", not merely "this test didn't ask it to" —
  // sensitive-untouched.spec.ts covers the deeper "no handle exists to
  // name" property directly.
  const typeVerbs = events.data.filter((e: any) => e.kind === 'action.observed' && e.data?.verb === 'type');
  expect(typeVerbs.length).toBe(0);

  // The real DOM confirms it: the password field was never touched.
  const pwValue = await page.locator('#password').inputValue().catch(() => null);
  if (pwValue !== null) expect(pwValue).toBe('');
});
