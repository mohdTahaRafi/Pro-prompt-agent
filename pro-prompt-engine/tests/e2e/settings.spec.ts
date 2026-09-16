/**
 * J-3 end to end — Docs/planning/phase_6_recovery_journal_reporting.md
 * §11 task 6.15, §9's Milestone Definition.
 *
 * Same real pipeline as tests/e2e/form-fill.spec.ts and tests/e2e/
 * extract.spec.ts (real Ollama planner via the relay-backend fix, real
 * Supervisor/TabAgent loop, real content script) against
 * fixtures/settings-menu/: three REAL separate pages (index -> notifications
 * -> notifications-email), each a genuine navigation the planner cannot see
 * past until it actually arrives — lib/agent/replan.ts's trigger 5
 * (unexpected_change: "URL change ... the plan did not predict") is
 * expected to fire on most steps here, exactly as §9's milestone describes
 * ("navigates a three-level settings menu it could not have planned in
 * advance, re-reading after each step"). The final page has one real,
 * native, checked checkbox ("Marketing emails") the goal asks to be turned
 * off, alongside a distractor the agent must leave alone (a disabled
 * "Security alerts" checkbox it cannot uncheck even if it tried) and a
 * sibling it must not touch ("Weekly digest").
 */
import { test, expect } from './fixture';
import { grant, tabIdFor } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';
const E2E_OLLAMA_URL = 'http://localhost:11500';

async function admitRun(popup: any, tabId: number, goal: string, mode: string) {
  return popup.evaluate(async ({ tabId, goal, mode }: any) => chrome.runtime.sendMessage(
    { type: 'AGENT_ADMIT_RUN', payload: { tabId, goal, mode, posture: 'local-only' } },
  ), { tabId, goal, mode });
}

async function setOllamaConfig(popup: any, baseUrl: string) {
  return popup.evaluate(async (baseUrl: string) => chrome.runtime.sendMessage(
    { type: 'SET_OLLAMA_CONFIG', payload: { baseUrl } },
  ), baseUrl);
}

async function getRun(popup: any, runId: number) {
  return popup.evaluate(async (runId: number) => {
    const res: any = await chrome.runtime.sendMessage({ type: 'AGENT_LIST_RUNS' });
    return res.data.find((r: any) => r.id === runId);
  }, runId);
}

async function getEvents(popup: any, runId: number) {
  return popup.evaluate(async (runId: number) => {
    const res: any = await chrome.runtime.sendMessage({ type: 'AGENT_GET_RUN_EVENTS', payload: { runId } });
    return res.data;
  }, runId);
}

async function getReport(popup: any, runId: number) {
  return popup.evaluate(async (runId: number) => {
    const res: any = await chrome.runtime.sendMessage({ type: 'AGENT_GET_RUN_REPORT', payload: { runId } });
    return res.data;
  }, runId);
}

async function approvePlan(popup: any, runId: number) {
  return popup.evaluate(async (runId: number) => chrome.runtime.sendMessage(
    { type: 'AGENT_PLAN_APPROVAL', payload: { runId, approve: true } },
  ), runId);
}

async function waitForState(popup: any, runId: number, states: string[], timeoutMs: number): Promise<any> {
  const start = Date.now();
  for (;;) {
    const run = await getRun(popup, runId);
    if (run && states.includes(run.state)) return run;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${states.join('|')}, last state: ${run?.state}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

// A run that replans repeatedly approves each generation's own plan in turn
// (the harness has no auto-approve setting) — this polls for
// awaiting_plan_approval OR a further-along state and approves whenever it
// sees the former, so multi-generation runs (exactly what trigger 5 here
// produces) don't stall waiting for a human.
async function driveToCompletion(popup: any, runId: number, deadline: number): Promise<any> {
  for (;;) {
    const run = await getRun(popup, runId);
    if (run && ['completed', 'failed', 'stopped', 'awaiting_approval'].includes(run.state)) return run;
    if (run && run.state === 'awaiting_plan_approval') await approvePlan(popup, runId);
    if (Date.now() > deadline) throw new Error(`timed out waiting for completion, last state: ${run?.state}`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

test('J-3: a three-level settings menu is navigated and the one named toggle is turned off', async ({ context, extensionId }) => {
  test.setTimeout(30 * 60_000);   // multiple real planner calls — see header

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  expect((await grant(popup, ORIGIN)).status).toBe('success');
  expect((await setOllamaConfig(popup, E2E_OLLAMA_URL)).status).toBe('success');

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/settings-menu/index.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/settings-menu/index.html`);

  const goal = 'Turn off marketing emails in my notification settings.';
  const admitted: any = await admitRun(popup, tabId, goal, 'supervised');
  expect(admitted.status, JSON.stringify(admitted)).toBe('success');
  const runId = admitted.data.runId;

  const planned = await waitForState(popup, runId, ['awaiting_plan_approval', 'failed'], 10 * 60_000);
  expect(planned.state, JSON.stringify(await getEvents(popup, runId))).toBe('awaiting_plan_approval');

  const deadline = Date.now() + 20 * 60_000;
  const settled = await driveToCompletion(popup, runId, deadline);
  const events = await getEvents(popup, runId);

  expect(settled.state, JSON.stringify(events.map((e: any) => [e.kind, e.data]))).not.toBe('awaiting_approval');

  // §9's milestone: "trigger 5 fires on most steps and the planner-call
  // count is journaled" — a multi-generation run (index -> notifications ->
  // email each a real, unpredictable navigation) produces more than one
  // plan.proposed/plan.replanned, recorded here for the record.
  const planEvents = events.filter((e: any) => e.kind === 'plan.proposed' || e.kind === 'plan.replanned');
  const anomalyReplans = events.filter((e: any) => e.kind === 'anomaly.detected');
  // eslint-disable-next-line no-console
  console.log(`[J-3] planner calls journaled: ${planEvents.length} (kinds: ${planEvents.map((e: any) => e.kind).join(', ')}), anomaly events: ${anomalyReplans.length}`);
  expect(planEvents.length, JSON.stringify(planEvents)).toBeGreaterThan(1);

  // The final page's checkbox state is the ground truth for the toggle —
  // verified by state (unchecked) AND by the absence of an error banner.
  const finalUrl = page.url();
  if (!finalUrl.includes('notifications-email.html')) {
    await page.goto(`${ORIGIN}/settings-menu/notifications-email.html`);
  }
  const state = await page.evaluate(() => ({
    marketing: (document.getElementById('marketing-emails') as HTMLInputElement)?.checked,
    digest: (document.getElementById('weekly-digest') as HTMLInputElement)?.checked,
    security: (document.getElementById('security-alerts') as HTMLInputElement)?.checked,
    errorVisible: !(document.getElementById('error-banner') as HTMLElement)?.hidden,
  }));

  expect(state.marketing, JSON.stringify(state)).toBe(false);
  expect(state.digest, JSON.stringify(state)).toBe(true);     // untouched sibling
  expect(state.security, JSON.stringify(state)).toBe(true);   // locked, never toggled
  expect(state.errorVisible).toBe(false);

  const report = await getReport(popup, runId);
  // eslint-disable-next-line no-console
  console.log(`[J-3] outcome=${report.outcome}\n${JSON.stringify(report, null, 2)}`);
});
