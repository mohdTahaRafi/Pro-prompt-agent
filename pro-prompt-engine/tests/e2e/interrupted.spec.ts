/**
 * Interrupted runs halt — Docs/planning/phase_5_agent_loop.md §3.1, §11
 * task 5.15: "Closing the offscreen document mid-run and waking the SW
 * journals run.interrupted and sets halted; the run is NOT resumed; the
 * panel shows what completed."
 *
 * The mechanism under test is lib/agent/reconcile.ts's reconcileRuns():
 * every non-terminal `runs` row whose id is absent from the offscreen
 * document's own Supervisor registry (asked via LIST_RUNS) gets journaled
 * `run.interrupted` and moved to `halted`.
 *
 * SCOPE NOTE (2026-09-13 acceptance audit), two layers:
 *
 * 1. In production, reconcileRuns() runs once per service-worker
 *    evaluation (background.ts's own comment: an MV3 SW re-executes its
 *    whole module top-level on every wake). Driving that from outside the
 *    browser means literally crashing and respawning the SW process — this
 *    file first tried exactly that, via CDP `Target.closeTarget` on the
 *    SW's own target. It does not work in this environment: polled for 10
 *    real seconds sending real messages afterward, no fresh service_worker
 *    target ever appeared — this extension's SW registration does not
 *    survive an explicit debugger-driven kill the way a natural idle
 *    timeout does (Chrome likely suppresses the auto-respawn while a CDP
 *    session is attached, to avoid fighting an active debugging session).
 *    `AGENT_BENCH_RECONCILE` (e2e-only, entrypoints/background.ts) calls
 *    the exact same reconcileRuns() function on demand instead, so this
 *    test still exercises real production logic against real
 *    chrome.storage/IndexedDB/messaging — it just doesn't also prove a
 *    literal SW process restart, which tests/unit/reconcile.spec.ts's
 *    controllable double was never going to prove either.
 *
 * 2. This environment's `chrome.offscreen.createDocument()` never executes
 *    the offscreen document's script at all (lib/model/offscreen-bridge.ts's
 *    header has the full verification), so LIST_RUNS is unreachable here
 *    for the SAME reason a real Supervisor is unreachable — which makes
 *    every non-terminal run look exactly like "the Supervisor holding it
 *    is gone" starting from the very first check, precisely the scenario
 *    this task's AC describes, just arrived at via an environment
 *    limitation instead of a deliberately-closed offscreen document.
 */
import { test, expect } from './fixture';
import { grant, tabIdFor, resolveHandle, benchAct, agentListRuns, agentRunEvents } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';

async function benchReconcile(popup: any) {
  return popup.evaluate(async () => chrome.runtime.sendMessage({ type: 'AGENT_BENCH_RECONCILE' }));
}

test('a non-terminal run whose Supervisor cannot be found is journaled run.interrupted and halted', async ({ context, extensionId }) => {
  test.setTimeout(60_000);   // reconcileRuns()'s own LIST_RUNS call retries offscreen readiness for up to 15s

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await grant(popup, ORIGIN);

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/basic-form.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/basic-form.html`);
  const handle = await resolveHandle(popup, tabId, { role: 'textbox', nameIncludes: 'Full name' });

  // Seed a real, non-terminal run row exactly like AGENT_BENCH_ACT's other
  // e2e specs — see its own message comment for why it starts 'running'
  // with no Supervisor of its own.
  const acted: any = await benchAct(popup, tabId, { verb: 'type', handle, text: 'mid-run', mode: 'replace' });
  expect(acted.data.phase, JSON.stringify(acted)).toBe('done');
  const runId = acted.data.runId as number;

  const before = ((await agentListRuns(popup)) as any).data.find((r: any) => r.id === runId);
  expect(before?.state).toBe('running');

  const reconcileRes: any = await benchReconcile(popup);
  expect(reconcileRes.status, JSON.stringify(reconcileRes)).toBe('success');

  const after = ((await agentListRuns(popup)) as any).data.find((r: any) => r.id === runId);
  expect(after?.state).toBe('halted');

  const events = (await agentRunEvents(popup, runId) as any).data;
  const interrupted = events.find((e: any) => e.kind === 'run.interrupted');
  expect(interrupted, JSON.stringify(events.map((e: any) => e.kind))).toBeDefined();
  expect(interrupted.data).toMatchObject({ atState: 'running', reason: 'AGENT_RUNTIME_LOST' });

  // Not resumed, and a second reconcile pass is a no-op on an
  // already-terminal run (lib/agent/reconcile.ts's own guard).
  await benchReconcile(popup);
  const stillHalted = ((await agentListRuns(popup)) as any).data.find((r: any) => r.id === runId);
  expect(stillHalted?.state).toBe('halted');
  expect((await agentRunEvents(popup, runId) as any).data.filter((e: any) => e.kind === 'run.interrupted')).toHaveLength(1);
});

test('a terminal run is left untouched by reconcileRuns()', async ({ context, extensionId }) => {
  test.setTimeout(30_000);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await grant(popup, ORIGIN);

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/basic-form.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/basic-form.html`);
  const handle = await resolveHandle(popup, tabId, { role: 'textbox', nameIncludes: 'Full name' });

  const acted: any = await benchAct(popup, tabId, { verb: 'type', handle, text: 'seed', mode: 'replace' });
  const runId = acted.data.runId as number;

  await popup.evaluate(async ({ runId }: any) => {
    return chrome.runtime.sendMessage({ type: 'AGENT_STOP', payload: { runId } });
  }, { runId });

  const stopped = ((await agentListRuns(popup)) as any).data.find((r: any) => r.id === runId);
  expect(stopped?.state).toBe('stopped');

  await benchReconcile(popup);

  const stillStopped = ((await agentListRuns(popup)) as any).data.find((r: any) => r.id === runId);
  expect(stillStopped?.state).toBe('stopped');
  expect((await agentRunEvents(popup, runId) as any).data.some((e: any) => e.kind === 'run.interrupted')).toBe(false);
});
