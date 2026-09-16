/**
 * §10 Performance Validation — "Recovery success rate, WRITE_REJECTED —
 * recovery.bench.ts over 20 React/masked/rejecting fixtures. Recorded.
 * This is the number that justifies Phase 9's CDP backend."
 * Docs/planning/phase_6_recovery_journal_reporting.md §10, task 6.16.
 *
 * [Placement] The doc's §11 file list puts this at tests/bench/recovery.bench.ts,
 * a directory playwright.config.ts's testDir does not scan (only
 * ./tests/e2e is globbed, testMatch: *.{spec,bench}.ts) — every other
 * Playwright-run benchmark this repo has (gate-wake.bench.ts,
 * action-verify.bench.ts, §15) already lives under tests/e2e/ for exactly
 * that reason. Placed there for consistency with the working infrastructure
 * rather than adding a second scanned directory for one file; recorded here
 * as a deliberate, disclosed deviation from the doc's literal path, not a
 * missed requirement.
 *
 * Driven via AGENT_BENCH_TAB_STEP — a real TabAgent.executeStep(), the one
 * call that runs a failing write through the FULL local recovery loop
 * (lib/agent/tab-agent.ts's attempt -> recoverIfNeeded -> recoverFrom:
 * WRITE_REJECTED's focus-then-retype adaptation, §3.3) against a real
 * fixture page — never AGENT_BENCH_ACT, which calls domBackend.act()+verify()
 * directly and never reaches lib/agent/recovery.ts at all (see that
 * message's own comment). No live planner is needed: the recovery loop
 * lives entirely inside the Tab Agent (§3.1).
 *
 * Three templates, repeated to reach 20 samples — the exact "few templates,
 * replayed" shape action-verify.bench.ts already established, reusing
 * fixtures already proven correct elsewhere rather than inventing new
 * untested ones:
 *  - react-form.html (actuation.spec.ts) — a well-behaved controlled input.
 *    No recovery should ever fire; this is the "recovery does not cry wolf"
 *    control the raw recovered-count needs to be read against.
 *  - masked-phone.html — a real input-mask formatter. WRITE_REJECTED fires,
 *    then recovers (the loosely-equal 'accept' path, never a wasted third
 *    real write — lib/agent/recovery.ts's `accept` arm).
 *  - rejecting-input.html — a field that discards every write. WRITE_REJECTED
 *    fires, the adaptation ALSO fails, and the step correctly ends in
 *    `ask_user` (recovery exhausted, §3.3's third acceptance criterion) —
 *    this is not a bench failure, it is the recovery table doing exactly
 *    what an unrecoverable field must produce.
 */
import { test, expect } from './fixture';
import { grant, tabIdFor, resolveHandle, benchStep } from './agent-helpers';

const ORIGIN = 'http://localhost:5599';
const TOTAL_SAMPLES = 20;

type Template = {
  path: string;
  find: { nameIncludes: string };
  text: string;
  expect: 'confirmed_direct' | 'confirmed_recovered' | 'ask_exhausted';
};

const TEMPLATES: Template[] = [
  { path: 'react-form.html', find: { nameIncludes: 'Full name' }, text: 'Mohd Taha', expect: 'confirmed_direct' },
  { path: 'masked-phone.html', find: { nameIncludes: 'Phone number' }, text: '07700900123', expect: 'confirmed_recovered' },
  { path: 'rejecting-input.html', find: { nameIncludes: 'Reference code' }, text: 'REF-42', expect: 'ask_exhausted' },
];

test('WRITE_REJECTED recovery over 20 React/masked/rejecting samples', async ({ context, extensionId }) => {
  test.setTimeout(120_000);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  expect((await grant(popup, ORIGIN)).status).toBe('success');

  const page = await context.newPage();
  const outcomes: string[] = [];
  let recovered = 0;
  let confirmedDirect = 0;
  let exhausted = 0;

  for (let i = 0; i < TOTAL_SAMPLES; i++) {
    const tmpl = TEMPLATES[i % TEMPLATES.length];
    // eslint-disable-next-line no-await-in-loop
    await page.goto(`${ORIGIN}/${tmpl.path}`);
    // eslint-disable-next-line no-await-in-loop
    const tabId = await tabIdFor(popup, `${ORIGIN}/${tmpl.path}`);
    // eslint-disable-next-line no-await-in-loop
    const handle = await resolveHandle(popup, tabId, tmpl.find);

    // targetHint is what lib/agent/step-resolver.ts's step 1 (deterministic
    // exact match) needs to skip straight to the resolved handle — omitting
    // it sends every page with more than one actionable element to the
    // judge tier instead (step 3), which needs a live offscreen document
    // this sandbox's does not reliably have (see tests/e2e/fixture.ts).
    // None of these three fixtures' single field is what this bench times.
    const step = {
      n: 1, intent: `fill ${tmpl.find.nameIncludes}`,
      action: { verb: 'type', handle, text: tmpl.text, mode: 'replace' },
      expectation: `${tmpl.find.nameIncludes} shows the typed value`,
      targetHint: { role: 'textbox', name: tmpl.find.nameIncludes },
    };
    // eslint-disable-next-line no-await-in-loop
    const res: any = await benchStep(popup, tabId, step);
    expect(res.status, JSON.stringify(res)).toBe('success');
    const outcome = res.data.outcome;
    outcomes.push(`${tmpl.path}:${outcome.kind}${outcome.result ? `/${outcome.result.verified}` : ''}`);

    if (tmpl.expect === 'confirmed_direct') {
      expect(outcome.kind, JSON.stringify(outcome)).toBe('done');
      expect(outcome.result.verified).toBe('confirmed');
      confirmedDirect++;
    } else if (tmpl.expect === 'confirmed_recovered') {
      expect(outcome.kind, JSON.stringify(outcome)).toBe('done');
      expect(outcome.result.verified).toBe('confirmed');
      expect(outcome.result.evidence?.detail).toBe('recovered on the second attempt');
      recovered++;
    } else {
      expect(outcome.kind, JSON.stringify(outcome)).toBe('ask_user');
      expect(outcome.question).toContain(tmpl.text);   // both values quoted, §3.3
      exhausted++;
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[bench] WRITE_REJECTED recovery — n=${TOTAL_SAMPLES} confirmedDirect=${confirmedDirect} recovered=${recovered} exhausted(ask)=${exhausted}`);
  // eslint-disable-next-line no-console
  console.log(`[bench] outcomes: ${outcomes.join(', ')}`);

  // The recoverable template (masked-phone.html) must recover every time —
  // it is deterministic, not a coin flip; the number worth recording for
  // Phase 9's CDP-backend justification is how a REAL rejecting field
  // (rejecting-input.html) behaves, which is "always asks", by design.
  const sampleIndices = Array.from({ length: TOTAL_SAMPLES }, (_, i) => i % TEMPLATES.length);
  const countOf = (expect_: Template['expect']) =>
    sampleIndices.filter((idx) => TEMPLATES[idx].expect === expect_).length;
  expect(recovered).toBe(countOf('confirmed_recovered'));
  expect(confirmedDirect).toBe(countOf('confirmed_direct'));
  expect(exhausted).toBe(countOf('ask_exhausted'));
});
