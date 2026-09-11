/**
 * Stop — Docs/planning/phase_3_gate_actuation_verification.md §10, §12 task 3.13.
 * The physical floor is one in-flight DOM operation: stop cannot undo an
 * action already dispatched, but everything after it is refused.
 *
 * SPEC NOTE: pressing Stop moves the CURRENT run to its terminal 'stopped'
 * state (run-state.ts: stopped has no outgoing transitions). A brand new
 * instruction typed afterward against the same tab starts a NEW run — that
 * is ordinary "stop the current task, then ask for something else" product
 * behaviour, not a way around Stop — so these tests verify the actual
 * guarantee directly (the flag, the run's own journal, its terminal state)
 * rather than by re-driving AGENT_ACT and expecting it to reuse the
 * now-terminal run.
 */
import { test, expect } from './fixture';
import { grant, tabIdFor, agentAct, agentActFireAndForget, agentStop, agentRunEvents } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';

async function runIdForTab(popup: any, tabId: number): Promise<number> {
  return popup.evaluate(async (tId: number) => {
    const runs: any = await chrome.runtime.sendMessage({ type: 'AGENT_LIST_RUNS' });
    return runs.data.find((r: any) => r.roster[0] === tId)?.id;
  }, tabId);
}

test('the stop flag is gate-visible within 250ms of the press, and the run reaches "stopped"', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await grant(popup, ORIGIN);

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/basic-form.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/basic-form.html`);

  const first: any = await agentAct(popup, tabId, 'read the page');
  expect(first.data.phase).toBe('done');
  const runId = await runIdForTab(popup, tabId);
  expect(runId).toBeDefined();

  const t0 = Date.now();
  await agentStop(popup, runId);
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThanOrEqual(250);

  const stopFlag = await popup.evaluate(async (rId) => {
    const key = `stop:${rId}`;
    const store: any = await chrome.storage.session.get(key);
    return store[key];
  }, runId);
  expect(stopFlag).toBe(true);

  const runs: any = await popup.evaluate(async () => chrome.runtime.sendMessage({ type: 'AGENT_LIST_RUNS' }));
  const run = runs.data.find((r: any) => r.id === runId);
  expect(run.state).toBe('stopped');
});

test('pressing Stop mid-action allows the in-flight dispatch to finish but refuses everything after — zero further action.dispatched events', async ({ context, extensionId }) => {
  test.setTimeout(30_000);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await grant(popup, ORIGIN);

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/slow-settle.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/slow-settle.html`);

  // A quick read first, purely to learn this tab's runId before the slow
  // action starts.
  await agentAct(popup, tabId, 'read the page');
  const runId = await runIdForTab(popup, tabId);

  // Fire the slow action (typing triggers the never-settling suggestions
  // loop, the fixture's own header comment) without awaiting its response.
  await agentActFireAndForget(popup, tabId, 'type "hello" into the search field');
  // Give it time to actually dispatch (fast) and enter the long
  // post-action settle wait (slow) before pressing Stop.
  await page.waitForTimeout(1_000);

  const stopResult: any = await agentStop(popup, runId);
  expect(stopResult.status).toBe('success');

  // Let the first (in-flight) action's own up-to-8s settle wait finish so
  // its journal events are all written before inspecting them.
  await page.waitForTimeout(9_000);

  const events: any = await agentRunEvents(popup, runId);
  const dispatched = events.data.filter((e: any) => e.kind === 'action.dispatched');
  // The quick "read the page" used to learn runId dispatches too (reads are
  // dispatched, non-mutating actions) — the property under test is that
  // exactly ONE `type` dispatch happened (the in-flight one), never a
  // second, blocked one.
  const typeDispatches = dispatched.filter((e: any) => e.data.verb === 'type');
  expect(typeDispatches.length).toBe(1);

  const runs: any = await popup.evaluate(async () => chrome.runtime.sendMessage({ type: 'AGENT_LIST_RUNS' }));
  expect(runs.data.find((r: any) => r.id === runId)?.state).toBe('stopped');
});
