/**
 * §15 performance validation — "Cold SW wake → gate decision: terminate
 * the worker, then time a gate call, 30 samples, ≤ 300ms p95."
 * Docs/planning/phase_3_gate_actuation_verification.md §15, task 3.17.
 *
 * Isolates the gate from perception: AGENT_ACT always perceives the page
 * before it resolves an instruction or calls gate() (entrypoints/
 * background.ts's runAgentAct), which would fold Phase 2's DOM-scan
 * budget into this number. AGENT_BENCH_GATE (e2e build only — see
 * wxt.config.ts's __PP_E2E__ comment) calls gate() directly against a
 * `read_page` request, the one implemented verb with no handle, so it
 * exercises every real gate check (run identity, tab identity, origin
 * scope, tier classification, run state, stop flag) without needing a
 * pre-seeded ownership ledger.
 */
import { test, expect } from './fixture';
import { grant, tabIdFor, agentBenchGate } from './agent-helpers';
import { terminateServiceWorker } from './sw-control';

const ORIGIN = 'http://localhost:5599';
const SAMPLES = 30;
const TARGET_P95_MS = 300;

test('cold SW wake → gate decision is ≤ 300ms at the p95 over 30 samples', async ({ context, extensionId }) => {
  test.setTimeout(60_000);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  expect((await grant(popup, ORIGIN)).status).toBe('success');

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/basic-form.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/basic-form.html`);

  // Warm-up call, NOT counted: creates the run (a real IndexedDB write) so
  // every timed sample below hits an already-existing run, matching what
  // "cold SW wake" means in production — a run resuming after the worker
  // idled out, not a run being created for the first time.
  const warmup: any = await agentBenchGate(popup, tabId);
  expect(warmup.status).toBe('success');
  expect(warmup.data.decision.permitted).toBe(true);

  const times: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    // eslint-disable-next-line no-await-in-loop
    await terminateServiceWorker(context, popup, extensionId);

    const t0 = performance.now();
    // eslint-disable-next-line no-await-in-loop
    const res: any = await agentBenchGate(popup, tabId);
    times.push(performance.now() - t0);

    expect(res.status).toBe('success');
    expect(res.data.decision.permitted).toBe(true);
  }

  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;

  // eslint-disable-next-line no-console
  console.log(
    `[bench] cold SW wake → gate decision — n=${times.length} ` +
    `min=${times[0].toFixed(1)}ms mean=${mean.toFixed(1)}ms ` +
    `p50=${times[Math.floor(times.length * 0.5)].toFixed(1)}ms ` +
    `p95=${p95.toFixed(1)}ms max=${times[times.length - 1].toFixed(1)}ms`,
  );

  expect(p95).toBeLessThanOrEqual(TARGET_P95_MS);
});
