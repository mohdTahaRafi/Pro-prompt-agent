/**
 * J-1 end to end — Docs/planning/phase_5_agent_loop.md §11 task 5.17, §12's
 * Milestone Definition.
 *
 * Drives the REAL pipeline: AGENT_ADMIT_RUN -> a REAL local planner call
 * (Ollama, whichever installed model clears the 7B capability floor —
 * lib/model/engines/ollama.ts's probeOllamaPlanner(), no SET_OLLAMA_CONFIG
 * needed) -> plan approval -> the Supervisor's real step loop against the
 * real content script -> a hold at the Always-tier Submit button.
 *
 * Talks to the AGENT_* message protocol directly from the popup page,
 * the same boundary every other e2e spec in this suite uses — not through
 * entrypoints/sidepanel/Cockpit.tsx's own UI. The Cockpit is a thin React
 * read of exactly this same state (db.runs/db.runEvents via a Dexie
 * liveQuery) with no logic of its own to diverge from what is asserted
 * here; this test's value is proving the real backend loop (planner, gate,
 * actuation, verification) against a real local LLM and real Chrome.
 *
 * A local 8B model on CPU is slow (measured ~1 tok/s-class throughput in
 * this environment) — timeouts here are generous on purpose. This is
 * exactly the class of test this repo already flags as needing a real dev
 * machine (a faster local model, or a GPU) to run quickly; it is included
 * because Ollama with a capable model IS reachable in this environment.
 */
import { test, expect } from './fixture';
import { grant, tabIdFor } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';

async function admitRun(popup: any, tabId: number, goal: string, mode: string) {
  return popup.evaluate(async ({ tabId, goal, mode }: any) => {
    return chrome.runtime.sendMessage({ type: 'AGENT_ADMIT_RUN', payload: { tabId, goal, mode, posture: 'local-only' } });
  }, { tabId, goal, mode });
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

async function approvePlan(popup: any, runId: number) {
  return popup.evaluate(async (runId: number) => {
    return chrome.runtime.sendMessage({ type: 'AGENT_PLAN_APPROVAL', payload: { runId, approve: true } });
  }, runId);
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

test('a real plan is produced, approved, and at least one field is filled and verified', async ({ context, extensionId }) => {
  test.setTimeout(6 * 60_000);   // a real local 8B-class planner call is slow — see file header

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  expect((await grant(popup, ORIGIN)).status).toBe('success');

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/application-form.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/application-form.html`);

  const admitted: any = await admitRun(popup, tabId, 'Fill this in from my details and stop before submitting.', 'supervised');
  expect(admitted.status, JSON.stringify(admitted)).toBe('success');
  expect(admitted.data.phase, JSON.stringify(admitted.data)).toBe('admitted');
  const runId = admitted.data.runId;

  // trigger 1 (run_start, §4.3) — a real Ollama call producing a real Plan.
  const planned = await waitForState(popup, runId, ['awaiting_plan_approval', 'failed'], 4 * 60_000);
  expect(planned.state, JSON.stringify(await getEvents(popup, runId))).toBe('awaiting_plan_approval');
  expect(planned.plan.steps.length).toBeGreaterThan(0);

  const proposed = (await getEvents(popup, runId)).find((e: any) => e.kind === 'plan.proposed');
  expect(proposed).toBeDefined();

  await approvePlan(popup, runId);

  // The plan should reach a Submit hold (Always tier) or complete — either
  // is a legitimate real outcome for a small local model's plan; both
  // prove the loop actually executed real steps against the real page.
  const settled = await waitForState(popup, runId, ['awaiting_approval', 'completed', 'failed', 'stopped'], 4 * 60_000);
  const events = await getEvents(popup, runId);
  const observed = events.filter((e: any) => e.kind === 'action.observed' && e.data?.verified);

  expect(observed.length, JSON.stringify(events.map((e: any) => [e.kind, e.data]))).toBeGreaterThan(0);
  expect(['awaiting_approval', 'completed', 'failed', 'stopped']).toContain(settled.state);

  // The page was genuinely touched — at least one real field carries a
  // real value, not a planner hallucination that never reached the DOM.
  const values = await page.evaluate(() => ({
    name: (document.getElementById('full-name') as HTMLInputElement)?.value,
    email: (document.getElementById('email') as HTMLInputElement)?.value,
    phone: (document.getElementById('phone') as HTMLInputElement)?.value,
  }));
  expect(Object.values(values).some((v) => v && v.length > 0)).toBe(true);

  // Submit itself must never have gone through without approval.
  const submitted = await page.locator('#submitted').isHidden();
  if (settled.state !== 'completed') expect(submitted).toBe(true);
});
