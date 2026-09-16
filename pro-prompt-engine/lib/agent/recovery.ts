/**
 * Recovery table — FailureCause → RecoveryAction, §3.
 * Docs/planning/phase_6_recovery_journal_reporting.md §3.
 *
 * Cause interpretation is the whole of recovery: a uniform "something
 * failed, retry it" policy is the failure mode this table replaces
 * (PR-REC-2). Pure and synchronous — every DOM-touching or async step (the
 * one overlay-dismissal attempt, a settle wait, a fresh perceive, the
 * click-then-retype sequence) is CARRIED OUT by the caller
 * (lib/agent/tab-agent.ts), which then hands this function the OUTCOME as
 * part of `ctx` and asks what to do next. Nothing here imports `chrome.*`
 * or touches the DOM — recovery.spec.ts drives every row with a synthetic
 * context alone.
 *
 * Recovery happens INSIDE the Tab Agent and never reaches the Supervisor
 * unless local recovery is exhausted (§3.1) — that boundary is enforced by
 * the caller, not by this module, which only ever answers one question:
 * given this cause and this context, what next.
 */
import type { Action } from '@lib/schemas/action.schema';
import type { PlanStep } from '@lib/schemas/plan.schema';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import type { FailureCause, AskReason } from '@lib/types/agent.types';
import type { ReplanTrigger } from '@lib/agent/replan';
import { looselyEqual } from '@lib/page/verifier';

// ── §3.5 — SITE_REFUSED detection. A pure function over a snapshot, called
//    by lib/agent/tab-agent.ts BEFORE any action is resolved or dispatched
//    against it, so a refused page produces exactly one request, never a
//    detect-then-try-anyway race (tests/e2e/site-refused.spec.ts). ──

export interface RefusalSignal {
  kind: 'captcha' | 'rate_limit' | 'blocked' | 'repeated_identical_refusal';
  evidence: string;
}

const CAPTCHA_RE = /captcha|are you (a )?human|verify you.?re human/i;
const RATE_LIMIT_TITLE_RE = /\b429\b|too many requests|rate limit|slow down/i;
const RATE_LIMIT_ELEMENT_RE = /too many (requests|attempts)/i;
const BLOCKED_RE = /access denied|forbidden|blocked|unusual traffic|automated (traffic|queries)/i;

/** `identicalRefusals` is the caller's own count of consecutive identical
 *  refusals for the current step (a signal this function does not compute
 *  itself, since it has no notion of "the previous attempt" — only the
 *  current snapshot). Checked last: the first three signals are visible on
 *  ONE page read; this one only makes sense after several. */
export function detectSiteRefusal(snap: PerceptionSnapshot, identicalRefusals: number): RefusalSignal | null {
  if (CAPTCHA_RE.test(snap.title) || snap.elements.some((e) => CAPTCHA_RE.test(e.name))) {
    return { kind: 'captcha', evidence: 'a CAPTCHA / human-verification control is present on the page' };
  }
  if (RATE_LIMIT_TITLE_RE.test(snap.title) || snap.elements.some((e) => RATE_LIMIT_ELEMENT_RE.test(e.name))) {
    return { kind: 'rate_limit', evidence: snap.title || 'a rate-limit message is present on the page' };
  }
  if (BLOCKED_RE.test(snap.title)) {
    return { kind: 'blocked', evidence: snap.title };
  }
  if (identicalRefusals >= 3) {
    return { kind: 'repeated_identical_refusal', evidence: `the same action was refused ${identicalRefusals} times in a row` };
  }
  return null;
}

/** The subset of RunRecord['outcome'] a recovery-driven `end` can produce.
 *  Never 'completed' or 'stopped' — those are not failure outcomes. */
export type RecoveryEndOutcome = 'failed' | 'stuck' | 'completed_with_gaps';

export type RecoveryAction =
  | { kind: 'retry'; afterSettle: boolean }
  | { kind: 'adapt'; sequence: Action[] }              // pre-actions, then the original
  | { kind: 'replan'; trigger: ReplanTrigger }
  | { kind: 'ask'; reason: AskReason; question: string }
  // WRITE_REJECTED only — the adaptation's own read-back already matches
  // `intended` loosely (§3.3). The caller must NOT dispatch a third real
  // write: a deterministic reformatter (a masked/formatted input) would
  // reformat it identically forever, so redoing the write teaches nothing
  // new and only burns the retry envelope down to an `ask` the milestone
  // (§9) never asks. The verdict already in hand — the one that reported
  // this WRITE_REJECTED — IS the confirmation; `note` is what the report
  // shows for "confirmed (recovered on the second attempt)".
  | { kind: 'accept'; note: string }
  // PARTIAL_EFFECT only (§3.6) — a binary approve/deny of a RETRY, never an
  // auto-retry. Distinct from 'ask' because the answer is yes/no against a
  // specific consequence, not a free-form question to route through
  // ask_user's ADASK_USER verb and journal.
  | { kind: 'approve_retry'; question: string }
  | { kind: 'pause'; offer: 'takeover'; message: string }
  | { kind: 'end'; outcome: RecoveryEndOutcome; message: string };

export interface RecoveryContext {
  step: PlanStep;
  /** Attempts already made for THIS step, before the one that just failed.
   *  0 on the first failure. */
  retriesForStep: number;
  /** The target's handle, when the failing action carried one — needed for
   *  WRITE_REJECTED's focus-then-retype adaptation. */
  handle?: string;
  /** The target's accessible name, for question copy. Falls back to the
   *  step's own intent when absent. */
  targetName?: string;
  /** WRITE_REJECTED — what was typed, and what the read-back showed. */
  intended?: string;
  readBack?: string;
  /** OBSCURED — whether the ONE overlay-dismissal attempt (already made by
   *  the caller, lib/page/overlay-dismiss.ts, before recover() is ever
   *  called for this cause) succeeded. Always defined when cause is
   *  'OBSCURED'; recover() never attempts a second dismissal itself. */
  overlayDismissed?: boolean;
  /** SITE_REFUSED — which signal matched and the evidence to journal. */
  refusal?: { kind: string; evidence: string };
}

/** Causes whose retries count against the shared 3-attempt-per-step budget
 *  (PR-REC-3, RunBudgets.maxRetriesPerStep). TARGET_MISSING/TARGET_AMBIGUOUS
 *  never cost a retry (a plan problem, not an action problem — §3's table);
 *  AUTH_REQUIRED/SITE_REFUSED/PARTIAL_EFFECT/MODEL_OUTPUT_INVALID/STUCK/
 *  TAB_CLOSED/BACKEND_DETACHED never retry at all. */
const RETRY_COSTING = new Set<FailureCause>(['NOT_SETTLED', 'OBSCURED', 'WRITE_REJECTED', 'NAVIGATION_FAILED']);

export function recover(cause: FailureCause, ctx: RecoveryContext): RecoveryAction {
  // The bounded-retry envelope applies FIRST and applies to every
  // retry-costing cause (PR-REC-3, budget.maxRetriesPerStep = 3). Rows with
  // their OWN earlier limit (WRITE_REJECTED asks at attempt 2, OBSCURED
  // never retries past its one dismissal, NAVIGATION_FAILED asks after one
  // retry) return before this backstop is ever reached — it exists for
  // NOT_SETTLED, which has no cause-specific limit of its own.
  if (RETRY_COSTING.has(cause) && ctx.retriesForStep >= 3) {
    return {
      kind: 'ask', reason: 'AMBIGUOUS_TARGET',
      question: `I tried "${ctx.step.intent}" three times and it didn't take. ` +
        'Would you like to do this one yourself, or should I skip it?',
    };
  }

  const name = ctx.targetName ?? ctx.step.intent;

  switch (cause) {
    // ── NOT_SETTLED — settle timeout, or a read-back that disagreed with a
    //    second read 300ms later. Wait one more settle window, then retry
    //    the SAME action; never adapted, never asked without hitting the
    //    envelope above first. ──
    case 'NOT_SETTLED':
      return { kind: 'retry', afterSettle: true };

    // ── TARGET_MISSING — the handle no longer resolves. This is a plan
    //    problem, not an action problem: re-snapshot and replan (trigger 4),
    //    never a retry of the same request against a target that is gone. ──
    case 'TARGET_MISSING':
      return { kind: 'replan', trigger: 'target_unresolvable' };

    // ── TARGET_AMBIGUOUS — more than one node re-resolved. Stop and ask.
    //    Never guess which one. ──
    case 'TARGET_AMBIGUOUS':
      return { kind: 'ask', reason: 'AMBIGUOUS_TARGET', question: `Which "${name}" did you mean?` };

    // ── TARGET_DISABLED — not one of the doc's thirteen rows (it predates
    //    this phase, Phase 3 §6.3), but a real FailureCause the actuator can
    //    still produce, so it is answered here in the same spirit: stop and
    //    ask rather than retry a control that is disabled for a reason the
    //    agent cannot see. ──
    case 'TARGET_DISABLED':
      return { kind: 'ask', reason: 'MISSING_CAPABILITY', question: `"${name}" is disabled on the page right now. Should I skip it?` };

    // ── OBSCURED — dismiss if it matches a known banner shape, retry once;
    //    else ask. The dismissal itself already happened (§3.2, one
    //    attempt) before this is ever called for this occurrence — recover()
    //    only turns its result into the next step. ──
    case 'OBSCURED':
      return ctx.overlayDismissed
        ? { kind: 'retry', afterSettle: false }
        : {
            kind: 'ask', reason: 'MISSING_CAPABILITY',
            question: `Something is covering "${name}" and I couldn't clear it. Would you like to handle this one yourself?`,
          };

    // ── WRITE_REJECTED — the read-back after `type` didn't match. Attempt
    //    1: focus by clicking, then retype (the original probably wrote
    //    without ever landing focus). Attempt 2: the value may have been
    //    reformatted rather than rejected — looseEqual, checked ONLY here,
    //    never at first verification (§3.8). Otherwise ask, quoting both
    //    values. ──
    case 'WRITE_REJECTED': {
      if (ctx.retriesForStep === 0) {
        if (!ctx.handle) {
          // Defensive: WRITE_REJECTED is only ever produced for a `type`
          // action, which always carries a handle — but recover() never
          // trusts that from outside without a fallback.
          return { kind: 'ask', reason: 'MISSING_CAPABILITY', question: `I couldn't write to "${name}". Would you like to fill this one yourself?` };
        }
        const focusClick: Action = { verb: 'click', handle: ctx.handle };
        return { kind: 'adapt', sequence: [focusClick, ctx.step.action] };
      }
      if (ctx.retriesForStep === 1 && ctx.readBack !== undefined && ctx.intended !== undefined
        && looselyEqual(ctx.readBack, ctx.intended)) {
        return { kind: 'accept', note: 'recovered on the second attempt' };
      }
      return {
        kind: 'ask', reason: 'MISSING_CAPABILITY',
        question: `I typed "${ctx.intended ?? ''}" into "${name}" but the field shows "${ctx.readBack ?? ''}". ` +
          'The page may be rejecting typed input. Would you like to fill this one yourself?',
      };
    }

    // ── AUTH_REQUIRED — a login form appeared where content was expected.
    //    The agent never supplies credentials (it cannot — a password field
    //    has no handle). Pause and offer a take-over. ──
    case 'AUTH_REQUIRED':
      return {
        kind: 'pause', offer: 'takeover',
        message: "This site is asking you to sign in. I can't do that — I never touch password fields. "
          + "Sign in yourself and press Resume, and I'll pick up from a fresh read of the page.",
      };

    // ── SITE_REFUSED — bot challenge, rate limit, or a repeated identical
    //    refusal. Terminal, always. No retry, no delay-and-retry, no
    //    alternate path (PP-9). ──
    case 'SITE_REFUSED': {
      const kind = ctx.refusal?.kind ?? 'blocked';
      const action = kind === 'rate_limit' ? 'slow down' : 'complete a human-verification check';
      return {
        kind: 'end', outcome: 'failed',
        message: `I stopped because the site asked me to ${action}. I don't work around those. Nothing was changed on the site.`,
      };
    }

    // ── NAVIGATION_FAILED — the URL didn't change, or an error page loaded.
    //    One retry, then ask. ──
    case 'NAVIGATION_FAILED':
      if (ctx.retriesForStep === 0) return { kind: 'retry', afterSettle: true };
      return { kind: 'ask', reason: 'MISSING_CAPABILITY', question: `"${ctx.step.intent}" didn't go anywhere. Should I try something else, or skip it?` };

    // ── PARTIAL_EFFECT — a submit/send produced an error banner. The action
    //    may have partially taken effect. NEVER auto-retried — approval is
    //    required, and rejecting is the safe default (§3.6). ──
    case 'PARTIAL_EFFECT':
      return {
        kind: 'approve_retry',
        question: `I tried "${ctx.step.intent}" and the page showed an error. I don't know whether it partially `
          + 'took effect. Retrying could repeat it. Would you like me to retry, or stop here so you can check?',
      };

    // ── MODEL_OUTPUT_INVALID — the planner's one repair attempt (Phase 4
    //    §6.2) already ran and still failed. Terminal; the raw output is
    //    journaled by the caller, not here. ──
    case 'MODEL_OUTPUT_INVALID':
      return { kind: 'end', outcome: 'failed', message: "The plan I produced couldn't be understood, even after one repair attempt." };

    // ── STUCK — the same verb+handle+args three times with an identical
    //    outcome (lib/agent/budget.ts's noteOutcome already detects this).
    //    Distinct from 'failed': there was no error, just no progress. ──
    case 'STUCK':
      return { kind: 'end', outcome: 'stuck', message: 'The same action produced the same result three times in a row.' };

    // ── TAB_CLOSED — terminal for that tab. With a roster of one, that IS
    //    the run (§13's forward dependency: Phase 7 makes "the rest" a real
    //    non-empty set). Never reopened. ──
    case 'TAB_CLOSED':
      return { kind: 'end', outcome: 'failed', message: 'That tab was closed.' };

    // ── BACKEND_DETACHED — [Phase 9] wires the trigger; answered here so
    //    the table and its tests are complete before that phase exists. ──
    case 'BACKEND_DETACHED':
      return { kind: 'end', outcome: 'failed', message: 'The browser connection to this tab was lost.' };

    // ── STOPPED / NEVER_TIER_AT_ACTUATOR — pre-Phase-6 causes, not among
    //    the doc's thirteen rows. STOPPED means the user already pressed
    //    Stop — there is nothing to recover, the run is ending regardless.
    //    NEVER_TIER_AT_ACTUATOR is a hard-gate violation caught at the last
    //    line of defence and should be unreachable; if it ever fires, the
    //    run ends rather than retrying a never-tier write. ──
    case 'STOPPED':
      return { kind: 'end', outcome: 'failed', message: 'Stopped.' };
    case 'NEVER_TIER_AT_ACTUATOR':
      return { kind: 'end', outcome: 'failed', message: 'A protected field was reached at the last line of defence. Stopping.' };

    default: {
      const exhaustive: never = cause;
      throw new Error(`recover(): no arm for FailureCause ${String(exhaustive)}`);
    }
  }
}
