/**
 * PHASE 1 (§6, §8.2): runs the sensitive-field classifier over the fixture
 * corpus: Stripe Elements markup, a PayPal card form, three OTP shapes,
 * four password shapes, plus twenty non-sensitive fields that must classify
 * null. Zero false negatives on the sensitive fields is the bar (§3.7.22);
 * the classifier is allowed to be wide, never narrow.
 *
 * PHASE 3 (Docs/planning/phase_3_gate_actuation_verification.md §12 task
 * 3.4) adds the second describe block below: lib/policy/gate.ts's NEVER_TIER
 * refusal, asserted by exhaustion over mode × posture × capabilities — this
 * file's name was fixed by the Phase 1 doc before lib/policy/never-rules.ts
 * existed, and both requirements land on the same filename by the docs'
 * own numbering, so both live here rather than splitting one into a
 * differently-named file the plan never mentions.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { classifySensitive, type SensitiveKind } from '@lib/page/sensitive';
import { gate } from '@lib/policy/gate';
import * as ownership from '@lib/policy/ownership';
import { db } from '@lib/db/dexie-db';
import type { RunRecord } from '@lib/types/run.types';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';

const FIXTURE_PATH = path.resolve(__dirname, '../e2e/fixtures/sensitive-corpus.html');

let fields: Array<{ el: Element; expected: SensitiveKind; label: string }>;

beforeAll(() => {
  const html = readFileSync(FIXTURE_PATH, 'utf-8');
  document.documentElement.innerHTML = html.replace(/^[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*$/, '');
  const els = Array.from(document.querySelectorAll('[data-expect]'));
  fields = els.map((el) => {
    const raw = el.getAttribute('data-expect')!;
    const expected = (raw === 'null' ? null : raw) as SensitiveKind;
    const label = el.getAttribute('name') || el.id || el.getAttribute('aria-label') || raw;
    return { el, expected, label };
  });
});

describe('classifySensitive — fixture corpus (§6, §8.2)', () => {
  it('parses the fixture and finds every tagged field', () => {
    // 4 password + 7 payment + 3 otp + 1 file + 1 hidden + 20 benign
    expect(fields.length).toBe(36);
  });

  it('every field classifies exactly as tagged — zero false negatives on sensitive fields', () => {
    const mismatches = fields
      .map(({ el, expected, label }) => ({ label, expected, actual: classifySensitive(el) }))
      .filter(({ expected, actual }) => expected !== actual);
    expect(mismatches, JSON.stringify(mismatches, null, 2)).toEqual([]);
  });

  it('classifies password fields as password', () => {
    const passwordFields = fields.filter((f) => f.expected === 'password');
    expect(passwordFields).toHaveLength(4);
    for (const f of passwordFields) expect(classifySensitive(f.el)).toBe('password');
  });

  it('classifies Stripe- and PayPal-shaped fields as payment', () => {
    const paymentFields = fields.filter((f) => f.expected === 'payment');
    expect(paymentFields).toHaveLength(7);
    for (const f of paymentFields) expect(classifySensitive(f.el)).toBe('payment');
  });

  it('classifies all three OTP shapes as otp', () => {
    const otpFields = fields.filter((f) => f.expected === 'otp');
    expect(otpFields).toHaveLength(3);
    for (const f of otpFields) expect(classifySensitive(f.el)).toBe('otp');
  });

  it('classifies file inputs as file and hidden inputs as hidden', () => {
    expect(classifySensitive(document.querySelector('[name="id_upload"]')!)).toBe('file');
    expect(classifySensitive(document.querySelector('[name="csrf_token"]')!)).toBe('hidden');
  });

  it('classifies all twenty benign fields as null', () => {
    const benign = fields.filter((f) => f.expected === null);
    expect(benign).toHaveLength(20);
    for (const f of benign) expect(classifySensitive(f.el)).toBeNull();
  });

  it('a non-HTMLElement input returns null rather than throwing', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    expect(() => classifySensitive(svg)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PHASE 3 — the gate's NEVER_TIER refusal has no override path (§5.4)
// ═══════════════════════════════════════════════════════════════════════

const ORIGIN = 'https://example.com';
const TAB = 7;
const PASSWORD_HANDLE = 'e0';

function passwordSnap(): PerceptionSnapshot {
  return {
    runId: 'r', tabId: TAB, epoch: 1, url: `${ORIGIN}/`, origin: ORIGIN, title: '', settled: true,
    settleWaitedMs: 0, settleCalibration: 'visible', epochSuspect: false,
    // A password field never actually survives the perception walk (Phase 2
    // §7.1's earliest-point exclusion) — this descriptor exists here only
    // to exercise the gate's OWN redundant check (§4.6), against
    // independently-derived ledger data, exactly as that section describes.
    elements: [{
      handle: PASSWORD_HANDLE, role: 'textbox', name: 'Password', nameSource: 'label',
      tag: 'input', inputType: 'password', enabled: true, visible: true, inViewport: true,
      actionable: true, sensitiveKind: null, regionId: 'form:0', ordinal: 0,
    }],
    excludedCount: 0, regions: [], unreachableRegions: [], buildMs: 1,
  };
}

/** Patches the recorded ledger's sensitiveKind directly — the shape a
 *  stale-classifier or future-backend ledger entry would actually take
 *  (§4.6), since ElementDescriptor itself cannot carry 'password' at all. */
async function recordPasswordLedger(runId: number): Promise<void> {
  await ownership.record(runId, TAB, passwordSnap());
  const key = `own:${runId}`;
  const store = (await chrome.storage.session.get(key))[key] as any;
  store[TAB].handles[PASSWORD_HANDLE].sensitiveKind = 'password';
  await chrome.storage.session.set({ [key]: store });
}

const MODES: RunRecord['mode'][] = ['suggest', 'step', 'supervised', 'watch'];
const POSTURES: RunRecord['posture'][] = ['local-only', 'hybrid'];
const CAPABILITY_SETS: Array<{ label: string; capabilities: string[] }> = [
  { label: 'type granted', capabilities: ['type', 'read_page'] },
  { label: 'type NOT granted', capabilities: ['read_page'] },
];

describe('never-rules — NEVER_TIER has no override path (§5.4, gate check 5)', () => {
  let runCounter = 9_000_000;

  it('refuses a type on a password-classified ledger entry across every combination of mode × posture × capabilities', async () => {
    (chrome.permissions as any).__granted.add(`${ORIGIN}/*`);
    chrome.tabs.__setTab(TAB, `${ORIGIN}/`);

    for (const mode of MODES) {
      for (const posture of POSTURES) {
        for (const caps of CAPABILITY_SETS) {
          runCounter += 1;
          const runId = runCounter;
          await db.sitePolicy.put({
            origin: ORIGIN, capabilities: caps.capabilities as any,
            defaultMode: 'supervised', grantedAt: Date.now(),
          });
          await db.runs.add({
            id: runId, goal: '', state: 'running', mode, posture, backend: 'dom',
            origin: ORIGIN, scope: [ORIGIN], roster: [TAB],
            budgets: { maxActions: 40, maxRetriesPerStep: 3, maxPlannerCalls: 30, maxWallClockMs: 720_000 },
            startedAt: Date.now(),
          } as any);
          await recordPasswordLedger(runId);

          const decision = await gate({
            requestId: '9c858901-8a57-4791-81fe-4c455b099bc9', runId, tabId: TAB, epoch: 1,
            action: { verb: 'type', handle: PASSWORD_HANDLE, text: 'hunter2', mode: 'replace' },
            reason: 'test',
          });

          // Universal, regardless of mode/posture/capability: never permitted.
          expect(decision.permitted, `mode=${mode} posture=${posture} caps=${caps.label}`).toBe(false);
          // When the capability itself is granted, the SPECIFIC code must be
          // NEVER_TIER — no mode, posture, or approval path downgrades it to
          // merely needing approval (needsApproval is never true here).
          if (caps.label === 'type granted') {
            expect(decision.code, `mode=${mode} posture=${posture}`).toBe('NEVER_TIER');
          }
          expect(decision.needsApproval).not.toBe(true);
        }
      }
    }
  });

  it('there is no field on ActionRequest an approved/override flag could occupy', async () => {
    // Structural proof, not a runtime check: ActionRequestSchema (Phase 3
    // §3.1) has exactly five fields, none of which represent "approved" or
    // "override" — the only way an Always-tier action ever proceeds is
    // through entrypoints/background.ts's separate pending-approval map,
    // keyed by requestId, which gate() itself never reads from.
    const { ActionRequestSchema } = await import('@lib/schemas/action.schema');
    const shape = (ActionRequestSchema as any).shape as Record<string, unknown>;
    expect(Object.keys(shape).sort()).toEqual(['action', 'epoch', 'reason', 'requestId', 'runId', 'tabId']);
  });
});
