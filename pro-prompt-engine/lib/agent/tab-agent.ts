/**
 * Tab Agent — observe → decide → request → verify, for ONE tab.
 * Docs/planning/phase_5_agent_loop.md §5, §11 task 5.5.
 * [Phase 6] recovery, suspicion and site-refusal detection woven into the
 * same observe/dispatch path — Docs/planning/phase_6_recovery_journal_reporting.md
 * §3, §5. Recovery happens INSIDE this class and reaches the Supervisor
 * only when local recovery is exhausted (§3.1): every RecoveryAction other
 * than 'ask'/'pause'/'end'/'replan' is carried out here, in a loop, before
 * this class ever returns a StepOutcome the Supervisor has to react to.
 *
 * Runs in the offscreen document, alongside the Supervisor. Its `tabId` is
 * a constructor field; every request it makes carries it; there is no verb
 * in the vocabulary that takes a tab argument (§3.3.2a). With a roster of
 * one this is trivially true — the enforcement is at the gate (Phase 3
 * check 4), tested against a synthetic two-tab ledger.
 *
 * [Deliberate reordering vs the phase doc's abbreviated §5 sketch] The
 * sketch draws the budget BEFORE calling requestAction(). Combined with
 * gate check 6.5 reading the budget's OWN mirror, that ordering would have
 * the gate refuse the very draw that just succeeded locally: drawing the
 * Nth action mirrors `actions: N` to chrome.storage.session BEFORE the
 * gate ever sees the request, and checkMirror()'s `actions >= maxActions`
 * (needed so a synthetic test that seeds the mirror at 40 and skips
 * drawAction() entirely is refused on its 41st attempt — task 5.4) would
 * then refuse that same Nth request purely because its own draw had
 * already been mirrored. Requesting FIRST (against the mirror as it stood
 * after the PREVIOUS action) and drawing only after the gate permits
 * avoids the off-by-one without weakening the backstop: the loop is
 * strictly sequential per tab, so there is never a second in-flight
 * request racing the mirror.
 */
import { resolveStep, type ResolveContext } from '@lib/agent/step-resolver';
import { requestAction } from '@lib/agent/gate-client';
import { append as journalAppend } from '@lib/agent/journal';
import { db } from '@lib/db/dexie-db';
import * as ownership from '@lib/policy/ownership';
import { domBackend } from '@lib/actuation/dom-backend';
import { relayBackend } from '@lib/actuation/relay-backend';
import { sendToTab } from '@lib/platform/tabs';
import { verify } from '@lib/page/verifier';
import { recover, detectSiteRefusal, type RecoveryContext, type RefusalSignal } from '@lib/agent/recovery';
import { scan as suspicionScan, type SuspicionHit } from '@lib/policy/suspicion';
import type { Budget } from '@lib/agent/budget';
import { actionKey } from '@lib/agent/budget';
import type { Posture } from '@lib/model/posture';
import type { PlanStep } from '@lib/schemas/plan.schema';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import { handleOf, ActionRequestSchema, type Action, type ActionRequest } from '@lib/schemas/action.schema';
import type { FailureCause, RefusalCode, ApprovalPrompt, Tier, VerificationResult } from '@lib/types/agent.types';
import type { BackendError } from '@lib/types/agent.types';
import type { BudgetError } from '@lib/agent/budget';
import type { ReplanTrigger } from '@lib/agent/replan';

/** chrome.tabs is unavailable inside the offscreen document — Chrome's own,
 *  permanent restriction there (lib/actuation/relay-backend.ts's header),
 *  the only context this class ever runs in where it is false in
 *  production. Feature-tested once at module load, not per call: the
 *  execution context (which entrypoint's bundle this module graph is
 *  running inside) cannot change mid-process. e2e's AGENT_BENCH_TAB_STEP
 *  (entrypoints/background.ts) constructs a TabAgent directly in the
 *  service worker, where chrome.tabs already exists, so this picks
 *  domBackend there too — unchanged from before this selection existed. */
const actuationBackend = typeof chrome !== 'undefined' && typeof chrome.tabs !== 'undefined' ? domBackend : relayBackend;

/** read_page/read_structure/read_element/wait_for_settle are non-mutating —
 *  there is nothing for lib/page/verifier.ts to verify, so they are
 *  journaled and returned without a verdict. Same set as
 *  entrypoints/background.ts's Phase 3 constant, duplicated here rather
 *  than imported: that constant lived in an entrypoint file, which this
 *  offscreen module must not import (entrypoints are bundle roots, not
 *  library code). */
const PERCEPTION_VERBS = new Set(['read_page', 'read_structure', 'read_element', 'wait_for_settle']);

/** URL-shape signal for AUTH_REQUIRED (§3.4), alongside the excludedCount
 *  jump — a page can redirect to a login-shaped path that has not yet
 *  rendered a password field on this snapshot. */
const LOGIN_PATH_RE = /\/(log[-_]?in|sign[-_]?in|auth(entication)?|account\/login)(\/|$|\?|#)/i;

export type StepOutcome =
  | { kind: 'done'; verb: string; tier: Tier; result: VerificationResult }
  | { kind: 'failed'; cause: FailureCause | BackendError | RefusalCode }
  | { kind: 'replan'; trigger: ReplanTrigger }
  | { kind: 'budget'; cause: BudgetError }
  | { kind: 'approval'; prompt: ApprovalPrompt; tier: Tier; req: ActionRequest }
  | { kind: 'refused'; code: RefusalCode }
  | { kind: 'stuck' }
  | { kind: 'ask_user'; question: string; reason: string; options?: string[] }
  // ── [Phase 6] new terminal/hand-off shapes the recovery table produces ──
  | { kind: 'needs_retry_approval'; question: string; req: ActionRequest; tier: Tier }   // PARTIAL_EFFECT (§3.6)
  | { kind: 'auth_required'; message: string }                                            // AUTH_REQUIRED (§3.4)
  | { kind: 'site_refused'; refusal: RefusalSignal }                                       // SITE_REFUSED (§3.5)
  | { kind: 'suspicion_halt'; hits: SuspicionHit[] }                                       // §5
  | { kind: 'finish'; outcome: 'completed' | 'completed_with_gaps' | 'failed' | 'stuck'; summary: string };

/** ensureSnapshot()'s full error surface, [Phase 6]-widened from the three
 *  backend errors to the two run-ending checks (§5, §3.5) run on every
 *  fresh perceive. lib/agent/supervisor.ts's planning path
 *  (perceiveForPlanning) sees the same union. */
export type SnapshotError =
  | { kind: 'backend'; error: 'TARGET_MISSING' | 'INVALID_SNAPSHOT' | 'PERCEPTION_TOO_LARGE' }
  | { kind: 'suspicion'; hits: SuspicionHit[] }
  | { kind: 'site_refused'; refusal: RefusalSignal };

export class TabAgent {
  private snapshot: PerceptionSnapshot | null = null;
  private epoch = 0;
  /** Forces a re-snapshot on the NEXT step even when the epoch itself looks
   *  fine — set after a `location` verification (a navigation invalidates
   *  every handle on the page) and after any non-'confirmed' verdict. */
  private stale = true;

  constructor(
    private readonly runId: number,
    private readonly tabId: number,      // ONE tab. Never another.
    private readonly budget: Budget,
    private readonly posture: Posture,
  ) {}

  currentEpoch(): number { return this.epoch; }
  currentSnapshot(): PerceptionSnapshot | null { return this.snapshot; }

  /** Resume (§9.4): always re-snapshots first, because the user may have
   *  changed the page while driving. */
  forceResnapshot(): void { this.stale = true; }

  private async perceive() {
    const res = await actuationBackend.perceive(this.tabId, this.runId, {});
    return res;
  }

  private async ensureSnapshot(): Promise<{ ok: true } | { ok: false; error: SnapshotError }> {
    if (this.snapshot && !this.snapshot.epochSuspect && !this.stale) return { ok: true };
    const snap = await this.perceive();
    if (!snap.ok) {
      const error = snap.error === 'NOT_IMPLEMENTED' ? 'TARGET_MISSING' : snap.error;
      return { ok: false, error: { kind: 'backend', error } };
    }
    const isFirstEver = this.snapshot === null;
    this.snapshot = snap.value;
    this.epoch = snap.value.epoch;
    this.stale = false;
    await ownership.record(this.runId, this.tabId, snap.value);

    // ── [Phase 6 §5] suspicion — run against EVERY fresh snapshot, before
    //    it reaches the planner or the judge tier. ──
    const run = await db.runs.get(this.runId);
    const baseline = run?.firstSnapshotExcludedCount ?? snap.value.excludedCount;
    if (isFirstEver && run && run.firstSnapshotExcludedCount === undefined) {
      await db.runs.update(this.runId, { firstSnapshotExcludedCount: snap.value.excludedCount });
    }
    const suspicion = suspicionScan(snap.value, { scope: run?.scope ?? [snap.value.origin], firstSnapshotExcludedCount: baseline });
    if (suspicion.halt) {
      await journalAppend(this.runId, 'suspicion.halted', this.tabId, { hits: suspicion.hits });
      return { ok: false, error: { kind: 'suspicion', hits: suspicion.hits } };
    }

    // ── [Phase 6 §3.5] SITE_REFUSED — checked on every fresh read, before
    //    any action against it is even resolved, so a refused page produces
    //    exactly one request. ──
    const refusal = detectSiteRefusal(snap.value, 0);
    if (refusal) {
      await journalAppend(this.runId, 'site.refused', this.tabId, refusal);
      return { ok: false, error: { kind: 'site_refused', refusal } };
    }

    return { ok: true };
  }

  async executeStep(step: PlanStep): Promise<StepOutcome> {
    return this.attempt(step, 0);
  }

  /** One attempt at `step`. `retriesForStep` is how many attempts already
   *  happened before this one (0 on the first). Recurses on 'retry'/'adapt'
   *  RecoveryActions — the recursion depth is bounded by the same
   *  3-attempt envelope lib/agent/recovery.ts's recover() enforces. */
  private async attempt(step: PlanStep, retriesForStep: number): Promise<StepOutcome> {
    // 1. OBSERVE — re-snapshot if the epoch is stale or suspect.
    const observed = await this.ensureSnapshot();
    if (!observed.ok) {
      if (observed.error.kind === 'suspicion') return { kind: 'suspicion_halt', hits: observed.error.hits };
      if (observed.error.kind === 'site_refused') return { kind: 'site_refused', refusal: observed.error.refusal };
      // INVALID_SNAPSHOT/PERCEPTION_TOO_LARGE have no FailureCause of their
      // own — both mean "could not get a usable read at all", which is the
      // same shape as TARGET_MISSING for recovery purposes (re-snapshot and
      // replan, never a bare retry of an action that never got a target).
      return this.recoverFrom('TARGET_MISSING', step, retriesForStep, null, null);
    }
    const snapshot = this.snapshot!;

    // 2. DECIDE — the judge tier only. The planner is NEVER called here.
    const ctx: ResolveContext = { runId: this.runId, tabId: this.tabId };
    const resolved = await resolveStep(step, snapshot, this.posture, ctx);
    if (!resolved.ok) {
      if (resolved.error === 'TARGET_MISSING') return { kind: 'replan', trigger: 'target_unresolvable' };
      // TARGET_AMBIGUOUS has no replan trigger of its own (§4.3's seven are
      // exhaustive) — it is exactly §10's AMBIGUOUS_TARGET ask_user reason.
      return {
        kind: 'ask_user',
        question: `Which "${step.targetHint?.name ?? step.intent}" did you mean?`,
        reason: 'AMBIGUOUS_TARGET',
      };
    }
    const req = resolved.value;

    // 3. REQUEST — cross the boundary. The gate decides. See the file
    //    header for why this happens BEFORE the local budget draw.
    const decision = await requestAction(req);
    if (decision.needsApproval) return { kind: 'approval', prompt: decision.prompt, tier: decision.tier, req };
    if (!decision.permitted) {
      if (decision.code === 'BUDGET_ACTIONS' || decision.code === 'BUDGET_WALLCLOCK' || decision.code === 'BUDGET_PLANNER') {
        return { kind: 'budget', cause: decision.code };
      }
      return { kind: 'refused', code: decision.code };
    }

    const draw = await this.budget.drawAction();
    if (!draw.ok) return { kind: 'budget', cause: draw.error };   // defensive — the gate just agreed

    // 4. VERIFY — deterministic first (Phase 3 §7), then [Phase 6] recovery.
    return this.dispatchPermitted(req, decision.tier, snapshot, step, retriesForStep);
  }

  /**
   * The post-permit tail, shared by the normal path above and by
   * performApproved() below (§9's Always-tier approval, granted after a
   * human answers the prompt — the request was already gated once; this is
   * the SAME request, dispatched, never re-gated or re-budgeted a second
   * time for one action).
   */
  private async dispatchPermitted(
    req: ActionRequest, tier: Tier, snapshot: PerceptionSnapshot, step: PlanStep, retriesForStep: number,
  ): Promise<StepOutcome> {
    // Control verbs (§10) — never touch the page, never go through the
    // verifier, never recovered.
    if (req.action.verb === 'ask_user') {
      const a = req.action;
      await journalAppend(this.runId, 'ask_user.asked', this.tabId, { question: a.question, reason: a.reason, options: a.options ?? null, stepN: step.n });
      return { kind: 'ask_user', question: a.question, reason: a.reason, options: a.options };
    }
    if (req.action.verb === 'finish') {
      return { kind: 'finish', outcome: req.action.outcome, summary: req.action.summary };
    }

    if (PERCEPTION_VERBS.has(req.action.verb)) {
      return this.performRead(req, tier, step.n);
    }

    const outcome = await this.performAndVerify(req, tier, snapshot, step.n);
    return this.recoverIfNeeded(outcome, step, retriesForStep, req, tier);
  }

  /** Shared by the normal per-step path and performApproved() below: turns
   *  a raw performAndVerify() outcome into either the outcome itself (a
   *  genuine success, or something recovery has no arm for — 'stuck',
   *  'budget', a RefusalCode) or a recovery-table decision (§3). */
  private async recoverIfNeeded(
    outcome: StepOutcome, step: PlanStep, retriesForStep: number, req: ActionRequest, tier: Tier,
  ): Promise<StepOutcome> {
    if (outcome.kind === 'failed') {
      return this.recoverFrom(outcome.cause as FailureCause, step, retriesForStep, req, tier);
    }
    if (outcome.kind === 'done') {
      const verdict = outcome.result;
      if (verdict.verified === 'failed' && verdict.failureCause) {
        return this.recoverFrom(verdict.failureCause, step, retriesForStep, req, tier, verdict);
      }
      const notSettled = verdict.verified === 'unconfirmed' && this.snapshot?.settled === false;
      if (notSettled) {
        return this.recoverFrom('NOT_SETTLED', step, retriesForStep, req, tier, verdict);
      }
    }
    return outcome;
  }

  /** §9's Always-tier approval, already granted — dispatches the SAME
   *  ActionRequest the earlier gate check permitted-pending-approval,
   *  against the CURRENT snapshot (never re-resolving the step: the target
   *  handle was already fixed when the prompt was built). executeStep()
   *  returns its 'approval' outcome BEFORE drawing the budget (the action
   *  was not yet permitted), so this is where that draw actually happens —
   *  exactly once per approved action, same as the non-approval path.
   *  [Phase 6] carries `step`/`retriesForStep` through the SAME
   *  recoverIfNeeded() an ordinary dispatch uses — an approved Always-tier
   *  action (very often a form submit) is exactly where PARTIAL_EFFECT and
   *  WRITE_REJECTED are most likely, and an approved action recovers
   *  exactly like any other, never bypassing the table. */
  async performApproved(req: ActionRequest, tier: Tier, step: PlanStep, retriesForStep = 0): Promise<StepOutcome> {
    const draw = await this.budget.drawAction();
    if (!draw.ok) return { kind: 'budget', cause: draw.error };
    const ensured = await this.ensureSnapshot();
    if (!ensured.ok) {
      if (ensured.error.kind === 'suspicion') return { kind: 'suspicion_halt', hits: ensured.error.hits };
      if (ensured.error.kind === 'site_refused') return { kind: 'site_refused', refusal: ensured.error.refusal };
      return { kind: 'failed', cause: ensured.error.error };
    }
    const outcome = await this.performAndVerify(req, tier, this.snapshot!, step.n);
    return this.recoverIfNeeded(outcome, step, retriesForStep, req, tier);
  }

  /** Planning needs a snapshot too (run start and every replan, §4.1, §4.3)
   *  — exposed so lib/agent/supervisor.ts never reaches into this class's
   *  private perception plumbing. */
  async perceiveForPlanning(): Promise<{ ok: true; value: PerceptionSnapshot } | { ok: false; error: SnapshotError }> {
    const ensured = await this.ensureSnapshot();
    if (!ensured.ok) return ensured;
    return { ok: true, value: this.snapshot! };
  }

  // ── [Phase 6] recovery orchestration ──

  /** The one point where a FailureCause becomes a RecoveryAction and the
   *  RecoveryAction is carried out. OBSCURED's one dismissal attempt
   *  happens here (never inside lib/agent/recovery.ts, which is pure) —
   *  its result is folded into the RecoveryContext BEFORE recover() is
   *  called, so recover() only ever answers "given that this already
   *  happened, what next". */
  private async recoverFrom(
    cause: FailureCause, step: PlanStep, retriesForStep: number,
    req: ActionRequest | null, tier: Tier | null, verdict?: VerificationResult,
  ): Promise<StepOutcome> {
    const handle = req ? handleOf(req.action) : handleOf(step.action);

    let overlayDismissed: boolean | undefined;
    if (cause === 'OBSCURED' && handle) {
      const epoch = req?.epoch ?? this.epoch;
      const dismiss = await actuationBackend.dismissOverlay(this.tabId, this.runId, handle, epoch);
      overlayDismissed = dismiss.ok ? dismiss.value.dismissed : false;
    }

    const intended = req?.action.verb === 'type' ? req.action.text
      : step.action.verb === 'type' ? step.action.text : undefined;

    const ctx: RecoveryContext = {
      step, retriesForStep, handle,
      targetName: step.targetHint?.name,
      intended,
      readBack: verdict?.evidence?.after,
      overlayDismissed,
    };
    const action = recover(cause, ctx);
    await journalAppend(this.runId, 'recovery.attempted', this.tabId, { cause, stepN: step.n, action: action.kind, retriesForStep });

    switch (action.kind) {
      case 'retry': {
        if (action.afterSettle) await this.waitOneSettleWindow();
        this.budget.noteRetry(step.n);
        this.stale = true;   // the dismissal/settle-wait may have changed the DOM
        const redone = await this.attempt(step, retriesForStep + 1);
        if (redone.kind === 'done' && redone.result.verified === 'confirmed') {
          await journalAppend(this.runId, 'recovery.recovered', this.tabId, {
            cause, stepN: step.n, method: cause === 'OBSCURED' ? 'dismissed an overlay and retried' : 'retried after settling',
          });
        }
        return redone;
      }

      case 'adapt': {
        this.budget.noteRetry(step.n);
        const preActions = action.sequence.slice(0, -1);
        for (const pre of preActions) {
          const subOutcome = await this.dispatchAdaptStep(pre);
          // A pre-action that could not be dispatched at all (refused,
          // needs its own approval, or itself failed) means the adaptation
          // cannot proceed — fail straight to asking, never half-run a
          // sequence and silently skip to the original action anyway.
          if (subOutcome !== 'ok') {
            return {
              kind: 'ask_user', reason: 'MISSING_CAPABILITY',
              question: `I couldn't prepare "${step.intent}" for a retry. Would you like to fill this one yourself?`,
            };
          }
        }
        this.stale = true;
        const redone = await this.attempt(step, retriesForStep + 1);
        if (redone.kind === 'done' && redone.result.verified === 'confirmed') {
          await journalAppend(this.runId, 'recovery.recovered', this.tabId, {
            cause, stepN: step.n, method: 'clicked to focus, then retyped',
          });
        }
        return redone;
      }

      case 'accept': {
        // The verdict that reported this WRITE_REJECTED already carries the
        // loosely-matching read-back (ctx.readBack, above) — that IS the
        // confirmation. Never re-dispatch: a deterministic reformatter
        // would produce the identical strict mismatch a third time.
        const result: VerificationResult = {
          verified: 'confirmed', check: 'state',
          evidence: { before: verdict?.evidence?.before, after: verdict?.evidence?.after, detail: action.note },
        };
        await journalAppend(this.runId, 'recovery.recovered', this.tabId, { cause, stepN: step.n, method: action.note });
        return { kind: 'done', verb: (req ?? { action: step.action }).action.verb, tier: tier ?? 'low', result };
      }

      case 'replan':
        return { kind: 'replan', trigger: action.trigger };

      case 'ask':
        await journalAppend(this.runId, 'ask_user.asked', this.tabId, { question: action.question, reason: action.reason, stepN: step.n, cause });
        await journalAppend(this.runId, 'recovery.exhausted', this.tabId, { cause, stepN: step.n, retriesForStep });
        return { kind: 'ask_user', question: action.question, reason: action.reason };

      case 'approve_retry': {
        if (!req || !tier) {
          // Defensive: PARTIAL_EFFECT is only ever produced from a
          // dispatched action, which always supplies req/tier.
          return { kind: 'ask_user', reason: 'MISSING_CAPABILITY', question: action.question };
        }
        return { kind: 'needs_retry_approval', question: action.question, req, tier };
      }

      case 'pause':
        await journalAppend(this.runId, 'auth.required', this.tabId, { message: action.message, stepN: step.n });
        return { kind: 'auth_required', message: action.message };

      case 'end':
        await journalAppend(this.runId, 'recovery.exhausted', this.tabId, { cause, stepN: step.n, retriesForStep, terminal: true });
        return { kind: 'finish', outcome: action.outcome, summary: action.message };
    }
  }

  /** One recovery pre-action (WRITE_REJECTED's focusing click) — dispatched
   *  through the full gate/budget/actuate/verify pipeline like any other
   *  action, but WITHOUT recursing into recovery itself: a pre-action that
   *  fails means the adaptation cannot proceed at all, not that IT needs
   *  its own recovery loop. If the gate holds it for approval, the
   *  adaptation is abandoned rather than opening a second, nested approval
   *  wait mid-recovery (documented simplification — a genuinely
   *  approval-gated focusing click is rare: focusing a field is Low tier
   *  under every mode this phase's default policy grants). */
  private async dispatchAdaptStep(action: Action): Promise<'ok' | 'blocked'> {
    if (!this.snapshot) return 'blocked';
    const req = ActionRequestSchema.parse({
      requestId: crypto.randomUUID(), runId: this.runId, tabId: this.tabId,
      epoch: this.snapshot.epoch, action, reason: 'recovery adaptation',
    });
    const decision = await requestAction(req);
    if (!decision.permitted) return 'blocked';
    const draw = await this.budget.drawAction();
    if (!draw.ok) return 'blocked';
    const outcome = await this.performAndVerify(req, decision.tier, this.snapshot, 0);
    return outcome.kind === 'done' ? 'ok' : 'blocked';
  }

  private async waitOneSettleWindow(): Promise<void> {
    await sendToTab(this.tabId, { type: 'WAIT_FOR_SETTLE', runId: String(this.runId) });
  }

  private async performRead(req: ActionRequest, tier: Tier, stepN: number): Promise<StepOutcome> {
    const t0 = performance.now();
    const a = req.action as Extract<typeof req.action, { verb: 'read_page' | 'read_structure' | 'read_element' | 'wait_for_settle' }>;
    const message = a.verb === 'read_page' ? { type: 'PERCEIVE_PAGE', runId: String(this.runId) }
      : a.verb === 'read_structure' ? { type: 'PERCEIVE_STRUCTURE', runId: String(this.runId), region: a.region, tokenBudget: 6_000 }
      : a.verb === 'read_element' ? { type: 'PERCEIVE_ELEMENT', runId: String(this.runId), handle: a.handle }
      : { type: 'WAIT_FOR_SETTLE', runId: String(this.runId), maxMs: a.maxMs };

    const res = await sendToTab(this.tabId, message);
    const elapsedMs = Math.round(performance.now() - t0);
    if (!res || res.status === 'error') {
      const code = (res?.message ?? 'TARGET_MISSING') as FailureCause;
      await journalAppend(this.runId, 'action.refused', this.tabId, { code, verb: req.action.verb, stepN });
      return { kind: 'failed', cause: code };
    }
    await journalAppend(this.runId, 'action.dispatched', this.tabId, { verb: req.action.verb, elapsedMs, stepN });
    const result: VerificationResult = { verified: 'confirmed', check: 'state' };
    // [Phase 6 §6.3] the actual read CONTENT, not just that a read happened
    // — lib/agent/reporter.ts's traceability check needs a value to trace
    // an extracted answer BACK to. Bounded so this never becomes an
    // unbounded raw-page dump into runEvents.
    await journalAppend(this.runId, 'action.observed', this.tabId, {
      verb: req.action.verb, tier, stepN, ...result, read: summariseRead(a.verb, res.data),
      url: this.snapshot?.url,   // [Phase 6 §6.2] ReportedStep.sourceUrl / Gap.where's source
    });
    this.stale = true;   // a fresh read is itself the next epoch's basis
    return { kind: 'done', verb: req.action.verb, tier, result };
  }

  private async performAndVerify(req: ActionRequest, tier: Tier, pre: PerceptionSnapshot, stepN: number): Promise<StepOutcome> {
    const effect = await actuationBackend.act(this.tabId, this.runId, req.action, req.epoch);
    if (!effect.ok) {
      await journalAppend(this.runId, 'action.refused', this.tabId, { code: effect.error, verb: req.action.verb, stepN });
      return { kind: 'failed', cause: effect.error };
    }
    await journalAppend(this.runId, 'action.dispatched', this.tabId, { verb: req.action.verb, elapsedMs: effect.value.elapsedMs, stepN });

    const post = await actuationBackend.perceive(this.tabId, this.runId, {});
    if (!post.ok) return { kind: 'failed', cause: 'TARGET_MISSING' };
    await ownership.record(this.runId, this.tabId, post.value);
    this.snapshot = post.value;
    this.epoch = post.value.epoch;

    // [Phase 6 §3.4] AUTH_REQUIRED — a login form appeared where content
    // was expected: a jump in excludedCount (a password field is now on
    // the page) or a login-shaped URL that was not login-shaped before.
    const authAppeared = post.value.excludedCount > pre.excludedCount
      || (LOGIN_PATH_RE.test(post.value.url) && !LOGIN_PATH_RE.test(pre.url));
    if (authAppeared) {
      await journalAppend(this.runId, 'action.observed', this.tabId, {
        verb: req.action.verb, tier, stepN, verified: 'failed', check: 'state', failureCause: 'AUTH_REQUIRED',
      });
      return { kind: 'failed', cause: 'AUTH_REQUIRED' };
    }

    const verdict = await verify(req.action, effect.value, post.value, pre);
    const handle = handleOf(req.action);
    await journalAppend(this.runId, 'action.observed', this.tabId, {
      verb: req.action.verb, handle, tier, stepN, verified: verdict.verified,
      check: verdict.check, evidence: verdict.evidence, failureCause: verdict.failureCause,
      url: post.value.url,   // [Phase 6 §6.2] ReportedStep.sourceUrl (PR-VER-6 traceability)
    });

    // A `location` verdict invalidates every handle on the page — the next
    // step must re-snapshot even if the new epoch itself looks fine.
    this.stale = verdict.verified !== 'confirmed' || verdict.check === 'location';

    const key = actionKey(req.action as unknown as { verb: string } & Record<string, unknown>);
    const stuck = this.budget.noteOutcome(key, verdict.verified);
    if (stuck === 'stuck') return { kind: 'stuck' };

    // A 'failed' verdict is reported here, not turned into a 'replan'
    // outcome directly — dispatchPermitted()/recoverFrom() decide what to
    // do with it via lib/agent/recovery.ts, and the Supervisor's loop only
    // ever sees the OUTCOME of that decision (a 'replan' StepOutcome when
    // recovery itself calls for one, never a bare failed verdict).
    return { kind: 'done', verb: req.action.verb, tier, result: verdict };
  }
}

/** Bounded, traceable summary of a read verb's result for the journal —
 *  §6.3's traceability check runs a substring test against THIS, never
 *  against a live re-perceive. `read_page`'s full text is capped at 4,000
 *  characters (enough for typical extraction targets; a longer page's tail
 *  is simply not traceable, which lib/agent/reporter.ts's traceability
 *  check turns into an honest gap rather than a silent pass). */
function summariseRead(verb: string, data: unknown): unknown {
  if (verb === 'read_page') {
    const d = data as { text?: string; url?: string } | undefined;
    const text = d?.text ?? '';
    return { url: d?.url, textPreview: text.slice(0, 4_000), fullLength: text.length };
  }
  if (verb === 'read_structure') {
    // PERCEIVE_STRUCTURE's payload is a full PerceptionSnapshot
    // (lib/schemas/snapshot.schema.ts's PerceiveStructureResponseSchema) —
    // only the named elements' role/name/value are worth tracing a report
    // claim back to; the rest of the snapshot is re-derivable and not
    // duplicated into the journal.
    const d = data as PerceptionSnapshot | undefined;
    return {
      elements: (d?.elements ?? [])
        .filter((e) => e.name || e.valueShape)
        .map((e) => ({ role: e.role, name: e.name, valueShape: e.valueShape })),
      // [Phase 6 §4/§6.3] shown-vs-total per region — the real, honest
      // basis for a `not_found` Gap when a repeating region (a spec table,
      // a results list) was read incompletely. J-2's "22 of 24 values
      // found" comes directly from this, not from re-deriving a count.
      regions: (d?.regions ?? []).map((r) => ({ regionId: r.regionId, label: r.label, shown: r.shown, total: r.total })),
    };
  }
  if (verb === 'read_element') {
    const d = data as { kind: string; element?: { role: string; name: string; valueShape?: string } } | undefined;
    return d?.element ? { element: { role: d.element.role, name: d.element.name, valueShape: d.element.valueShape } } : undefined;
  }
  return undefined;
}
