/**
 * Tab Agent — observe → decide → request → verify, for ONE tab.
 * Docs/planning/phase_5_agent_loop.md §5, §11 task 5.5.
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
import * as ownership from '@lib/policy/ownership';
import { domBackend } from '@lib/actuation/dom-backend';
import { verify } from '@lib/page/verifier';
import type { Budget } from '@lib/agent/budget';
import { actionKey } from '@lib/agent/budget';
import type { Posture } from '@lib/model/posture';
import type { PlanStep } from '@lib/schemas/plan.schema';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import { handleOf, type ActionRequest } from '@lib/schemas/action.schema';
import type { FailureCause, RefusalCode, ApprovalPrompt, Tier, VerificationResult } from '@lib/types/agent.types';
import type { BackendError } from '@lib/types/agent.types';
import type { BudgetError } from '@lib/agent/budget';
import type { ReplanTrigger } from '@lib/agent/replan';

/** read_page/read_structure/read_element/wait_for_settle are non-mutating —
 *  there is nothing for lib/page/verifier.ts to verify, so they are
 *  journaled and returned without a verdict. Same set as
 *  entrypoints/background.ts's Phase 3 constant, duplicated here rather
 *  than imported: that constant lived in an entrypoint file, which this
 *  offscreen module must not import (entrypoints are bundle roots, not
 *  library code). */
const PERCEPTION_VERBS = new Set(['read_page', 'read_structure', 'read_element', 'wait_for_settle']);

export type StepOutcome =
  | { kind: 'done'; verb: string; tier: Tier; result: VerificationResult }
  | { kind: 'failed'; cause: FailureCause | BackendError | RefusalCode }
  | { kind: 'replan'; trigger: ReplanTrigger }
  | { kind: 'budget'; cause: BudgetError }
  | { kind: 'approval'; prompt: ApprovalPrompt; tier: Tier; req: ActionRequest }
  | { kind: 'refused'; code: RefusalCode }
  | { kind: 'stuck' }
  | { kind: 'ask_user'; question: string; reason: string; options?: string[] }
  | { kind: 'finish'; outcome: 'completed' | 'completed_with_gaps' | 'failed' | 'stuck'; summary: string };

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
    const res = await domBackend.perceive(this.tabId, this.runId, {});
    return res;
  }

  private async ensureSnapshot(): Promise<{ ok: true } | { ok: false; error: 'TARGET_MISSING' | 'INVALID_SNAPSHOT' | 'PERCEPTION_TOO_LARGE' }> {
    if (this.snapshot && !this.snapshot.epochSuspect && !this.stale) return { ok: true };
    const snap = await this.perceive();
    if (!snap.ok) return { ok: false, error: snap.error === 'NOT_IMPLEMENTED' ? 'TARGET_MISSING' : snap.error };
    this.snapshot = snap.value;
    this.epoch = snap.value.epoch;
    this.stale = false;
    await ownership.record(this.runId, this.tabId, snap.value);
    return { ok: true };
  }

  async executeStep(step: PlanStep): Promise<StepOutcome> {
    // 1. OBSERVE — re-snapshot if the epoch is stale or suspect.
    const observed = await this.ensureSnapshot();
    if (!observed.ok) return { kind: 'failed', cause: observed.error };
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

    // 4. VERIFY — deterministic first (Phase 3 §7).
    return this.dispatchPermitted(req, decision.tier, snapshot);
  }

  /**
   * The post-permit tail, shared by the normal path above and by
   * performApproved() below (§9's Always-tier approval, granted after a
   * human answers the prompt — the request was already gated once; this is
   * the SAME request, dispatched, never re-gated or re-budgeted a second
   * time for one action).
   */
  private async dispatchPermitted(req: ActionRequest, tier: Tier, snapshot: PerceptionSnapshot): Promise<StepOutcome> {
    // Control verbs (§10) — never touch the page, never go through the
    // verifier.
    if (req.action.verb === 'ask_user') {
      const a = req.action;
      await journalAppend(this.runId, 'ask_user.asked', this.tabId, { question: a.question, reason: a.reason, options: a.options ?? null });
      return { kind: 'ask_user', question: a.question, reason: a.reason, options: a.options };
    }
    if (req.action.verb === 'finish') {
      return { kind: 'finish', outcome: req.action.outcome, summary: req.action.summary };
    }

    if (PERCEPTION_VERBS.has(req.action.verb)) {
      return this.performRead(req, tier);
    }

    return this.performAndVerify(req, tier, snapshot);
  }

  /** §9's Always-tier approval, already granted — dispatches the SAME
   *  ActionRequest the earlier gate check permitted-pending-approval,
   *  against the CURRENT snapshot (never re-resolving the step: the target
   *  handle was already fixed when the prompt was built). executeStep()
   *  returns its 'approval' outcome BEFORE drawing the budget (the action
   *  was not yet permitted), so this is where that draw actually happens —
   *  exactly once per approved action, same as the non-approval path. */
  async performApproved(req: ActionRequest, tier: Tier): Promise<StepOutcome> {
    const draw = await this.budget.drawAction();
    if (!draw.ok) return { kind: 'budget', cause: draw.error };
    const ensured = await this.ensureSnapshot();
    if (!ensured.ok) return { kind: 'failed', cause: ensured.error };
    return this.dispatchPermitted(req, tier, this.snapshot!);
  }

  /** Planning needs a snapshot too (run start and every replan, §4.1, §4.3)
   *  — exposed so lib/agent/supervisor.ts never reaches into this class's
   *  private perception plumbing. */
  async perceiveForPlanning(): Promise<{ ok: true; value: PerceptionSnapshot } | { ok: false; error: 'TARGET_MISSING' | 'INVALID_SNAPSHOT' | 'PERCEPTION_TOO_LARGE' }> {
    const ensured = await this.ensureSnapshot();
    if (!ensured.ok) return ensured;
    return { ok: true, value: this.snapshot! };
  }

  private async performRead(req: ActionRequest, tier: Tier): Promise<StepOutcome> {
    const t0 = performance.now();
    const a = req.action as Extract<typeof req.action, { verb: 'read_page' | 'read_structure' | 'read_element' | 'wait_for_settle' }>;
    const message = a.verb === 'read_page' ? { type: 'PERCEIVE_PAGE', runId: String(this.runId) }
      : a.verb === 'read_structure' ? { type: 'PERCEIVE_STRUCTURE', runId: String(this.runId), region: a.region, tokenBudget: 6_000 }
      : a.verb === 'read_element' ? { type: 'PERCEIVE_ELEMENT', runId: String(this.runId), handle: a.handle }
      : { type: 'WAIT_FOR_SETTLE', runId: String(this.runId), maxMs: a.maxMs };

    const res = await chrome.tabs.sendMessage(this.tabId, message).catch(() => null);
    const elapsedMs = Math.round(performance.now() - t0);
    if (!res || res.status === 'error') {
      const code = (res?.message ?? 'TARGET_MISSING') as FailureCause;
      await journalAppend(this.runId, 'action.refused', this.tabId, { code, verb: req.action.verb });
      return { kind: 'failed', cause: code };
    }
    await journalAppend(this.runId, 'action.dispatched', this.tabId, { verb: req.action.verb, elapsedMs });
    const result: VerificationResult = { verified: 'confirmed', check: 'state' };
    await journalAppend(this.runId, 'action.observed', this.tabId, { verb: req.action.verb, tier, ...result });
    this.stale = true;   // a fresh read is itself the next epoch's basis
    return { kind: 'done', verb: req.action.verb, tier, result };
  }

  private async performAndVerify(req: ActionRequest, tier: Tier, pre: PerceptionSnapshot): Promise<StepOutcome> {
    const effect = await domBackend.act(this.tabId, this.runId, req.action, req.epoch);
    if (!effect.ok) {
      await journalAppend(this.runId, 'action.refused', this.tabId, { code: effect.error, verb: req.action.verb });
      return { kind: 'failed', cause: effect.error };
    }
    await journalAppend(this.runId, 'action.dispatched', this.tabId, { verb: req.action.verb, elapsedMs: effect.value.elapsedMs });

    const post = await domBackend.perceive(this.tabId, this.runId, {});
    if (!post.ok) return { kind: 'failed', cause: 'TARGET_MISSING' };
    await ownership.record(this.runId, this.tabId, post.value);
    this.snapshot = post.value;
    this.epoch = post.value.epoch;

    const verdict = await verify(req.action, effect.value, post.value, pre);
    const handle = handleOf(req.action);
    await journalAppend(this.runId, 'action.observed', this.tabId, {
      verb: req.action.verb, handle, tier, verified: verdict.verified,
      check: verdict.check, evidence: verdict.evidence, failureCause: verdict.failureCause,
    });

    // A `location` verdict invalidates every handle on the page — the next
    // step must re-snapshot even if the new epoch itself looks fine.
    this.stale = verdict.verified !== 'confirmed' || verdict.check === 'location';

    const key = actionKey(req.action as unknown as { verb: string } & Record<string, unknown>);
    const stuck = this.budget.noteOutcome(key, verdict.verified);
    if (stuck === 'stuck') return { kind: 'stuck' };

    // A 'failed' verdict is reported here, not turned into a 'replan'
    // outcome directly — the Supervisor's loop (lib/agent/supervisor.ts)
    // examines `result.verified` from THIS returned outcome and calls
    // shouldReplan() itself before deriving the next step (§4.3 triggers 2
    // and 3 both key off the PREVIOUS step's verdict/verdict-streak, which
    // is strategic state the Supervisor owns, not this mechanical executor).
    return { kind: 'done', verb: req.action.verb, tier, result: verdict };
  }
}
