/**
 * §15/§13 performance validation — "Action → verified outcome, deterministic
 * path: ≤ 1.5s at the p95." Docs/planning/phase_3_gate_actuation_verification.md
 * §15, task 3.17; Docs/planning/phase_5_agent_loop.md §13 (same metric, same
 * target, carried forward unchanged by this phase).
 *
 * [Phase 5 §16] Renamed from copilot.bench.ts and driven via
 * AGENT_BENCH_ACT (see agent-helpers.ts's header) now that the Copilot
 * panel and lib/agent/intent.ts are gone — the pipeline being timed
 * (gate -> dispatch -> settle+re-read -> verify -> journal) is otherwise
 * unchanged from Phase 3.
 *
 * Five action templates, each already proven correct by a dedicated
 * assertion elsewhere (actuation.spec.ts, scope.spec.ts) — this file
 * reuses the exact same fixtures rather than inventing new untested ones,
 * and replays each 8 times (5×8 = 40) to get a real distribution. Every
 * iteration reloads its fixture fresh, so each sample pays the same
 * pipeline with no cross-iteration state leakage (a repeat click on
 * modal-cover.html's already-dismissed banner would not be the same
 * action the first click was). Only the AGENT_BENCH_ACT round trip itself
 * is timed — page navigation and the target-handle lookup are excluded,
 * since neither is part of what "action → verified outcome" measures.
 *
 * slow-settle.html is deliberately excluded: it never settles
 * by construction (used by stop.spec.ts to buy time for a mid-flight
 * Stop), so it is not part of "the deterministic path"'s happy-population
 * — including it would benchmark the settle-timeout ceiling, not typical
 * action latency.
 */
import { test, expect } from './fixture';
import { grant, tabIdFor, resolveHandle, benchAct } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';
const TOTAL_ACTIONS = 40;
const TARGET_P95_MS = 1_500;

const TEMPLATES: Array<{ path: string; find: { role?: string; nameIncludes: string }; action: (handle: string) => unknown }> = [
  { path: 'basic-form.html', find: { nameIncludes: 'Full name' }, action: (h) => ({ verb: 'type', handle: h, text: 'x', mode: 'replace' }) },
  { path: 'react-form.html', find: { nameIncludes: 'Full name' }, action: (h) => ({ verb: 'type', handle: h, text: 'Mohd Taha', mode: 'replace' }) },
  { path: 'quill.html', find: { nameIncludes: 'Message' }, action: (h) => ({ verb: 'type', handle: h, text: 'Hello there', mode: 'replace' }) },
  { path: 'custom-button.html', find: { role: 'button', nameIncludes: 'Continue' }, action: (h) => ({ verb: 'click', handle: h }) },
  { path: 'modal-cover.html', find: { role: 'button', nameIncludes: 'Continue' }, action: (h) => ({ verb: 'click', handle: h }) },
];

test('action → verified outcome is ≤ 1.5s at the p95 over 40 fixture actions', async ({ context, extensionId }) => {
  test.setTimeout(90_000);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  expect((await grant(popup, ORIGIN)).status).toBe('success');

  const page = await context.newPage();

  const times: number[] = [];
  const outcomes: string[] = [];

  for (let i = 0; i < TOTAL_ACTIONS; i++) {
    const { path, find, action } = TEMPLATES[i % TEMPLATES.length];
    // eslint-disable-next-line no-await-in-loop
    await page.goto(`${ORIGIN}/${path}`);
    // eslint-disable-next-line no-await-in-loop
    const tabId = await tabIdFor(popup, `${ORIGIN}/${path}`);
    // eslint-disable-next-line no-await-in-loop
    const handle = await resolveHandle(popup, tabId, find);   // excluded from the timed window

    const t0 = performance.now();
    // eslint-disable-next-line no-await-in-loop
    const res: any = await benchAct(popup, tabId, action(handle));
    times.push(performance.now() - t0);

    expect(res.status).toBe('success');
    expect(['done', 'failed']).toContain(res.data.phase);   // a deterministic outcome either way — never a hang
    outcomes.push(`${path}:${res.data.phase}${res.data.verified ? `/${res.data.verified}` : ''}`);
  }

  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;

  // eslint-disable-next-line no-console
  console.log(
    `[bench] action → verified outcome — n=${times.length} ` +
    `min=${times[0].toFixed(1)}ms mean=${mean.toFixed(1)}ms ` +
    `p50=${times[Math.floor(times.length * 0.5)].toFixed(1)}ms ` +
    `p95=${p95.toFixed(1)}ms max=${times[times.length - 1].toFixed(1)}ms`,
  );
  // eslint-disable-next-line no-console
  console.log(`[bench] outcomes: ${outcomes.join(', ')}`);

  expect(p95).toBeLessThanOrEqual(TARGET_P95_MS);
});
