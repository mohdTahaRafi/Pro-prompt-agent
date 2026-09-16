/**
 * J-2 end to end — Docs/planning/phase_6_recovery_journal_reporting.md
 * §11 task 6.14, §9's Milestone Definition.
 *
 * Drives the REAL pipeline exactly like tests/e2e/form-fill.spec.ts (real
 * Ollama planner via the relay-backend fix documented in that file's and
 * tests/e2e/fixture.ts's headers -> real Supervisor/TabAgent loop against
 * a real content script) against fixtures/collapsed-specs.html: a monitor
 * spec table showing 6 rows on load, growing to 22 real rows once "Show
 * full specifications" is clicked (a real DOM insertion — verified directly
 * against lib/page/perception.ts's repeat-region detector before this spec
 * was written: region total genuinely reads 6, then 22, at the real
 * PERCEIVE_STRUCTURE token budget of 6,000). "Refresh rate" and "Panel
 * type" are never present on the page, expanded or not.
 *
 * [Phase 6 e2e, this session] What this spec can and cannot assert, stated
 * up front rather than discovered by a flaky test later: lib/agent/
 * reporter.ts's deriveGaps() names an individual missing FIELD only via its
 * per-plan-step gap path (a step the journal shows was never observed) —
 * its region shown/total path (the one J-2's "6 of 22" scenario actually
 * exercises) can only report a region-level count ("N of M in <region>"),
 * never a field name, by design (reporter.ts's own comment: "Individual
 * field NAMES are not knowable from shown/total alone"). Whether "Refresh
 * rate" and "Panel type" appear BY NAME in the finished report therefore
 * depends on whether the REAL local planner decomposes its plan into one
 * step per named field (a planning-QUALITY question this spec measures
 * honestly, not a code-correctness one it can force) — this spec asserts
 * the mechanically-guaranteed part (no user interaction; the table was
 * actually expanded and re-read; the run ends honestly rather than
 * hallucinating values for the two fields that were never on the page) and
 * logs, rather than hard-asserts, whether the smaller local model's own
 * plan happened to name them.
 */
import { test, expect } from './fixture';
import { grant, tabIdFor } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';
// Same throwaway, CORS-open Ollama instance form-fill.spec.ts's header
// documents (system Ollama 403s any chrome-extension:// Origin).
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

test('J-2: a collapsed spec table is expanded and re-read with no user interaction', async ({ context, extensionId }) => {
  // Real CPU inference on a memory-constrained machine (this session found
  // load+eval for a single 8B call can run well past naive expectations
  // under swap pressure) — generous on purpose, not padding.
  test.setTimeout(25 * 60_000);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  expect((await grant(popup, ORIGIN)).status).toBe('success');
  expect((await setOllamaConfig(popup, E2E_OLLAMA_URL)).status).toBe('success');

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/collapsed-specs.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/collapsed-specs.html`);

  const goal = 'Pull the specs for this monitor into a table — screen size, refresh rate, panel type, ports, price.';
  const admitted: any = await admitRun(popup, tabId, goal, 'supervised');
  expect(admitted.status, JSON.stringify(admitted)).toBe('success');
  const runId = admitted.data.runId;

  const planned = await waitForState(popup, runId, ['awaiting_plan_approval', 'failed'], 10 * 60_000);
  expect(planned.state, JSON.stringify(await getEvents(popup, runId))).toBe('awaiting_plan_approval');
  expect(planned.plan.steps.length).toBeGreaterThan(0);

  await approvePlan(popup, runId);

  const settled = await waitForState(popup, runId, ['completed', 'failed', 'stopped', 'awaiting_approval'], 14 * 60_000);
  const events = await getEvents(popup, runId);

  // No user interaction of any kind — J-2's own literal requirement.
  const asked = events.filter((e: any) => e.kind === 'ask_user.asked');
  expect(asked.length, JSON.stringify(events.map((e: any) => e.kind))).toBe(0);
  expect(settled.state, JSON.stringify(events.map((e: any) => [e.kind, e.data]))).not.toBe('awaiting_approval');

  // The table was actually expanded: some read_structure event's own
  // journaled `regions` array (lib/agent/tab-agent.ts's summariseRead) shows
  // the repeat region at its full 22, not stuck at the initial 6 — the
  // mechanical, code-verifiable half of "detects the shortfall, expands,
  // re-extracts". A run that never clicked "Show full specifications" would
  // never observe a region total above 6 in any read.
  const regionTotals = events
    .filter((e: any) => e.kind === 'action.observed' && e.data?.read?.regions)
    .flatMap((e: any) => e.data.read.regions as Array<{ total: number }>)
    .map((r) => r.total);
  expect(regionTotals, JSON.stringify(regionTotals)).toContain(22);

  // The real page DOM was actually expanded (not just the agent's belief
  // that it was) — the fixture's own count line is the ground truth.
  const finalCountText = await page.locator('#spec-count').textContent().catch(() => null);
  expect(finalCountText).toBe('Showing 22 of 22 specifications.');

  const report = await getReport(popup, runId);
  expect(report).toBeTruthy();
  // Honest reporting (§6.3): never a hallucinated value standing in for a
  // field this run could not find — no gap's `what`/`why`/any step's
  // `evidence` may contain a fabricated refresh-rate/panel-type value.
  const asJson = JSON.stringify(report);
  expect(asJson).not.toMatch(/\b\d+\s*Hz\b/i);         // no invented refresh rate
  expect(asJson).not.toMatch(/\b(IPS|VA|TN|OLED)\b/);  // no invented panel type

  // Whether the two genuinely-missing fields are named BY FIELD in the
  // report depends on this local model's own plan granularity (see header)
  // — logged for the record rather than hard-asserted.
  const mentionsRefresh = /refresh/i.test(asJson);
  const mentionsPanel = /panel/i.test(asJson);
  // eslint-disable-next-line no-console
  console.log(
    `[J-2] outcome=${report.outcome} gaps=${report.gaps.length} mentionsRefreshRateGap=${mentionsRefresh} mentionsPanelTypeGap=${mentionsPanel}\n`
    + JSON.stringify(report, null, 2),
  );
});
