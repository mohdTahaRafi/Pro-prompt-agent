/**
 * Budget — one pool per run, shared across the whole roster, never per tab.
 * Docs/planning/phase_5_agent_loop.md §4.2.
 *
 * Lives in the Supervisor (offscreen document) and is mirrored into
 * chrome.storage.session on every draw so lib/policy/gate.ts's check 6.5 can
 * refuse independently of whether the Supervisor itself is well-behaved
 * (task 5.4) — a wedged or compromised Supervisor cannot exceed the budget
 * just because it stopped calling drawAction() honestly.
 *
 * The wall clock excludes time spent in `awaiting_user` (§10): a user who
 * took four minutes to answer an ask_user question has not made the agent
 * slower, so pauseClock()/resumeClock() accumulate paused time and subtract
 * it from the elapsed-time check.
 */
import { Ok, Err, type Result } from '@lib/utils/result';
import type { RunBudgets } from '@lib/types/run.types';
import type { Verified } from '@lib/types/agent.types';

export type BudgetError = 'BUDGET_ACTIONS' | 'BUDGET_WALLCLOCK' | 'BUDGET_PLANNER';

/** The counters mirrored into chrome.storage.session — the shape gate.ts's
 *  check 6.5 reads back, independent of the Supervisor's own bookkeeping. */
export interface BudgetSnapshot {
  actions: number;
  plannerCalls: number;
  startedAt: number;
  pausedMs: number;
  limits: RunBudgets;
}

const key = (runId: number) => `budget:${runId}`;

/** Read-side: gate check 6.5 calls this against the mirrored snapshot,
 *  never against a live Budget instance (the gate runs in a different
 *  process — Phase 3 §3.7.1). */
export async function readMirror(runId: number): Promise<BudgetSnapshot | null> {
  const store = (await chrome.storage.session.get(key(runId)))[key(runId)] as BudgetSnapshot | undefined;
  return store ?? null;
}

/** Independent of any Budget instance's own draw counting — the same check
 *  drawAction() runs, applied to the mirrored snapshot, so a Supervisor
 *  that skips its own drawAction() call still cannot pass the gate. */
export function checkMirror(snap: BudgetSnapshot, now = Date.now()): Result<void, BudgetError> {
  const elapsed = now - snap.startedAt - snap.pausedMs;
  if (elapsed > snap.limits.maxWallClockMs) return Err('BUDGET_WALLCLOCK');
  if (snap.actions >= snap.limits.maxActions) return Err('BUDGET_ACTIONS');
  return Ok(undefined);
}

export type StuckOutcome = 'ok' | 'stuck';

export class Budget {
  private actions = 0;
  private plannerCalls = 0;
  private readonly retries = new Map<number, number>();          // stepN → count
  private readonly repeats = new Map<string, number>();          // verb:handle:argsHash:outcome → count
  private readonly startedAt: number;
  private pausedMs = 0;
  private pauseStartedAt: number | null = null;

  constructor(private readonly limits: RunBudgets, private readonly runId: number, startedAt = Date.now()) {
    this.startedAt = startedAt;
  }

  private elapsedMs(now = Date.now()): number {
    const activePause = this.pauseStartedAt !== null ? now - this.pauseStartedAt : 0;
    return now - this.startedAt - this.pausedMs - activePause;
  }

  private async mirror(): Promise<void> {
    const snap: BudgetSnapshot = {
      actions: this.actions, plannerCalls: this.plannerCalls,
      startedAt: this.startedAt, pausedMs: this.pausedMs + (this.pauseStartedAt !== null ? Date.now() - this.pauseStartedAt : 0),
      limits: this.limits,
    };
    await chrome.storage.session.set({ [key(this.runId)]: snap });
  }

  /** Every draw is against ONE pool. Three tabs at 40 each would be 120
   *  (§3.7.16) — there is no per-tab counter anywhere in this class. */
  async drawAction(): Promise<Result<void, BudgetError>> {
    if (this.elapsedMs() > this.limits.maxWallClockMs) return Err('BUDGET_WALLCLOCK');
    if (this.actions >= this.limits.maxActions) return Err('BUDGET_ACTIONS');
    this.actions += 1;
    await this.mirror();
    return Ok(undefined);
  }

  async drawPlannerCall(): Promise<Result<void, BudgetError>> {
    if (this.plannerCalls >= this.limits.maxPlannerCalls) return Err('BUDGET_PLANNER');
    this.plannerCalls += 1;
    await this.mirror();
    return Ok(undefined);
  }

  /** ask_user (§10) — the wall clock pauses while the run waits on a human. */
  pauseClock(): void {
    if (this.pauseStartedAt === null) this.pauseStartedAt = Date.now();
  }

  async resumeClock(): Promise<void> {
    if (this.pauseStartedAt !== null) {
      this.pausedMs += Date.now() - this.pauseStartedAt;
      this.pauseStartedAt = null;
      await this.mirror();
    }
  }

  noteRetry(stepN: number): number {
    const n = (this.retries.get(stepN) ?? 0) + 1;
    this.retries.set(stepN, n);
    return n;
  }

  retriesFor(stepN: number): number {
    return this.retries.get(stepN) ?? 0;
  }

  /**
   * Stuck detection (PR-REC-9). Three identical (verb, handle, args) with
   * identical outcomes is *stuck*, distinct from *failed* — a stuck run had
   * no error to report, just the same thing happening over and over.
   */
  noteOutcome(actionKey: string, outcome: Verified): StuckOutcome {
    const k = `${actionKey}:${outcome}`;
    const n = (this.repeats.get(k) ?? 0) + 1;
    this.repeats.set(k, n);
    return n >= 3 ? 'stuck' : 'ok';
  }

  actionsUsed(): number { return this.actions; }
  plannerCallsUsed(): number { return this.plannerCalls; }
  elapsedMsNow(): number { return this.elapsedMs(); }
  limitsOf(): RunBudgets { return this.limits; }
}

/** A stable key for stuck detection and approval-prompt de-duplication — the
 *  same (verb, handle, args) shape every time, independent of requestId. */
export function actionKey(action: { verb: string } & Record<string, unknown>): string {
  const { verb, ...rest } = action;
  const handle = (rest as { handle?: string }).handle ?? '';
  const args = Object.keys(rest).filter((k) => k !== 'handle').sort()
    .map((k) => `${k}=${JSON.stringify((rest as Record<string, unknown>)[k])}`).join(',');
  return `${verb}:${handle}:${args}`;
}
