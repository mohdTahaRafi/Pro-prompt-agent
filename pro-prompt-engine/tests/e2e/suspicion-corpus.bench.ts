/**
 * Suspicion false-positive rate — Docs/planning/phase_6_recovery_journal_reporting.md
 * §10: "Suspicion false-positive rate | suspicion.spec.ts over 30 clean real
 * captures | 0 halts. A detector that halts clean pages will be switched
 * off by users."
 *
 * tests/unit/suspicion.spec.ts already proves this over 10 SYNTHETIC
 * ElementDescriptor arrays (§10's own name for that file). This is the
 * real-browser half: the same lib/policy/suspicion.ts scan(), run through
 * its actual live caller — lib/agent/tab-agent.ts's ensureSnapshot(), the
 * exact choke point tests/e2e/site-refused.spec.ts's own header documents —
 * via AGENT_BENCH_TAB_PERCEIVE against every ordinary (non-refusal,
 * non-auth, non-sensitive-corpus) fixture this suite already has. No live
 * planner needed: detection happens on the perceive alone, before any step
 * is resolved (site-refused.spec.ts's header explains why a bench-level
 * single perceive call is the real mechanism, not a stand-in for it).
 *
 * captcha.html/rate-limited.html are SITE_REFUSED fixtures (site-refused.spec.ts
 * already covers them) and out of scope here — a correct refusal is not a
 * false positive to count. login-redirect.html and sensitive-corpus.html are
 * excluded on purpose too: both deliberately present excluded/password-
 * classified content on the very FIRST perceive of a fresh run, which
 * suspicion.ts's own credential_request signal is designed to allow ("the
 * user started on a login page" — §5's table) — correctly not halting, but
 * not what this corpus is trying to measure (an ORDINARY page never
 * halting), so counting them would prove a different, already-covered
 * claim under this one's heading.
 */
import { test, expect } from './fixture';
import { grant, tabIdFor, benchPerceive } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';

const CLEAN_FIXTURES = [
  'application-form.html', 'basic-form.html', 'cookie-banner.html',
  'custom-button.html', 'duplicate-buttons.html', 'error-banner-submit.html',
  'index.html', 'long-form.html', 'masked-phone.html', 'modal-cover.html',
  'nested.html', 'polling.html', 'product-grid.html', 'quill.html',
  'react-form.html', 'slow-settle.html', 'swallowed-submit.html',
  'collapsed-specs.html',
  'settings-menu/index.html', 'settings-menu/account.html', 'settings-menu/display.html',
  'settings-menu/notifications.html', 'settings-menu/notifications-push.html',
  'settings-menu/notifications-email.html',
];

test(`suspicion.scan() never halts on ${CLEAN_FIXTURES.length} ordinary real fixtures`, async ({ context, extensionId }) => {
  test.setTimeout(90_000);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  expect((await grant(popup, ORIGIN)).status).toBe('success');

  const halted: string[] = [];
  const page = await context.newPage();
  for (const fixture of CLEAN_FIXTURES) {
    // eslint-disable-next-line no-await-in-loop
    await page.goto(`${ORIGIN}/${fixture}`);
    // eslint-disable-next-line no-await-in-loop
    const tabId = await tabIdFor(popup, `${ORIGIN}/${fixture}`);
    // eslint-disable-next-line no-await-in-loop
    const res: any = await benchPerceive(popup, tabId);
    expect(res.status, `${fixture}: ${JSON.stringify(res)}`).toBe('success');
    if (!res.data.result.ok && res.data.result.error?.kind === 'suspicion') {
      halted.push(`${fixture}: ${JSON.stringify(res.data.result.error.hits)}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[suspicion corpus] ${CLEAN_FIXTURES.length} real captures, ${halted.length} false positives`);
  expect(halted, halted.join('\n')).toEqual([]);
});
