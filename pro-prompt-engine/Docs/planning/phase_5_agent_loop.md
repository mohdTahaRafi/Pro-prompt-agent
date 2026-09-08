# Phase 5 — The Agent Loop: Run Supervisor + One Tab Agent

**Document type:** Phase 5 execution document
**Architecture basis:** `architecture.md` §3.3.1 (end-to-end run), §3.7.11 (interrupted runs halt), §3.7.16 (reads fan out, writes serialize), §3.7.19 (authoritative Stop), §3.7.20 (trigger-based re-planning), §3.8
**PRD basis:** PR-PLAN-1…7, PR-AUT-1…4/6, PR-CTL-1…8, PR-APR-1…5, PR-UX-1…7, PR-REC-10, PR-SEC-12, J-1, J-5, J-6, SC-6
**Depends on:** Phases 1–4 in full

---

## 1. Objective

At the end of this phase the product **runs a multi-step task**. A Run Supervisor moves a run through `SURVEY → READ → SYNTHESISE → ACT → END`, driving exactly one Tab Agent, which loops observe → decide → request → verify for one tab. The run state machine is enforced in two processes from one persisted string. Plans are presented, editable, and approved before anything executes. The planner is invoked on seven triggers, not on every step. Budgets are shared, stuck detection works, goal anchoring refuses off-goal actions, and the side panel is the authoritative Stop.

The roster is size one. **The seam for more exists and is unused** — that is the whole reason the Supervisor/Tab-Agent split is made now rather than when multi-tab is needed (§3.7.16).

**By the end of this phase:** J-1 works. A user opens the side panel on a form, states *"Fill this from my details and stop before submitting"*, reads the plan, deletes a step, presses Start, and watches fourteen fields fill and verify one at a time, each with a green tick and the value that landed. At Submit the run holds and asks. The journal shows four planner calls across thirty actions, not thirty.

**No recovery, no honest reporting, no multi-tab, no CDP, no vision, no saved tasks.** A failed action ends the run with its `FailureCause` journaled and displayed — it is not retried, not adapted around, not asked about. Recovery is Phase 6, and this phase must be honest that a run which hits a bump stops. The end-of-run summary is a plain list of what the journal contains; the *report*, with its gaps and reason codes, is Phase 6.

---

## 2. What this phase builds on and what it deletes

| From | Consumed how |
|---|---|
| Phase 3 gate | Reserved check positions 5.5 (goal anchor) and 6.5 (budget) are **filled** here |
| Phase 3 `run-state.ts` | Now driven. The Supervisor transitions; the gate reads |
| Phase 3 `journal.ts` | Every phase transition, plan event, action and approval writes |
| Phase 3 `intent.ts` | **Deleted.** Phase 3 labelled it throwaway; the planner and step resolver replace it |
| Phase 4 `planner.ts` | Called on the seven triggers |
| Phase 4 `step-resolver.ts` | Called every step — the hot path |
| Phase 4 `posture.ts` | Called **once, at admission**, and stored on the run row so a mid-run engine change cannot alter the posture the user was shown |
| Phase 2 `settle.ts`, `registry.ts` | The Tab Agent waits and re-snapshots between steps |
| `entrypoints/toolbar.content.tsx` | **Deleted.** The side panel plus the in-page overlay replace it; with it goes the last `content_scripts` manifest entry, so the built manifest finally has no install-time host access at all |

---

## 3. Where the loop lives

**In the offscreen document.** An MV3 service worker is terminated on idle and a run is multi-minute; the offscreen document created with `reasons: ['WORKERS']` is not idle-terminated, already exists, and already hosts every inference engine. Running the loop next to the model also removes a message hop per inference — and Chrome's `LanguageModel` is unavailable in Web Workers, which is a second independent reason.

```
sidepanel/Cockpit.tsx ──port 'cockpit'──► background.ts (gate) ──{target:'agent'}──► offscreen/
        ▲                                        │                                    Supervisor
        └────────── journal subscription ────────┘                                    └► TabAgent
```

The Supervisor never touches a browser capability. It schedules. Every action it wants goes to the gate as an `ActionRequest` and comes back permitted or refused. It holds no handles — those belong to the Tab Agent — and it never calls `chrome.tabs`, `chrome.scripting` or `chrome.permissions`.

### 3.1 Offscreen bootstrap and the SW's statelessness

`offscreen/main.ts` gains a Supervisor registry keyed by `runId`. The service worker calls `ensureOffscreen()` before admitting a run and posts `RUN_ADMITTED`.

**The service worker is stateless and may be terminated between any two actions.** It re-derives everything from `runs` and `sitePolicy` on wake (§3.3.1 step 14). Nothing about a run lives only in the SW's memory: the ownership ledger is in `storage.session` (Phase 3 §4.4), the stop flag is in `storage.session`, and the run row is in IndexedDB.

**If the offscreen document is lost, the run halts.** On the next SW wake, `reconcileRuns()` finds any `runs` row in a non-terminal state whose Supervisor is not registered, journals `run.interrupted`, and transitions to `halted`.

```ts
// entrypoints/background.ts
async function reconcileRuns(): Promise<void> {
  const live = await db.runs.where('state').noneOf(TERMINAL_STATES).toArray();
  if (live.length === 0) return;
  await ensureOffscreen();
  const known = await askOffscreen({ type: 'LIST_RUNS' });      // returns runIds
  for (const run of live) {
    if (known.includes(run.id!)) continue;
    await journal.append(run.id!, 'run.interrupted', null,
      { atState: run.state, reason: 'AGENT_RUNTIME_LOST' });
    await db.runs.update(run.id!, { state: 'halted', endedAt: Date.now() });
  }
}
```

**A run is never automatically resumed** until the system can verify that the persisted state, page state, tab state, and element handles are still trustworthy — and after an interruption it cannot verify any of the four: every handle epoch is void and the tab may have navigated (§3.7.11). The user is shown what was completed and verified and may start a fresh run. Halting is worse UX and better behaviour.

---

## 4. The Run Supervisor

### 4.1 Phases

```ts
// lib/agent/supervisor.ts   [new]
type RunPhase = 'survey' | 'read' | 'synthesise' | 'act' | 'end';

class Supervisor {
  private phase: RunPhase = 'survey';
  private roster: TabRoster;                    // length 1 this phase
  private budget: Budget;                       // SHARED across the roster
  private agents = new Map<number, TabAgent>();
  private abort = new AbortController();

  async run(admitted: RunAdmitted): Promise<void> {
    try {
      await this.survey(admitted);              // roster construction
      await this.plan();                        // trigger 1
      await this.awaitPlanApproval();           // Suggest / Supervised hold here
      await this.act();                         // the step loop
    } finally {
      await this.end();                         // finish, journal, close opened tabs
    }
  }
}
```

`read` and `synthesise` exist as phases and, with a roster of one, collapse: the single Tab Agent reads on demand inside `act` rather than in a distinct fan-out phase. **The phase enum and its transitions are written now and exercised by `supervisor.spec.ts` against a synthetic two-agent roster**, so Phase 7 instantiates them rather than introducing them.

### 4.2 Budgets — per run, shared, never per tab

```ts
// lib/agent/budget.ts   [new]
export class Budget {
  constructor(private readonly limits: RunBudgets, private readonly runId: number) {}
  private actions = 0; private plannerCalls = 0;
  private retries = new Map<number, number>();          // stepN → count
  private repeats = new Map<string, number>();          // verb:handle:argsHash → count
  private readonly startedAt = Date.now();

  /** Every draw is against ONE pool. Three tabs at 40 each would be 120 (§3.7.16). */
  drawAction(): Result<void, 'BUDGET_ACTIONS' | 'BUDGET_WALLCLOCK'> {
    if (Date.now() - this.startedAt > this.limits.maxWallClockMs) return Err('BUDGET_WALLCLOCK');
    if (this.actions >= this.limits.maxActions) return Err('BUDGET_ACTIONS');
    this.actions += 1; return Ok(undefined);
  }

  drawPlannerCall(): Result<void, 'BUDGET_PLANNER'> {
    if (this.plannerCalls >= this.limits.maxPlannerCalls) return Err('BUDGET_PLANNER');
    this.plannerCalls += 1; return Ok(undefined);
  }

  /**
   * Stuck detection (PR-REC-9). Three identical (verb, handle, args) with
   * identical outcomes is *stuck*, which is distinct from *failed* — the
   * difference matters because a stuck run had no error to report.
   */
  noteOutcome(key: string, outcome: Verified): 'ok' | 'stuck' {
    const k = `${key}:${outcome}`;
    const n = (this.repeats.get(k) ?? 0) + 1;
    this.repeats.set(k, n);
    return n >= 3 ? 'stuck' : 'ok';
  }
}
```

| Limit | Value | Justification |
|---|---|---|
| `maxActions` | 40 | J-1 is 14 fields ≈ 30 actions with verification. 40 leaves headroom without letting a run become unsupervisable |
| `maxRetriesPerStep` | 3 | Two adaptations plus the original attempt. A fourth attempt at the same step has never been the thing that worked |
| `maxPlannerCalls` | 30 | A hard ceiling well above the ≤8 p50 / ≤20 p95 gauge (§3.8). Hitting 30 means the triggers are firing pathologically and the run should end rather than keep paying |
| `maxWallClockMs` | 720 000 (12 min) | Long enough for a real form-fill with settles and approvals; short enough that a wedged run cannot run for an hour. **Amended downward if Phase 1's Q8 spike measured offscreen survival below 90 %** |

The budget lives in the Supervisor and is **also** enforced at gate check 6.5, reading a counter mirrored into `storage.session` on every draw. Enforcing it only in the Supervisor would mean a wedged Supervisor could exceed it; the gate is where enforcement that must not be bypassable lives.

### 4.3 The seven re-planning triggers (§3.7.20)

Calling the planner once per action is the obvious design and it is unaffordable: 40 actions × 3–6 s is two to four minutes of pure inference inside a twelve-minute wall clock, on a key the user pays for. So the per-step hot path is `step-resolver.ts`, and the planner is re-invoked only when the next action is **not derivable**.

```ts
// lib/agent/replan.ts   [new]
export type ReplanTrigger =
  | 'run_start'              // 1
  | 'verification_failed'    // 2
  | 'two_unconfirmed'        // 3 — same step, consecutive
  | 'target_unresolvable'    // 4 — the plan step's descriptor fails to re-resolve
  | 'unexpected_change'      // 5 — URL change or large mutation burst the plan did not predict
  | 'user_edited_plan'       // 6
  | 'anomaly';               // 7 — e.g. a field count far below comparable pages

export function shouldReplan(ctx: StepContext): ReplanTrigger | null {
  if (ctx.stepIndex === 0 && !ctx.plan) return 'run_start';
  if (ctx.lastVerdict === 'failed') return 'verification_failed';
  if (ctx.consecutiveUnconfirmed >= 2) return 'two_unconfirmed';
  if (ctx.resolveError === 'TARGET_MISSING') return 'target_unresolvable';
  if (ctx.urlChangedUnexpectedly || ctx.snapshot.epochSuspect) return 'unexpected_change';
  if (ctx.planEditedSince) return 'user_edited_plan';
  if (ctx.anomaly) return 'anomaly';
  return null;   // derivable — execute the next plan step directly
}
```

**This does not weaken iterative planning (PR-PLAN-5).** The triggers *are* the mechanism by which the agent re-plans under uncertainty; what they remove is re-planning when there is no uncertainty. J-1 form fill is largely derivable and costs roughly three to six planner calls across about thirty actions. J-3 menu navigation is the opposite — *"the next screen is not knowable in advance"* is the journey's own description — so trigger 5 fires nearly every step and the run is planner-heavy. That is correct behaviour, and J-3 is short.

**Failure mode:** if triggers fire on more than half of steps for a journey the plan should have covered, the planner prompt is producing plans too vague to execute. That is a prompt defect surfaced by a budget line (§3.8: ≤ 20 planner calls p95) rather than a silent cost. `replan-trigger.spec.ts` asserts each of the seven fires on its own condition **and that nothing else does** — a trigger that fires spuriously is the same defect in a different place.

`anomaly` in this phase is one detector only: an extracted-field count more than 60 % below the median of the same region type across the corpus. Richer anomaly detection is Phase 6.

---

## 5. The Tab Agent

```ts
// lib/agent/tab-agent.ts   [new]
class TabAgent {
  constructor(
    private readonly runId: number,
    private readonly tabId: number,      // ONE tab. Never another.
    private readonly budget: Budget,     // the run's shared budget
  ) {}

  private snapshot: PerceptionSnapshot | null = null;
  private epoch = 0;
  private status: TabStatus['state'] = 'pending';

  async executeStep(step: PlanStep): Promise<StepOutcome> {
    // 1. OBSERVE — re-snapshot if the epoch is stale or suspect.
    if (!this.snapshot || this.snapshot.epochSuspect || this.stale) {
      const snap = await this.perceive();
      if (!snap.ok) return { kind: 'failed', cause: snap.error };
      this.snapshot = snap.value; this.epoch = snap.value.epoch;
      await ownership.record(this.runId, this.tabId, snap.value);   // the gate's ledger
    }

    // 2. DECIDE — judge tier only. The planner is NOT called here.
    const req = await resolveStep(step, this.snapshot, this.posture);
    if (!req.ok) return { kind: 'replan', trigger: 'target_unresolvable' };

    // 3. REQUEST — cross the boundary. The gate decides.
    const draw = this.budget.drawAction();
    if (!draw.ok) return { kind: 'budget', cause: draw.error };
    const decision = await requestAction({ ...req.value, runId: this.runId, tabId: this.tabId,
                                            epoch: this.epoch });

    if (decision.needsApproval) return { kind: 'approval', prompt: decision.prompt };
    if (!decision.permitted)    return { kind: 'refused', code: decision.refusal! };

    // 4. VERIFY — deterministic first (Phase 3 §7).
    const outcome = await performAndVerify(this.tabId, req.value, this.epoch);
    await journal.append(this.runId, 'action.observed', this.tabId, outcome);

    const stuck = this.budget.noteOutcome(actionKey(req.value), outcome.verified);
    if (stuck === 'stuck') return { kind: 'stuck' };

    this.stale = outcome.verified !== 'confirmed' || outcome.evidence?.check === 'location';
    return { kind: 'done', outcome };
  }
}
```

**A Tab Agent cannot name another tab's handles.** Its `tabId` is a constructor field, every request carries it, and there is no verb in the vocabulary that takes a tab argument (§3.3.2a). With a roster of one this is trivially true; the enforcement is at the gate (Phase 3 check 4) and is already tested against a synthetic two-tab ledger.

`this.stale` after a `location` verification is deliberate: a navigation invalidates every handle on the page, so the next step must re-snapshot even if the current epoch looks fine.

---

## 6. Goal anchoring

`lib/policy/goal-anchor.ts` fills gate check 5.5. Its job is PR-SEC-12 and PR-PLAN-6: an action inconsistent with the user's *original* stated goal is refused and surfaced.

```ts
export function anchorCheck(run: RunRecord, action: Action, target: LedgerDescriptor | null)
  : Result<void, 'OFF_GOAL'> {
  // 1. STRUCTURAL, and the load-bearing half: the action's origin must be in the
  //    run's scope. Already gate check 3 — restated here because scope creep is
  //    the most consequential form of going off-goal.

  // 2. The approved plan is the anchor, not the goal text. A permitted action
  //    must correspond to a step the user saw and approved, OR to a re-planned
  //    step produced by a trigger the journal records.
  const planned = run.plan?.steps.some(s => sameShape(s.action, action));
  if (planned) return Ok(undefined);
  const replanned = journalHasReplanSince(run.id!, action);
  if (replanned) return Ok(undefined);

  // 3. Verbs that can never be off-goal: perception changes nothing.
  if (PERCEPTION_VERBS.has(action.verb)) return Ok(undefined);

  return Err('OFF_GOAL');
}
```

**The anchor is the approved plan, not a semantic judgement of the goal text.** An earlier framing would have asked a model *"is this action consistent with 'fill this form'?"* — which puts the enforcement back inside the model's reach, exactly what PP-3 forbids. Anchoring to the plan the user approved is checkable without a model, and every legitimate deviation from it arrives through a journaled re-planning trigger, which is also checkable.

**What this does not catch:** a page that steers the *planner* into producing a plausible-looking but wrong plan. The user sees that plan before it runs, which is the defence, and `suspicion.ts` (Phase 6) is the layer aimed at it.

---

## 7. Autonomy modes

| Mode | Behaviour | Where enforced |
|---|---|---|
| **Suggest** (PR-AUT-2) | Plan and show it. Perform no action until told to proceed. Then behave as Supervised | Supervisor holds at `awaiting_plan_approval`; every step then follows Supervised |
| **Step** (PR-AUT-3) | Every action requires approval before it runs | Gate check 8: `requiresApproval(tier, mode)` returns true for **every** tier |
| **Supervised** (PR-AUT-4, default) | Act freely on Low, stop at every Always boundary. Medium follows site policy | Gate check 8: true for `always`, and for `medium` where `sitePolicy` says so |
| **Watch** | — | **[Phase 11.]** Schema-declared; the gate refuses `mode: 'watch'` with `RUN_STATE` |

Always-tier approval is required in **every** mode, without exception, and no mode dial weakens it (PR-SEC-2, PR-AUT-5). `tests/unit/modes.spec.ts` asserts this by exhaustion across all four modes.

The mode is selected per run and defaults from `sitePolicy.defaultMode` (PR-AUT-6 per-run; per-site defaults are the FUTURE half and are not built).

---

## 8. Plan presentation and editing

Plan events, all journaled: `plan.proposed` → `plan.edited` → `plan.approved` | `plan.rejected`.

The cockpit renders the plan as an ordered list with, per step: the plain-language `intent`, the verb and target name, the tier badge, and the `expectation`. Beneath it, the **What I will not do** list, always rendered even when empty.

Editing (PR-PLAN-4, PR-CTL-5) supports: remove a step, reorder steps, edit a step's plain-language intent, and add a step from a constrained builder — *verb* × *target chosen from the current snapshot's named elements* × *value*. **The user cannot type a free-form step**, because a free-form step would have to be re-parsed by a model into an action, which reintroduces exactly the ambiguity the handle model removes. The builder produces a valid `PlanStep` directly.

The edited plan is journaled **as the user's version** and is what `run.plan` stores. The report must be able to say "you removed step 7" and it can only do that if the original and the edit are both in the journal.

Editing sets `planEditedSince`, which fires trigger 6 on the next step — the planner is told the plan changed and re-derives the remainder. That is what stops an edit from producing a plan whose later steps assume a removed earlier one.

---

## 9. The cockpit

### 9.1 The side panel

`chrome.sidePanel` (Chrome 114+) is the only extension surface that survives page navigation *and* sits beside the page (§3.4). A run that navigates would destroy an in-page React tree and its state.

`entrypoints/sidepanel/Cockpit.tsx` renders, always visible: the goal; the posture and disclosure line; the plan with the current step highlighted; each completed step with its verdict and evidence; the tab roster (one row this phase); the budget as *actions used / 40* and elapsed time; and the control bar.

Controls (PR-CTL-1…8), every one reachable at all times while a run is active (PR-UX-4): **See** (the whole panel), **Pause**, **Approve/Reject**, **Reject with reason**, **Edit plan**, **Take over**, **Resume**, **Stop**.

The panel renders **from the journal and the run state, never from planner narration** (§3.2 ownership rules). It subscribes to `runEvents` for the run via a long-lived port and a Dexie `liveQuery`. If the planner said it would do something and the journal has no `action.observed` for it, the panel shows it as pending or failed — never as done.

### 9.2 The in-page overlay

`lib/page/overlay/` — a closed shadow root inside `agent.content.ts`, sharing the host `mount.ts` created in Phase 2 for snippets.

- `GoalBox.tsx` — in-page goal intake (PR-UX-1), so a user can start a run without leaving the page they are working on.
- `RunBadge.tsx` — the current step in one line, a highlight outline on the current target, and an always-present **Stop**.

Both use inline styles, not Tailwind: the shadow root should not carry a Tailwind bundle onto every granted page, and the content-script bundle budget is 80 KB gzipped (§3.8).

### 9.3 Stop ownership (§3.7.19)

Both surfaces show Stop. **Only the side panel owns it.** The in-page overlay is destroyed and recreated on every navigation, so during a run that navigates there is a window in which the in-page control does not exist — and a run that navigates is the normal case. The side panel survives navigation and tab switches, so it holds the authoritative control; the in-page button posts the same message and is a convenience.

Both write the same flag to `chrome.storage.session`, and the gate reads it on every action (§3.7.7). Neither surface is trusted to stop the run by itself.

**Failure mode:** if the side panel is closed mid-run, the run continues and the in-page mirror remains. If both are gone — panel closed and the tab navigating — the run is not uncontrollable: the budget and the wall clock still bound it, and reopening the panel reattaches to the live run from persisted state.

### 9.4 Take over and resume

**Take over** (PR-CTL-6) transitions the run to `taken_over`; `canAct` is false, so the gate refuses everything. The overlay switches to a quiet banner: *"You're driving. Press Resume when you're done."*

**Resume** (PR-CTL-7) **always re-snapshots first**, because the user may have changed the page. The epoch advances, the ownership ledger is replaced, and the next step is resolved against the new snapshot. Resuming against a stale epoch would be the exact confident-wrong-action failure the handle model exists to prevent.

---

## 10. `ask_user` and `finish`

The two control verbs, implemented here.

`ask_user` moves the run to `awaiting_user` **without burning wall-clock budget** — the budget clock pauses while the run waits on a human, because a user who took four minutes to answer has not made the agent slower. The question, its reason code, and the options are journaled.

The reason code is the measurement that answers Q9 — whether the eighteen-verb vocabulary is large enough — at near-zero cost and without argument (§3.3.2a):

| Reason | Fires when |
|---|---|
| `AMBIGUOUS_TARGET` | The resolver returned `TARGET_AMBIGUOUS` |
| `MISSING_CAPABILITY` | The goal needs something the vocabulary has no verb for — a file upload, a drag |
| `NEEDS_USER_DATA` | A field has no matching profile fact **[Phase 8 supplies profile facts; this phase always takes this path for unmatched fields]** |
| `SITE_BLOCKED` | **[Phase 6 — `SITE_REFUSED` detection]** |

`finish` ends the run with an outcome and a summary. **The summary is composed from the journal, not from the planner** (§3.7.5). In this phase it is a plain enumeration — *"12 actions, 11 confirmed, 1 unconfirmed"* — with the real report arriving in Phase 6.

---

## 11. Tasks & Acceptance Criteria

| # | Task | Acceptance Criteria |
|---|---|---|
| 5.1 | Implement `lib/agent/supervisor.ts` with the five-phase machine | `supervisor.spec.ts`: all legal phase transitions succeed and illegal ones throw; the phase machine drives a **synthetic two-agent roster** correctly even though production uses one |
| 5.2 | Implement `lib/agent/tab-roster.ts` with `TabStatus` | A roster of one reports `{tabId, origin, title, state, epoch, actionsDrawn, localRecoveries}`; `chrome.tabs.onRemoved` for the roster tab sets `failed:TAB_CLOSED` |
| 5.3 | Implement `lib/agent/budget.ts` — shared draws, wall clock, stuck detection | `budget.spec.ts`: the 41st action draw fails `BUDGET_ACTIONS`; a draw after 12 min fails `BUDGET_WALLCLOCK`; three identical verb+handle+args with identical outcomes returns `stuck`; two agents drawing from one Budget share the pool |
| 5.4 | Mirror budget counters into `storage.session`; fill gate check 6.5 | A Supervisor that ignores its own budget still cannot exceed it — a synthetic test bypasses `drawAction()` and the gate refuses at 41 |
| 5.5 | Implement `lib/agent/tab-agent.ts` — observe → decide → request → verify | `tab-agent.spec.ts`: a stale epoch triggers re-snapshot; a suspect epoch always re-snapshots; a `location` verdict marks the snapshot stale; every request carries this agent's `tabId` |
| 5.6 | Implement `lib/agent/replan.ts` — the seven triggers | `replan-trigger.spec.ts`: each trigger fires on its own condition **and nothing else does**; a derivable step invokes the planner zero times |
| 5.7 | Implement `lib/policy/goal-anchor.ts`; fill gate check 5.5 | An action matching an approved plan step passes; an unplanned mutating action returns `OFF_GOAL`; a perception verb always passes; the check makes **zero** model calls (asserted by the `lib/policy/**` import restriction from Phase 3) |
| 5.8 | Implement the three autonomy modes | `modes.spec.ts`: Step requires approval for every tier including Low; Supervised requires it for Always and for Medium where site policy says so; **Always-tier approval is required in every mode** across an exhaustive combination test; `mode: 'watch'` is refused |
| 5.9 | Implement plan presentation, the constrained editor, and the plan event chain | Removing step 4 and pressing Start journals `plan.proposed`, `plan.edited`, `plan.approved` with the user's version stored on the run row; free-form step text is not accepted anywhere in the UI |
| 5.10 | Build `entrypoints/sidepanel/` — Cockpit, port, live journal subscription | The panel opens beside the page, survives a full navigation with state intact, and renders every completed step's verdict; killing the planner mid-run leaves the panel showing the last journaled state, not a narration |
| 5.11 | Build the in-page overlay — GoalBox and RunBadge in the shared shadow root | Starting a run from the in-page GoalBox opens the side panel and admits the run; the RunBadge highlights the current target; the overlay is recreated after navigation |
| 5.12 | Implement authoritative Stop in the panel and the mirror in the overlay | `stop.spec.ts` extended: stop from the panel during a navigation (when the overlay does not exist) still halts within 250 ms; stop from the overlay halts identically; zero actions after either |
| 5.13 | Implement Pause, Take over, Resume | Pause refuses every action with `RUN_STATE`; Take over does the same and shows the driving banner; Resume re-snapshots **before** the next step, and the journal shows the epoch advancing |
| 5.14 | Implement `ask_user` and `finish` | `ask_user` moves to `awaiting_user`, pauses the wall clock, and journals its reason code; answering resumes; `finish` writes `run.completed` with an outcome derived from journal counts |
| 5.15 | Implement `reconcileRuns()` — interrupted runs halt | Closing the offscreen document mid-run and waking the SW journals `run.interrupted` and sets `halted`; the run is **not** resumed; the panel shows what completed |
| 5.16 | Delete `entrypoints/toolbar.content.tsx` and `lib/agent/intent.ts` | `grep -rn 'toolbar\|intent.ts' entrypoints lib` returns nothing; the built `manifest.json` has **no `content_scripts` key at all**; `no-all-urls.spec.ts` is strengthened to assert exactly that |
| 5.17 | J-1 end-to-end | `form-fill.spec.ts`: a 14-field fixture form completes with ≥ 12 fields confirmed, Submit held for approval, and ≤ 8 planner calls journaled |
| 5.18 | Performance validation | Every §13 row met |

---

## 12. Milestone Definition

Phase 5 is **complete** when:

> A user is on a job application form on a site they granted earlier. They click Pro Prompt's in-page button, type *"Fill this in from my details and stop before submitting"*, and the side panel opens beside the page. It reads: **Local-only — everything in this run stays on your machine. Planning runs on Ollama (qwen2.5:14b).** Six seconds later a plan appears — eleven steps, each naming a field and what it expects afterwards — followed by **What I will not do:** *"I will not attach your CV — the form needs a file and I have no way to provide one"* and *"I will not press Submit — you asked me to stop before that."* The user deletes step 9 ("Fill 'How did you hear about us?'") because they want to write it themselves, and presses **Start**. The panel's step list begins ticking: *Full name → "Mohd Taha" ✓ confirmed*, *Email → "taharafi05@gmail.com" ✓ confirmed*, *Phone → ✓ confirmed*. On the page itself a thin outline moves from field to field and a small badge reads *step 4 of 10*. At step 7 the panel shows *Country — unconfirmed: the page gave no readable value after selection* in amber rather than green, and moves on. The budget line reads *18 of 40 actions · 2:14 elapsed*. The user switches to another tab to check something; the panel stays, still updating. They come back. At step 10 everything stops and the panel says: **Click "Submit application" — on careers.example.com — I think this submits your application. It is likely irreversible and visible to the site's owner.** They press **Reject**. The run does not end; it re-decides, concludes the goal is met, and finishes: *Completed with gaps — 9 fields confirmed, 1 unconfirmed, 1 skipped at your request, 1 needs a file only you can attach.* They open the journal: 34 rows, and exactly **4** of them are `plan.*` or `inference` rows for the planner tier — the other thirty actions were resolved on the judge tier or deterministically. They press Stop on a second run mid-way through and it freezes instantly, with the last row in the journal timestamped 180 ms after the press. They close the browser mid-run on a third, reopen it, and the panel shows: **This run was interrupted and has been halted. 6 of 11 steps completed and verified. Start a new run to continue.** — it does not pick up where it left off, because it cannot know the page is still what it was.

---

## 13. Performance Validation

| Metric | How to Measure | Target |
|---|---|---|
| Planner calls per run | J-1 and J-5 over 20 runs | ≤ 8 p50, ≤ 20 p95, hard cap 30 (§3.8) |
| Step resolution, judge tier | Same runs | ≤ 1.2 s p95 |
| Deterministic step resolutions | Same runs | Recorded; expected ≥ 70 % |
| Action → verified outcome | Same runs, deterministic path | ≤ 1.5 s p95 |
| Stop flag visible to the gate | `stop.spec.ts` | ≤ 250 ms; **0** actions after |
| Unapproved Always-tier actions | `never-tier.spec.ts` + `form-fill.spec.ts` | **0** — hard gate |
| Report claims absent from the journal | `journal.spec.ts` over a synthetic journal | **0** — hard gate |
| Agent-runtime state memory | Heap snapshot after a 40-action run | ≤ 8 MB |
| Side panel bundle | CI gzip check, excluding WebLLM | ≤ 400 KB gzipped |
| Content-script bundle | CI gzip check | ≤ 80 KB gzipped (overlay added) |
| Cold SW wake → gate decision | 30 samples mid-run | ≤ 300 ms p95 |

---

## 14. Files to Create

```
entrypoints/
├── sidepanel/{index.html, main.tsx, Cockpit.tsx}   # [new]
├── toolbar.content.tsx                             # [DELETE]
├── agent.content.ts                                # [modify] overlay mount
├── background.ts                                   # [modify] admission, reconcileRuns, port
└── offscreen/main.ts                               # [modify] Supervisor registry
lib/agent/
├── supervisor.ts   # [new] phases, roster, shared budget, cancellation
├── tab-agent.ts    # [new] observe → decide → request → verify, ONE tab
├── tab-roster.ts   # [new] TabStatus, onRemoved
├── budget.ts       # [new] shared draws, wall clock, stuck detection
├── replan.ts       # [new] the seven triggers
├── intent.ts       # [DELETE]
└── reporter.ts     # [new, minimal] journal → summary. Full report is Phase 6
lib/policy/goal-anchor.ts   # [fill]
lib/page/overlay/{GoalBox.tsx, RunBadge.tsx}   # [new]
tests/unit/{supervisor,tab-agent,budget,replan-trigger,goal-anchor,modes,
            plan-edit,reconcile}.spec.ts
tests/e2e/{form-fill,stop,takeover,interrupted}.spec.ts
tests/e2e/fixtures/{application-form.html, navigating-form.html}
```

---

## 15. Estimated Complexity

| Component | New LOC | Files |
|---|---|---|
| `supervisor.ts` | ~380 | 1 |
| `tab-agent.ts` | ~300 | 1 |
| `tab-roster.ts` + `budget.ts` + `replan.ts` | ~330 | 3 |
| `goal-anchor.ts` | ~110 | 1 |
| `reporter.ts` (minimal) | ~120 | 1 |
| Side panel + Cockpit | ~740 | 3 |
| Overlay (GoalBox, RunBadge, mount changes) | ~330 | 3 |
| Background admission, ports, reconciliation | ~260 | 1 |
| Offscreen Supervisor registry | ~140 | 1 |
| Unit suites | ~980 | 8 |
| e2e + fixtures | ~620 | 6 |
| **Total** | **~4,310** | **29** |

Deleted: `toolbar.content.tsx` (433 LOC), `intent.ts` (~160 LOC). New runtime dependencies: **0**.

---

## 16. Forward Dependencies Declared Here

- `TabRoster` is length-capped at 1 by a constant. **[Phase 7 raises the cap to 8 and adds `open_tab`.]**
- `RunPhase` includes `read` and `synthesise`, which collapse at roster size 1. **[Phase 7 makes them distinct, with bounded fan-out.]**
- `PlanStep.tabHint` is unused. **[Phase 7.]**
- A `FailureCause` ends the run. **[Phase 6 adds the recovery table, overlay dismissal, and adaptation.]**
- `ask_user` reason `SITE_BLOCKED` is never produced. **[Phase 6 adds `SITE_REFUSED` detection.]**
- `NEEDS_USER_DATA` fires for every unmatched field because there are no profile facts yet. **[Phase 8 supplies them and adds attribution.]**
- `reporter.ts` produces a count summary, not a report. **[Phase 6 produces the real one, grouped and gap-aware.]**
- `suspicion.ts` is still the Phase 3 stub returning `allow`. **[Phase 6.]**
- The in-page overlay plus side panel split is barely stressed by a single-tab run. **[Q7 is answered in Phase 7, where "where is it doing this?" becomes a real question.]**
