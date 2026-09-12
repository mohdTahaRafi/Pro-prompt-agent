/**
 * Supervisor — the five-phase run driver. Docs/planning/phase_5_agent_loop.md §4.
 *
 * Runs in the offscreen document (§3). Never touches a browser capability
 * itself — it schedules. Every action it wants goes to the gate as an
 * ActionRequest (lib/agent/gate-client.ts) and comes back permitted or
 * refused; it holds no handles (those belong to the Tab Agent) and never
 * calls chrome.tabs, chrome.scripting or chrome.permissions.
 *
 * The roster is size one this phase. The seam for more exists (§4.1's
 * phase enum, §16) and is unused — that is the whole reason the
 * Supervisor/Tab-Agent split is made now rather than when multi-tab is
 * needed.
 */
import { db } from '@lib/db/dexie-db';
import { getSitePolicy } from '@lib/db/policy-store';
import * as journal from '@lib/agent/journal';
import { transition } from '@lib/agent/run-state';
import { plan as runPlanner } from '@lib/agent/planner';
import type { PlannerPolicy } from '@lib/agent/prompts';
import { Budget } from '@lib/agent/budget';
import { TabAgent, type StepOutcome } from '@lib/agent/tab-agent';
import { TabRoster } from '@lib/agent/tab-roster';
import { shouldReplan, type StepContext, type ReplanTrigger } from '@lib/agent/replan';
import { summarize } from '@lib/agent/reporter';
import { DEFAULT_CAPABILITIES } from '@lib/policy/scope';
import type { RunRecord, RunState } from '@lib/types/run.types';
import type { Plan, PlanStep } from '@lib/schemas/plan.schema';
import type { Verified } from '@lib/types/agent.types';

// ── §4.1 — the phase table. A standalone, pure, testable structure so
//    supervisor.spec.ts can drive it against a synthetic multi-agent roster
//    even though production only ever walks survey -> act -> end (roster of
//    one — read/synthesise collapse into act, §4.1's header note). ──

export type RunPhase = 'survey' | 'read' | 'synthesise' | 'act' | 'end';

const LEGAL_PHASES: Record<RunPhase, RunPhase[]> = {
  survey: ['read', 'act', 'end'],
  read: ['synthesise', 'end'],
  synthesise: ['act', 'end'],
  act: ['read', 'end'],   // [Phase 7] act fans back out to read for a newly-opened tab
  end: [],
};

export function legalPhaseTransition(from: RunPhase, to: RunPhase): boolean {
  return LEGAL_PHASES[from].includes(to);
}

export function advancePhase(from: RunPhase, to: RunPhase): RunPhase {
  if (!legalPhaseTransition(from, to)) throw new Error(`ILLEGAL_PHASE_TRANSITION: ${from} -> ${to}`);
  return to;
}

const TERMINAL_STATES = new Set<RunState>(['halted', 'stopped', 'failed', 'completed']);

export interface RunAdmitted {
  runId: number;
  tabId: number;
  goal: string;
  mode: RunRecord['mode'];
  posture: RunRecord['posture'];
  origin: string;
}

/** §4.3: "the planner is told the plan changed and re-derives the
 *  remainder." Built fresh for every replan() call, from the trigger and
 *  whatever plan is CURRENTLY on the run row (the last approved or
 *  last-replanned one) — never from this Supervisor's own step index,
 *  which the planner has no use for. */
function priorPlanNoteFor(trigger: ReplanTrigger, plan: Plan | undefined): string {
  const why: Record<ReplanTrigger, string> = {
    run_start: 'This is the first plan for this task.',
    verification_failed: 'The last attempted step did not verify — its effect could not be confirmed.',
    two_unconfirmed: 'The same step came back unconfirmed twice in a row.',
    target_unresolvable: 'A planned step\'s target could no longer be found on the page.',
    unexpected_change: 'The page changed in a way the previous plan did not predict (navigation or a large mutation).',
    user_edited_plan: 'The user edited the previous plan before or during this run.',
    anomaly: 'The page looks structurally different from what was expected.',
  };
  if (!plan || plan.steps.length === 0) return why[trigger];
  const kept = plan.steps.map((s) => `${s.n}. ${s.intent}`).join('; ');
  return `${why[trigger]} The user's most recently approved plan had these steps: ${kept}. ` +
    'Preserve the user\'s intent — do not reintroduce a step they removed unless the goal clearly still requires it.';
}

interface Waiter<T> { promise: Promise<T>; resolve: (v: T) => void }
function makeWaiter<T>(): Waiter<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

export class Supervisor {
  private phase: RunPhase = 'survey';
  private readonly roster = new TabRoster();
  private budget!: Budget;
  private tabAgent!: TabAgent;
  private readonly runId: number;
  private readonly tabId: number;

  private stopped = false;
  private tabClosed = false;

  private planApproval: Waiter<{ approve: boolean; editedPlan?: Plan }> | null = null;
  private readonly actionApprovals = new Map<string, Waiter<{ approve: boolean; reason?: string }>>();
  private askUserWaiter: Waiter<string> | null = null;
  private pauseWaiter: Waiter<void> | null = null;
  private takeOverWaiter: Waiter<void> | null = null;

  private stepIndex = 0;
  private lastVerdict: Verified | null = null;
  private lastStepIndexSeen = -1;
  private consecutiveUnconfirmed = 0;
  private planEditedSince = false;

  constructor(private readonly admitted: RunAdmitted) {
    this.runId = admitted.runId;
    this.tabId = admitted.tabId;
  }

  // ── External control surface — called by entrypoints/offscreen/main.ts's
  //    message router when a forwarded cockpit command arrives. ──

  respondPlanApproval(approve: boolean, editedPlan?: Plan): void {
    this.planApproval?.resolve({ approve, editedPlan });
  }

  respondActionApproval(requestId: string, approve: boolean, reason?: string): void {
    this.actionApprovals.get(requestId)?.resolve({ approve, reason });
  }

  respondAskUser(answer: string): void {
    const w = this.askUserWaiter;
    this.askUserWaiter = null;
    w?.resolve(answer);
  }

  async pause(): Promise<void> {
    const run = await db.runs.get(this.runId);
    if (!run) return;
    const t = transition(run.state, 'paused');
    if (!t.ok) return;
    await db.runs.update(this.runId, { state: t.value });
    await journal.append(this.runId, 'run.paused', this.tabId, {});
  }

  /** Resolves whichever wait the Supervisor is actually in — Pause or
   *  Take-over (§7's table: 'running' is legal from both). Always
   *  re-snapshots before the next step (§9.4) — the user may have changed
   *  the page while paused or driving. */
  async resume(): Promise<void> {
    const run = await db.runs.get(this.runId);
    if (!run) return;
    const t = transition(run.state, 'running');
    if (!t.ok) return;
    await db.runs.update(this.runId, { state: t.value });
    await journal.append(this.runId, 'run.resumed', this.tabId, {});
    this.tabAgent?.forceResnapshot();
    const pw = this.pauseWaiter; this.pauseWaiter = null; pw?.resolve(undefined);
    const tw = this.takeOverWaiter; this.takeOverWaiter = null; tw?.resolve(undefined);
  }

  async takeOver(): Promise<void> {
    const run = await db.runs.get(this.runId);
    if (!run) return;
    const t = transition(run.state, 'taken_over');
    if (!t.ok) return;
    await db.runs.update(this.runId, { state: t.value });
    await journal.append(this.runId, 'run.taken_over', this.tabId, {});
  }

  // ── Stop (§3.7.19) — chrome.storage.session is the single source of
  //    truth, written by both the panel and the overlay. This listener is
  //    what makes a Stop pressed WHILE the Supervisor is blocked in a
  //    pause/approval/ask_user wait unblock it instantly instead of only
  //    being discovered on the next gate check. ──

  private readonly stopListener = (
    changes: Record<string, chrome.storage.StorageChange>, area: string,
  ): void => {
    if (area !== 'session') return;
    if (changes[`stop:${this.runId}`]?.newValue) this.onInterrupt('stopped');
  };

  private onInterrupt(reason: 'stopped' | 'tab_closed'): void {
    if (reason === 'tab_closed') this.tabClosed = true;
    this.stopped = true;
    this.planApproval?.resolve({ approve: false });
    for (const w of this.actionApprovals.values()) w.resolve({ approve: false });
    this.askUserWaiter?.resolve('');
    this.pauseWaiter?.resolve(undefined);
    this.takeOverWaiter?.resolve(undefined);
  }

  // ── The run itself ──

  async run(): Promise<void> {
    chrome.storage.onChanged.addListener(this.stopListener);
    try {
      await this.survey();
      if (this.stopped) return;
      const planned = await this.planStep();
      if (!planned || this.stopped) return;
      const approved = await this.awaitPlanApproval();
      if (!approved || this.stopped) return;
      await this.act();
    } finally {
      await this.finalize();
      chrome.storage.onChanged.removeListener(this.stopListener);
      this.roster.unwatch();
    }
  }

  private async survey(): Promise<void> {
    this.phase = 'survey';
    const tab = await chrome.tabs.get(this.tabId).catch(() => null);
    this.roster.add(this.tabId, this.admitted.origin, tab?.title ?? '');
    this.roster.watch((tabId) => { if (tabId === this.tabId) this.onInterrupt('tab_closed'); });

    const run = await db.runs.get(this.runId);
    if (!run) { this.stopped = true; return; }
    this.budget = new Budget(run.budgets, this.runId, run.startedAt);
    this.tabAgent = new TabAgent(this.runId, this.tabId, this.budget, this.admitted.posture);
  }

  private async plannerPolicy(run: RunRecord): Promise<PlannerPolicy> {
    const policyRow = await getSitePolicy(this.admitted.origin);
    return {
      verbs: policyRow?.capabilities ?? DEFAULT_CAPABILITIES,
      origins: [this.admitted.origin],
      maxActions: run.budgets.maxActions,
      maxWallClockMinutes: Math.round(run.budgets.maxWallClockMs / 60_000),
    };
  }

  /** Trigger 1 (§4.3, run_start) — the only trigger that runs OUTSIDE the
   *  act() loop, because there is no plan yet for the loop to iterate. */
  private async planStep(): Promise<boolean> {
    const draw = await this.budget.drawPlannerCall();
    if (!draw.ok) { await this.finishRun('failed', "Couldn't start planning — the planner budget for this run is exhausted."); return false; }

    const run = await db.runs.get(this.runId);
    if (!run) return false;
    const snap = await this.tabAgent.perceiveForPlanning();
    if (!snap.ok) { await this.finishRun('failed', 'Could not read the page to plan against.'); return false; }

    const policy = await this.plannerPolicy(run);
    const result = await runPlanner({
      goal: this.admitted.goal, postureChoice: this.admitted.posture,
      snapshot: snap.value, policy, runId: this.runId,
    });
    if (!result.ok) {
      const reason = result.error.code === 'NO_PLANNER' ? result.error.reason : "The plan couldn't be produced.";
      await this.finishRun('failed', reason);
      return false;
    }

    await db.runs.update(this.runId, { plan: result.value, state: 'awaiting_plan_approval' });
    await journal.append(this.runId, 'plan.proposed', this.tabId, {
      steps: result.value.steps.length, willNotDo: result.value.willNotDo.length,
      clarifyingQuestion: result.value.clarifyingQuestion ?? null,
      // The planning-time snapshot's named, actionable elements — carried
      // in the journal (never re-derived by the cockpit) so §8's
      // constrained plan editor can offer "add a step" a real
      // verb x target x value picker without a second perceive() call
      // racing the one the plan was actually built against.
      elements: snap.value.elements.filter((e) => e.actionable).map((e) => ({ handle: e.handle, role: e.role, name: e.name })),
    });
    return true;
  }

  /** §7's Suggest hold: no ActionRequest is issued until this resolves —
   *  Suggest's "perform no action until told to proceed" is this wait,
   *  full stop; every mode after this point is enforced identically by the
   *  gate (lib/policy/gate.ts's requiresApproval()). */
  private async awaitPlanApproval(): Promise<boolean> {
    this.planApproval = makeWaiter();
    const { approve, editedPlan } = await this.planApproval.promise;
    this.planApproval = null;
    if (this.stopped) return false;

    if (!approve) {
      await journal.append(this.runId, 'plan.rejected', this.tabId, {});
      const run = await db.runs.get(this.runId);
      if (run) {
        const t = transition(run.state, 'stopped');
        if (t.ok) await db.runs.update(this.runId, { state: t.value, outcome: 'stopped', endedAt: Date.now() });
      }
      return false;
    }

    if (editedPlan) {
      await journal.append(this.runId, 'plan.edited', this.tabId, { steps: editedPlan.steps.length });
      await db.runs.update(this.runId, { plan: editedPlan });
      this.planEditedSince = true;
    }
    const run = await db.runs.get(this.runId);
    await journal.append(this.runId, 'plan.approved', this.tabId, { steps: run?.plan?.steps.length ?? 0 });
    if (run) {
      const t = transition(run.state, 'running');
      if (t.ok) await db.runs.update(this.runId, { state: t.value });
    }
    return true;
  }

  private async act(): Promise<void> {
    this.phase = advancePhase(this.phase, 'act');

    for (;;) {
      if (this.stopped) return;
      const run = await db.runs.get(this.runId);
      if (!run || !run.plan) return;

      if (run.state === 'paused') { await this.blockUntil('pause'); if (this.stopped) return; continue; }
      if (run.state === 'taken_over') { await this.blockUntil('takeover'); if (this.stopped) return; continue; }

      const ctx: StepContext = {
        stepIndex: this.stepIndex, plan: run.plan, lastVerdict: this.lastVerdict,
        consecutiveUnconfirmed: this.consecutiveUnconfirmed, resolveError: null,
        urlChangedUnexpectedly: false,
        snapshot: { epochSuspect: this.tabAgent.currentSnapshot()?.epochSuspect ?? false },
        planEditedSince: this.planEditedSince, anomaly: false,
      };
      // run_start (trigger 1) already happened in planStep(); every later
      // check is evaluated here, once per step, before deriving the step.
      const trigger = shouldReplan(ctx);
      if (trigger && trigger !== 'run_start') {
        if (!(await this.replan(trigger))) return;
        continue;
      }

      const current = await db.runs.get(this.runId);
      const step: PlanStep | undefined = current?.plan?.steps[this.stepIndex];
      if (!step) { await this.finishFromJournal('completed'); return; }

      const outcome = await this.tabAgent.executeStep(step);
      const next = await this.handleOutcome(outcome, step);
      if (next === 'end') return;
      if (next === 'advance') { this.stepIndex += 1; this.planEditedSince = false; }
      // 'retry' loops again at the same stepIndex.
    }
  }

  private blockUntil(kind: 'pause' | 'takeover'): Promise<void> {
    const w = makeWaiter<void>();
    if (kind === 'pause') this.pauseWaiter = w; else this.takeOverWaiter = w;
    return w.promise;
  }

  private async handleOutcome(outcome: StepOutcome, step: PlanStep): Promise<'end' | 'advance' | 'retry'> {
    switch (outcome.kind) {
      case 'done': {
        this.lastVerdict = outcome.result.verified;
        if (outcome.result.verified === 'unconfirmed') {
          this.consecutiveUnconfirmed = this.lastStepIndexSeen === this.stepIndex ? this.consecutiveUnconfirmed + 1 : 1;
        } else {
          this.consecutiveUnconfirmed = 0;
        }
        this.lastStepIndexSeen = this.stepIndex;
        return 'advance';
      }

      case 'failed':
        await this.finishRun('failed', `The step "${step.intent}" failed: ${outcome.cause}.`);
        return 'end';

      case 'replan':
        return (await this.replan(outcome.trigger)) ? 'retry' : 'end';

      case 'budget':
        await this.finishFromJournal(outcome.cause === 'BUDGET_PLANNER' ? 'stuck' : 'completed_with_gaps', outcome.cause);
        return 'end';

      case 'refused':
        await this.finishRun('failed', `Refused: ${outcome.code}.`);
        return 'end';

      case 'stuck':
        await this.finishFromJournal('stuck');
        return 'end';

      case 'approval': {
        const { approve, reason } = await this.awaitActionApproval(outcome.req.requestId);
        if (this.stopped) return 'end';
        if (!approve) {
          await journal.append(this.runId, 'approval.denied', this.tabId, { requestId: outcome.req.requestId, reason: reason ?? null });
          // §12 milestone: a rejection does not end the run — it re-decides.
          return (await this.replan('unexpected_change')) ? 'retry' : 'end';
        }
        await journal.append(this.runId, 'approval.granted', this.tabId, { requestId: outcome.req.requestId });
        const redone = await this.tabAgent.performApproved(outcome.req, outcome.tier);
        return this.handleOutcome(redone, step);
      }

      case 'ask_user': {
        this.budget.pauseClock();
        const answer = await this.awaitAskUser();
        await this.budget.resumeClock();
        if (this.stopped) return 'end';
        await journal.append(this.runId, 'ask_user.answered', this.tabId, { answer });
        // [Phase 8 supplies profile facts and real use of the answer] this
        // phase records the answer and advances — it does not yet act on
        // it. An earlier version set planEditedSince here to force an
        // immediate replan "with the new information", but nothing carries
        // the answer INTO that replan call (priorPlanNoteFor has no
        // knowledge of it), so a planner that reproduces a similar plan
        // re-asks the identical question — an infinite loop with no error,
        // caught by tests/unit/pause-takeover-askuser.spec.ts. Replanning
        // belongs to the seven triggers (§4.3), which this is not one of;
        // 'ask_user' answered is simply a completed step.
        return 'advance';
      }

      case 'finish':
        await this.finishFromJournal(outcome.outcome);
        return 'end';
    }
  }

  private awaitActionApproval(requestId: string): Promise<{ approve: boolean; reason?: string }> {
    const w = makeWaiter<{ approve: boolean; reason?: string }>();
    this.actionApprovals.set(requestId, w);
    return w.promise.finally(() => this.actionApprovals.delete(requestId));
  }

  private awaitAskUser(): Promise<string> {
    const w = makeWaiter<string>();
    this.askUserWaiter = w;
    return w.promise;
  }

  /** One of the seven triggers fired. Re-invokes the planner (§4.3) — the
   *  mechanism BY WHICH the agent re-plans under uncertainty, not a retry
   *  of the failed action itself (§1: "not retried, not adapted around"). */
  private async replan(trigger: ReplanTrigger): Promise<boolean> {
    const draw = await this.budget.drawPlannerCall();
    if (!draw.ok) { await this.finishFromJournal('stuck', 'BUDGET_PLANNER'); return false; }

    const run = await db.runs.get(this.runId);
    if (!run) return false;
    const snap = await this.tabAgent.perceiveForPlanning();
    if (!snap.ok) { await this.finishRun('failed', 'Could not read the page to re-plan against.'); return false; }

    const result = await runPlanner({
      goal: this.admitted.goal, postureChoice: this.admitted.posture,
      snapshot: snap.value, policy: await this.plannerPolicy(run), runId: this.runId,
      priorPlanNote: priorPlanNoteFor(trigger, run.plan),
    });
    if (!result.ok) { await this.finishRun('failed', "Couldn't re-plan after a change on the page."); return false; }

    await db.runs.update(this.runId, { plan: result.value });
    await journal.append(this.runId, 'plan.replanned', this.tabId, { trigger, fromStepIndex: this.stepIndex });
    this.stepIndex = 0;
    this.consecutiveUnconfirmed = 0;
    this.planEditedSince = false;
    return true;
  }

  private async finishFromJournal(
    outcome: 'completed' | 'completed_with_gaps' | 'failed' | 'stuck', cause?: string,
  ): Promise<void> {
    const { text } = await summarize(this.runId);
    await this.finishRun(outcome, cause ? `${text}. ${cause}` : text);
  }

  private async finishRun(
    outcome: 'completed' | 'completed_with_gaps' | 'failed' | 'stuck' | 'stopped', summary: string,
  ): Promise<void> {
    const run = await db.runs.get(this.runId);
    if (run && !TERMINAL_STATES.has(run.state)) {
      const target: RunState = outcome === 'completed' || outcome === 'completed_with_gaps' ? 'completed' : 'failed';
      const t = transition(run.state, target);
      if (t.ok) await db.runs.update(this.runId, { state: t.value, outcome, endedAt: Date.now() });
    }
    await journal.append(this.runId, 'run.completed', this.tabId, { outcome, summary });
  }

  /** Runs whatever run() didn't already finish explicitly — Stop mid-loop,
   *  a closed tab, or any other fall-through — so a run is never left
   *  'running' forever (§3.1's "the run halts" ethos, applied to every
   *  early-return path above). */
  private async finalize(): Promise<void> {
    this.phase = 'end';
    const run = await db.runs.get(this.runId);
    if (!run || TERMINAL_STATES.has(run.state)) return;
    const outcome = this.tabClosed ? 'failed' : this.stopped ? 'stopped' : 'failed';
    const target: RunState = this.tabClosed ? 'failed' : this.stopped ? 'stopped' : 'failed';
    const t = transition(run.state, target);
    if (t.ok) await db.runs.update(this.runId, { state: t.value, outcome, endedAt: Date.now() });
    if (this.tabClosed) await journal.append(this.runId, 'run.interrupted', this.tabId, { reason: 'TAB_CLOSED' });
  }
}
