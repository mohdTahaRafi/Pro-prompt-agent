/**
 * Take-over and Pause — Docs/planning/phase_5_agent_loop.md §9.4, §11 task
 * 5.13: "Pause refuses every action with RUN_STATE; Take over does the same
 * and shows the driving banner; Resume re-snapshots before the next step,
 * and the journal shows the epoch advancing."
 *
 * SCOPE NOTE (2026-09-13 acceptance audit): this environment's
 * `chrome.offscreen.createDocument()` does not execute the offscreen
 * document's script at all — verified directly (storage writes from its
 * own module top-level never happen; the identical script runs perfectly
 * the instant it is loaded as an ordinary page instead) — see
 * lib/model/offscreen-bridge.ts's header and tests/e2e/fixture.ts's. Every
 * real run lives there, so AGENT_PAUSE/AGENT_TAKE_OVER/AGENT_RESUME (which
 * only ever reach a Supervisor through that document) cannot be driven
 * end-to-end here; that full round trip — the driving banner, and Resume's
 * re-snapshot-before-next-step — is covered at the unit level instead
 * (tests/unit/pause-takeover-askuser.spec.ts), against a real Supervisor,
 * just not a real browser.
 *
 * What THIS file proves for real, in real Chrome: the actual security
 * property both Pause and Take-over exist for — lib/policy/gate.ts's check
 * 7 (`canAct(run.state)`, lib/agent/run-state.ts) refuses every action
 * once `run.state` leaves `'running'`, and permits them again once it
 * returns — using AGENT_BENCH_SET_STATE (e2e-only) to reach the exact same
 * `run.state` field AGENT_PAUSE/AGENT_TAKE_OVER/AGENT_RESUME would have
 * written in production, without needing a live Supervisor to write it.
 */
import { test, expect } from './fixture';
import { grant, tabIdFor, resolveHandle, benchAct, benchSetState } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';

async function runIdForTab(popup: any, tabId: number): Promise<number> {
  return popup.evaluate(async (tId: number) => {
    const runs: any = await chrome.runtime.sendMessage({ type: 'AGENT_LIST_RUNS' });
    return runs.data.find((r: any) => r.roster[0] === tId)?.id;
  }, tabId);
}

test('Take over refuses every action with RUN_STATE, and lifting it (Resume) permits them again', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await grant(popup, ORIGIN);

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/basic-form.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/basic-form.html`);

  const handle = await resolveHandle(popup, tabId, { role: 'textbox', nameIncludes: 'Full name' });

  // Establish the run and confirm the action is normally permitted.
  const before: any = await benchAct(popup, tabId, { verb: 'type', handle, text: 'before take-over', mode: 'replace' });
  expect(before.data.phase, JSON.stringify(before)).toBe('done');
  const runId = await runIdForTab(popup, tabId);
  expect(runId).toBeDefined();

  // Take over — the gate must refuse the SAME action it just permitted.
  const setTakenOver = await benchSetState(popup, runId, 'taken_over');
  expect((setTakenOver as any).status).toBe('success');

  const duringTakeOver: any = await benchAct(popup, tabId, { verb: 'type', handle, text: 'during take-over', mode: 'replace' });
  expect(duringTakeOver.data.phase, JSON.stringify(duringTakeOver)).toBe('refused');
  expect(duringTakeOver.data.code).toBe('RUN_STATE');

  // The page itself must be untouched by the refused attempt.
  const valueDuring = await page.locator('#full-name').inputValue();
  expect(valueDuring).toBe('before take-over');

  // Resume (a real Resume re-snapshots before the next step — §9.4 — which
  // needs a live Supervisor and is unit-tested, not asserted here) —
  // lifting taken_over back to running is the part the gate itself cares
  // about, and permits the action again.
  const setResumed = await benchSetState(popup, runId, 'running');
  expect((setResumed as any).status).toBe('success');

  // Handles are per-epoch (§6, goal-anchor.ts's own header) and several
  // perceives have happened since `handle` was minted (each benchAct/gate
  // check takes its own fresh snapshot) — re-resolve rather than assume
  // the original string is still current, same as production's own
  // step-resolver would on a stale epoch.
  const freshHandle = await resolveHandle(popup, tabId, { role: 'textbox', nameIncludes: 'Full name' });
  const afterResume: any = await benchAct(popup, tabId, { verb: 'type', handle: freshHandle, text: 'after resume', mode: 'replace' });
  expect(afterResume.data.phase, JSON.stringify(afterResume)).toBe('done');
  expect(await page.locator('#full-name').inputValue()).toBe('after resume');
});

test('Pause refuses every action with RUN_STATE, identically to Take over', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await grant(popup, ORIGIN);

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/basic-form.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/basic-form.html`);
  const handle = await resolveHandle(popup, tabId, { role: 'textbox', nameIncludes: 'Full name' });

  await benchAct(popup, tabId, { verb: 'type', handle, text: 'seed', mode: 'replace' });
  const runId = await runIdForTab(popup, tabId);

  await benchSetState(popup, runId, 'paused');
  const duringPause: any = await benchAct(popup, tabId, { verb: 'type', handle, text: 'during pause', mode: 'replace' });
  expect(duringPause.data.phase, JSON.stringify(duringPause)).toBe('refused');
  expect(duringPause.data.code).toBe('RUN_STATE');
  expect(await page.locator('#full-name').inputValue()).toBe('seed');
});
