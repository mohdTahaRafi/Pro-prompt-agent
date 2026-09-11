/**
 * The Copilot panel itself (entrypoints/options/App.tsx's CopilotView) —
 * task 3.14's acceptance criteria, driven through the real UI rather than
 * the raw AGENT_* messages tests/e2e/actuation.spec.ts and friends use.
 * Docs/planning/phase_3_gate_actuation_verification.md §11, §12 task 3.14.
 *
 * Each scenario opens its own fresh options page and fresh fixture page —
 * simpler and more robust than reusing one options page across scenarios,
 * which would need extra machinery to force its origin/tab dropdown to
 * re-resolve a different tab for the same already-selected origin string.
 */
import { test, expect } from './fixture';
import { grant } from './agent-helpers';
import type { BrowserContext, Page } from '@playwright/test';

const ORIGIN = 'http://localhost:5599';

async function openCopilot(context: BrowserContext, extensionId: string, fixturePath: string): Promise<{ options: Page; page: Page }> {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await grant(options, ORIGIN);

  const page = await context.newPage();
  await page.goto(`${ORIGIN}/${fixturePath}`);

  await options.getByRole('button', { name: /Copilot/ }).click();
  // [Phase 4] '#pp-copilot-origin-select', not the bare 'select' locator —
  // the Plan panel (§8.3) added a second <select> (posture) to this view.
  await options.locator('#pp-copilot-origin-select').selectOption(ORIGIN);
  await expect(options.getByText(/^tab \d+$/)).toBeVisible({ timeout: 5_000 });
  return { options, page };
}

test('click Continue executes and the panel shows the verified outcome', async ({ context, extensionId }) => {
  const { options } = await openCopilot(context, extensionId, 'custom-button.html');

  await options.getByPlaceholder(/click Continue/).fill('click Continue');
  await options.getByRole('button', { name: /Go/ }).click();

  // StatTile renders as <div class="card p-3">; scoped to that exact class
  // pair so this doesn't also match the enclosing result card.
  const verbTile = options.locator('div.card.p-3', { has: options.getByText('Verb', { exact: true }) });
  await expect(verbTile).toBeVisible({ timeout: 5_000 });
  await expect(verbTile).toContainText('click');

  const verifiedTile = options.locator('div.card.p-3', { has: options.getByText('Verified', { exact: true }) });
  await expect(verifiedTile).toBeVisible();
});

test('click Submit application holds for approval and names the target and the hostname', async ({ context, extensionId }) => {
  const { options } = await openCopilot(context, extensionId, 'swallowed-submit.html');

  await options.getByPlaceholder(/click Continue/).fill('click Submit application');
  await options.getByRole('button', { name: /Go/ }).click();

  await expect(options.getByText('Submit application', { exact: false }).first()).toBeVisible({ timeout: 5_000 });
  // ApprovalPrompt.site is new URL(origin).hostname — excludes the port.
  await expect(options.getByText(/^on localhost$/)).toBeVisible();
  await expect(options.getByRole('button', { name: /Reject/ })).toBeVisible();

  await options.getByRole('button', { name: /Reject/ }).click();
  await expect(options.getByText('Rejected', { exact: false })).toBeVisible();
});

test('two matching elements render a chooser, never a guess', async ({ context, extensionId }) => {
  const { options } = await openCopilot(context, extensionId, 'duplicate-buttons.html');

  await options.getByPlaceholder(/click Continue/).fill('click Delete');
  await options.getByRole('button', { name: /Go/ }).click();

  await expect(options.getByText('Which one did you mean?')).toBeVisible({ timeout: 5_000 });
});

test('unmatched text lists the available capabilities, never guesses', async ({ context, extensionId }) => {
  const { options } = await openCopilot(context, extensionId, 'basic-form.html');

  await options.getByPlaceholder(/click Continue/).fill('please make the form nicer');
  await options.getByRole('button', { name: /Go/ }).click();

  await expect(options.getByText('I understood that as an instruction', { exact: false })).toBeVisible({ timeout: 5_000 });
});
