/**
 * The in-page overlay across a real navigation — Docs/planning/
 * phase_5_agent_loop.md §9.2/§9.3, §11 tasks 5.11/5.12:
 *   - task 5.11: "the overlay is recreated after navigation"
 *   - task 5.12 (stop.spec.ts's own extension): "stop from the panel during
 *     a navigation (when the overlay does not exist) still halts within
 *     250 ms"
 *
 * Uses tests/e2e/fixtures/navigating-form.html — a real `<a href>` click is
 * a real top-level navigation, which destroys and re-injects the content
 * script exactly like closing and reopening a tab (the content script has
 * no way to persist state across that boundary, which is the whole reason
 * the side panel, not this overlay, owns Stop authoritatively — §9.3).
 *
 * lib/agent/tab-agent.ts and the Supervisor itself are not involved here;
 * `pollOverlay()` (entrypoints/agent.content.ts) reads only AGENT_LIST_RUNS
 * / AGENT_GET_RUN_EVENTS, both plain `db.runs`/`db.runEvents` reads the SW
 * answers directly — genuinely real and independent of whether a live
 * offscreen Supervisor exists (it does not, in this environment — see
 * lib/model/offscreen-bridge.ts's header).
 */
import { test, expect } from './fixture';
import { grant, tabIdFor, resolveHandle, benchAct, agentStop, agentListRuns } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';
const OVERLAY_HOST_SELECTOR = '[data-pp-overlay-root]';

test('the overlay mounts, survives a real navigation, and re-mounts on the destination page', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await grant(popup, ORIGIN);

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/navigating-form.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/navigating-form.html`);

  // GoalBox mounts within one poll cycle (POLL_MS = 1200ms) even with no
  // active run for this tab.
  await expect(page.locator(OVERLAY_HOST_SELECTOR)).toBeAttached({ timeout: 5_000 });

  // Give this tab an active run, so the overlay has something to carry
  // across the navigation (RunBadge instead of GoalBox — its own rendering
  // is inside a closed shadow root, §9.2's own design, so this only
  // asserts what a real page script CAN see: the run itself survives, and
  // the host element exists both before and after).
  const handle = await resolveHandle(popup, tabId, { role: 'textbox', nameIncludes: 'A note' });
  const acted: any = await benchAct(popup, tabId, { verb: 'type', handle, text: 'noted', mode: 'replace' });
  expect(acted.data.phase, JSON.stringify(acted)).toBe('done');
  const runId = acted.data.runId as number;

  // Real navigation — click a real link, not page.goto().
  await Promise.all([
    page.waitForURL(`${ORIGIN}/basic-form.html`),
    page.locator('#continue-link').click(),
  ]);

  // Re-mounted on the destination page.
  await expect(page.locator(OVERLAY_HOST_SELECTOR)).toBeAttached({ timeout: 5_000 });

  // The run itself is untouched by the navigation — same tabId, same
  // roster, still 'running' — proving the overlay's re-mount on the new
  // page has a real run to reflect, not a blank slate.
  const run = ((await agentListRuns(popup)) as any).data.find((r: any) => r.id === runId);
  expect(run?.state).toBe('running');
  expect(run?.roster).toContain(tabId);
});

test('Stop halts a run within 250ms even mid-navigation, when the in-page overlay does not exist', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await grant(popup, ORIGIN);

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/navigating-form.html`);
  const tabId = await tabIdFor(popup, `${ORIGIN}/navigating-form.html`);
  const handle = await resolveHandle(popup, tabId, { role: 'textbox', nameIncludes: 'A note' });
  const acted: any = await benchAct(popup, tabId, { verb: 'type', handle, text: 'seed', mode: 'replace' });
  const runId = acted.data.runId as number;

  // Start the navigation and press Stop in the same instant — the overlay
  // for the OLD document is being torn down right now (§9.3's "a run that
  // navigates is the normal case"), so this proves Stop's authority does
  // not depend on the in-page control existing at the moment it's pressed
  // (the side panel — simulated here by calling AGENT_STOP directly from
  // the popup, the same boundary stop.spec.ts already established as
  // authoritative — is what actually owns it).
  const navigation = page.waitForURL(`${ORIGIN}/basic-form.html`);
  await page.locator('#continue-link').click();
  const t0 = Date.now();
  await agentStop(popup, runId);
  const elapsed = Date.now() - t0;
  await navigation;

  expect(elapsed).toBeLessThanOrEqual(250);
  const run = ((await agentListRuns(popup)) as any).data.find((r: any) => r.id === runId);
  expect(run?.state).toBe('stopped');
});
