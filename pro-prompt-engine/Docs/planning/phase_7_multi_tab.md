# Phase 7 — Multi-Tab: Roster, Bounded Fan-Out & Aggregation

**Document type:** Phase 7 execution document
**Architecture basis:** `architecture.md` §3.3.1b (J-4 across three tabs), §3.3.2e (`TabStatus`), §3.7.3 (background calibration), §3.7.16 (reads fan out, writes serialize), §3.7.17 (handle isolation), §3.7.18 (no `tabs` permission), §3.8, §3.11 Q7/Q14/Q15
**PRD basis:** PR-NAV-4, PR-NAV-5, PR-NAV-6, PR-SEC-8, PR-SEC-13, PR-UX-3/4, J-4, OQ-2
**Depends on:** Phases 1–6 in full

---

## 1. Objective

At the end of this phase a run spans **up to eight tabs**. The Supervisor enumerates candidate tabs through host permissions alone — no `tabs` permission is declared, even now — builds a roster the user confirms, dispatches reads concurrently at a bounded width of four, and aggregates by reading the journal filtered by `tabId` rather than by trusting what any Tab Agent reported about itself. Writes remain strictly serial with strictly serial approvals. A tab that fails keeps its partial journal and does not disturb the others. `open_tab` becomes the nineteenth callable verb. Background tabs use their own settle calibration, measured here rather than assumed.

Everything structural for this landed in Phase 5. **This phase is an instantiation, not a migration** — which is the entire reason the Supervisor/Tab-Agent split was made when the roster was one (§3.7.16).

**By the end of this phase:** J-4 works in full. Three monitor pages, read concurrently; one page's spec table collapsed and recovered inside its own Tab Agent without touching the other two; a comparison table where three of twenty-four cells are unknown and each names the tab and URL it was missing from.

**No CDP, no vision, no unattended execution.** Writes across tabs are supported and serial; nothing in this phase makes an unattended multi-tab run possible.

---

## 2. What changes, and what deliberately does not

| Component | Phase 5–6 state | Phase 7 |
|---|---|---|
| `tab-roster.ts` | `MAX_ROSTER = 1` | `MAX_ROSTER = 8`, with survey, confirmation, and `onRemoved` handling |
| `supervisor.ts` | `read`/`synthesise` collapse into `act` | Distinct phases; `read` fans out at width 4; `synthesise` aggregates |
| `budget.ts` | Shared pool, one drawer | **Unchanged.** It was written shared from the start |
| `gate.ts` | Eight checks, ownership tested against a synthetic two-tab ledger | **Unchanged.** The cross-tab refusal path now executes in production |
| `ownership.ts` | Per-tab ledger, one tab | **Unchanged** |
| `reporter.ts` | Groups by step, `tabId` populated but not rendered | Groups by tab; per-tab traceability rendered |
| `settle.ts` | Hidden constants are starting values | **Calibrated** (Q15) |
| `open_tab` | Schema-declared, gate-refused | Implemented |
| `wxt.config.ts` permissions | `storage, scripting, offscreen, sidePanel, activeTab` | **Unchanged.** No `tabs` permission is added (§3.7.18) |

The short list of unchanged files is the point. If Phase 7 had required changes to the gate, the budget or the ownership ledger, the Phase 5 split would not have earned its ~600 lines.

---

## 3. Roster construction (SURVEY)

### 3.1 Enumeration without the `tabs` permission

Enumerating and identifying tabs looks like it requires `tabs`, which presents to users as *"read your browsing history"* — exactly the kind of ask R-4 warns about. It does not. Host permissions allow an extension to read a matching tab's four sensitive `tabs.Tab` properties: `url`, `pendingUrl`, `title` and `favIconUrl`.

Because host access is already granted per origin at runtime (§3.7.8), `chrome.tabs.query({})` returns identifying information for **exactly the tabs the user has granted and no others**. Tabs outside the grant are not merely off-limits — they come back with `url` and `title` undefined, so they are invisible.

```ts
// lib/agent/tab-roster.ts
export async function survey(): Promise<CandidateTab[]> {
  const tabs = await chrome.tabs.query({});          // no `tabs` permission declared
  const out: CandidateTab[] = [];
  for (const t of tabs) {
    // A tab whose url is undefined is one we have no host permission for.
    // We cannot see it, and that is the intended outcome — not an error to log.
    if (!t.id || !t.url) continue;
    const origin = toOrigin(t.url);
    if (!origin || !(await isGranted(origin))) continue;
    out.push({ tabId: t.id, origin, title: t.title ?? origin,
               favIconUrl: t.favIconUrl, windowId: t.windowId, active: t.active });
  }
  return out;
}
```

**This closes PR-SEC-8 by narrowing rather than by declaring more**, and it means the permission story does not get worse when multi-tab arrives — the extension asks for strictly less than it did in Phase 0, while doing strictly more.

### 3.2 Confirmation and the cap

The user confirms the roster before the run starts. The cockpit lists candidates with favicon, title and origin, pre-selecting tabs whose origin matches the goal's stated subject where one is inferable, and otherwise pre-selecting only the active tab.

```ts
export const MAX_ROSTER = 8;      // §3.8: the cockpit must show every tab at a glance
export const FANOUT_WIDTH = 4;    // §3.8: 4 × 96 KB transient clone traffic
```

Both are **reasoned starting values, not measured ones** (Q14). Four concurrent snapshots is roughly 4 × 96 KB of transient structured-clone traffic with four pages traversing their DOM at once; eight is where a roster stops fitting in a cockpit at a glance. Whether memory or supervisability binds first is what §9.2 measures.

Selecting a ninth tab is refused in the UI with the reason stated — *"A run can cover at most 8 tabs, so you can still see what it's doing everywhere at once."* — not silently truncated.

`run.roster` and `run.scope` are written at admission. `run.scope` is the union of the roster's origins, and the gate still resolves origin **per tab from that tab's current URL** (Phase 3 check 3), never from this union. That distinction is the difference between a run granted two origins and a tab on origin A being able to act with origin B's scope.

### 3.3 `open_tab`

The nineteenth verb, Medium tier, permitted only from Phase 7.

```ts
case 'open_tab': {
  if (roster.size >= MAX_ROSTER) return Err('ROSTER_FULL');
  const origin = toOrigin(action.url);
  if (!origin || !run.scope.includes(origin)) return Err('OUT_OF_SCOPE');
  if (!(await isGranted(origin)))              return Err('OUT_OF_SCOPE');
  const tab = await chrome.tabs.create({ url: action.url, active: false });
  roster.add(tab.id!, origin, { openedByRun: true });   // ← the flag PR-NAV-6 turns on
  await journal.append(runId, 'tab.opened', tab.id!, { url: action.url });
}
```

**The agent never closes a tab it did not itself open (PR-NAV-6).** `openedByRun` is set only here, and `Supervisor.end()` closes exactly the tabs carrying it. A tab the user had open before the run, or opened during it, is left alone whatever the outcome. There is no `close_tab` verb, so the model cannot express the request at all — the closing is a Supervisor housekeeping action, not a decision.

`open_tab` opens **inactive** (`active: false`). A run that steals focus while the user is reading something else is a run they will stop.

### 3.4 Tabs that disappear

```ts
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const run of liveRuns()) {
    if (!run.roster.includes(tabId)) continue;
    supervisorFor(run.id).failTab(tabId, 'TAB_CLOSED');
  }
});
```

That Tab Agent moves to `failed` with `failureCause: 'TAB_CLOSED'`, keeps its partial journal, and **the run continues on the remainder**. The tab is never reopened — reopening a tab the user closed is the agent overriding a direct action by the user.

`chrome.tabs.onUpdated` is also watched: a roster tab navigating to an origin outside `run.scope` fails that Tab Agent with `OUT_OF_SCOPE` rather than following it. Origin drift on a roster tab is also a `suspicion.ts` signal (Phase 6 §5).

---

## 4. READ — bounded fan-out

```ts
// lib/agent/supervisor.ts
private async read(): Promise<void> {
  this.phase = 'read';
  await journal.append(this.runId, 'phase.read', null, { tabs: this.roster.ids() });

  const queue = [...this.roster.ids()];
  const inFlight = new Set<Promise<void>>();

  while (queue.length || inFlight.size) {
    while (inFlight.size < FANOUT_WIDTH && queue.length) {
      const tabId = queue.shift()!;
      const p = this.readOne(tabId).finally(() => inFlight.delete(p));
      inFlight.add(p);
    }
    await Promise.race(inFlight);
    if (this.abort.signal.aborted) break;      // Stop drains, it does not wait
  }
}

private async readOne(tabId: number): Promise<void> {
  const agent = this.agents.get(tabId)!;
  try {
    await agent.readPhase();                    // perceive → extract → local recovery
  } catch (e) {
    // A thrown error here is a bug, not a failure mode — failures come back as
    // Result. Fail the tab, keep its journal, and let the run continue.
    this.roster.fail(tabId, 'INTERNAL');
    await journal.append(this.runId, 'tab.failed', tabId, { cause: 'INTERNAL' });
  }
}
```

**Reads fan out because they are idempotent and cheap to redo. Writes serialize because consent is not.** Three constraints force it, and any one would be sufficient (§3.7.16):

1. **Consent.** Concurrent approval requests from three tabs are unsupervisable. One at a time is the only meaningful consent model.
2. **The platform.** `captureVisibleTab` captures only the active tab of a window; CDP trusted input targets a focused tab; occlusion checks and `scrollIntoView` are meaningful only where the user could see them. Only one tab per window is active at a time.
3. **Timing.** Background tabs run under clamped timers (§5), so a write whose verification depends on a settle measurement is less reliable in a hidden tab than in a visible one.

### 4.1 Local recovery stays local

A Tab Agent's recovery (Phase 6) runs entirely inside that agent. J-4's collapsed spec table is recovered by Tab Agent 3 clicking the toggle, waiting for settle, and re-extracting — and the Supervisor never hears about it beyond a `localRecoveries` increment.

Had local recovery been exhausted, Tab Agent 3 would enter `failed` with its partial journal intact while tabs 1 and 2 kept their results. **A failure in one tab never aborts the others, and never silently omits them** — the report names which tab failed and at what point.

### 4.2 Budget draws under concurrency

Four agents drawing from one `Budget` concurrently is the one genuinely new concurrency question in this phase, and it has a boring answer: the Supervisor and every Tab Agent run in **one JavaScript context** — the offscreen document — on one event loop. `drawAction()` is synchronous and cannot interleave. There is no lock because there is no preemption.

What *can* interleave is the `await` between a successful draw and the gate call. So a draw is **committed at draw time, not at gate time**, and a refused action returns its draw:

```ts
const draw = this.budget.drawAction();
if (!draw.ok) return { kind: 'budget', cause: draw.error };
const decision = await requestAction(req);
if (!decision.permitted && decision.refusal !== 'STOPPED') this.budget.returnAction();
```

A refusal that was the gate correctly stopping something should not consume the user's budget; a `STOPPED` refusal does not return the draw because the run is over anyway.

---

## 5. Background-tab settle calibration (Q15)

Chrome clamps timers in hidden tabs — sub-100 ms becomes 500 ms, sub-1 s becomes 2 s — and applies intensive throttling to roughly one check per minute after five minutes hidden. Phase 2 shipped 1,000 ms / 15 s as *starting values*. This phase measures them.

**Method.** A fixture page emits a known mutation pattern — a burst, then quiet at a controlled interval — and records, from inside the page, when quiet actually began. The detector runs in that tab, foreground and background, at 200/400/700/1,000/1,500 ms quiet windows, 20 runs each. Measured: the error between detected settle and true settle, and the false-settle rate (declaring settle while mutations are still arriving).

**The question behind the numbers is larger than the numbers**, and §3.11 Q15 states it: is some verification unreliable enough in a hidden tab that the Supervisor should **focus each tab in turn before acting** — trading wall-clock time for reliability, and making the fan-out narrower in practice than Q14 assumes?

Decision rule, written before the measurement:

| Measured false-settle rate in a background tab, at the best window | Consequence |
|---|---|
| < 2 % | Background calibration stands. Writes may proceed in a background tab |
| 2–10 % | Calibration stands for **reads**; **writes require the tab to be focused first**. `Supervisor.act()` calls `chrome.tabs.update(tabId, {active: true})` before each write and restores the user's original active tab at run end |
| > 10 % | Background settle is not trustworthy. Reads in background tabs are marked `settled: false` unconditionally, which downgrades their verifications to `unconfirmed`, and writes always focus first |

Whatever the outcome, `SettleResult.calibration` is journaled and the report distinguishes a hidden-tab read from a visible one — so a user reading *"could not confirm"* can see it happened in a tab that was in the background.

---

## 6. SYNTHESISE — aggregation from the journal

```ts
private async synthesise(): Promise<Aggregate> {
  this.phase = 'synthesise';
  // Read the JOURNAL, filtered by tabId. NOT the TabStatus records, and NOT
  // anything a Tab Agent reported about itself (§3.3.1b step 5). This is what
  // produces per-tab traceability rather than per-tab assertion.
  const events = await db.runEvents.where('runId').equals(this.runId).sortBy('seq');
  const byTab = groupBy(events.filter(e => e.tabId !== null), e => e.tabId!);

  const cells: AggregateCell[] = [];
  for (const [tabId, tabEvents] of byTab) {
    const url = lastKnownUrl(tabEvents);
    for (const field of this.requestedFields) {
      const found = findTracedValue(tabEvents, field);      // Phase 6 traceability
      cells.push(found
        ? { tabId, url, field, value: found.value, evidence: found.eventSeq }
        : { tabId, url, field, value: null,
            why: whyMissing(tabEvents, field) });           // "region not present",
    }                                                        // "read but empty",
  }                                                          // "tab failed at step 3"
  return { cells, failedTabs: this.roster.failed() };
}
```

`runEvents.tabId` was indexed from Dexie v2 in Phase 1 precisely so this query is an index scan rather than a full-table filter. That is why the index was added four phases before anything wrote a non-null value.

**`whyMissing` is the load-bearing function.** A null cell with no reason is a gap the report cannot explain, and J-4's requirement is that three of twenty-four unknowns each name the tab and URL they were missing from. It reads the tab's event stream and returns one of: *"the specification section was not present on this page"*, *"the section was read but the row was empty"*, *"this tab failed before this field was reached"*, or *"the value found could not be traced to text I actually read"*.

---

## 7. ACT — serial writes, serial approvals

```ts
private async act(): Promise<void> {
  this.phase = 'act';
  for (const tabId of this.roster.actableIds()) {      // ONE at a time. Always.
    const agent = this.agents.get(tabId)!;
    if (this.focusBeforeWrite) await chrome.tabs.update(tabId, { active: true });
    await agent.actPhase();                             // may hold at awaiting_approval
    if (this.abort.signal.aborted) return;
  }
}
```

**Concurrent approval requests are never issued.** The single pending-approval slot in `storage.session` (Phase 3 §9) is per run, not per tab, and the run state is `awaiting_approval` for the whole run while one is outstanding — so `canAct` is false everywhere. A three-tab run cannot triple the prompt count, which is what keeps approval fatigue from getting worse as the roster grows (§3.9).

---

## 8. Cross-tab isolation

The security property this phase must not break, and the reason `tests/e2e/cross-tab.spec.ts` is a hard gate.

Each Tab Agent owns exactly one tab's snapshot, epoch, handle namespace and local recovery state. A handle allocated in tab 2's registry, presented on a request naming tab 1, is refused `HANDLE_NOT_OWNED` at gate check 4 — **before any backend is consulted**.

**Why this is a security property and not tidiness.** Cross-tab targeting is the natural escalation for a prompt-injection payload: content on tab 3 that can influence an action on tab 1 escapes the origin grant that made tab 3 safe to read. Under this design that attack has nothing to express — a Tab Agent reading tab 3 has never held a tab-1 handle, and the vocabulary contains no verb that takes a tab argument (§3.3.2a).

Three tab verbs were considered and rejected, and the reasons are worth restating because Phase 7 is where someone would be tempted to add them:

- **`close_tab`**: PR-NAV-6 makes closing a prohibition rather than an approval gate, so the Supervisor closes only tabs it opened and the model never expresses it.
- **`focus_tab` / `switch_tab`**: tab selection is a Supervisor scheduling concern, and exposing it would let page content influence which tab receives attention — a cross-tab steering vector for no capability gain. The focusing in §5 and §7 is done *by the Supervisor*, not by a verb.
- **Tab-scoped variants** of `read_page`, `click` and the rest: a Tab Agent's verbs are implicitly scoped to its own tab, and adding a `tabId` argument would make cross-tab addressing *expressible* — exactly what §3.7.17 forbids.

`cross-tab.spec.ts` drives a two-tab run and asserts: a handle string from tab B submitted on a request naming tab A is refused `HANDLE_NOT_OWNED`; the refusal is journaled; no backend call is made; and a `grep` of the built bundle finds no verb schema carrying a `tabId` argument.

---

## 9. The cockpit under multi-tab (Q7)

### 9.1 What changes

The roster becomes a first-class panel section: one row per tab with favicon, shortened title, origin, state badge, epoch, actions drawn, and local recoveries. The current step names its tab. The report groups by tab.

The in-page overlay's `RunBadge` gains one line it did not need before: *"Tab 2 of 3 — reading"* or, when the agent is working elsewhere, *"Pro Prompt is working in another tab."* Without it, a user looking at an idle-looking page during a three-tab run has no way to tell whether the run is alive.

### 9.2 The measurements this phase owns

| Question | Method | Output |
|---|---|---|
| **Q7** — does the overlay + side panel split keep users orienta­ted? | Six-participant think-aloud on a three-tab J-4 run, with the prompt *"where is it working right now, and what would you press to stop it?"* Moved here from Phase 4 because the split is barely stressed by a single-tab run | A written finding in `Docs/planning/multitab_findings_phase7.md`. Stop ownership is already decided (§3.7.19); what is open is comprehension |
| **Q14** — is fan-out 4 and roster 8 right? | Instrument transient memory and clone traffic at widths 1/2/4/6 and rosters 2/4/8; time-to-first-result and total read time for each | Whether memory or supervisability binds first. A revised constant, or the current one confirmed with numbers |
| **Q15** — background throttling | §5 | Which of the three consequences applies |

---

## 10. Tasks & Acceptance Criteria

| # | Task | Acceptance Criteria |
|---|---|---|
| 7.1 | Implement `survey()` over host permissions only | With three granted origins open and five ungranted tabs, `survey()` returns exactly three candidates; the built `manifest.json` **still declares no `tabs` permission**; ungranted tabs return `url: undefined` and are skipped without logging an error |
| 7.2 | Raise `MAX_ROSTER` to 8; build roster confirmation UI | Selecting a ninth tab is refused with the stated reason; `run.roster` and `run.scope` are written at admission; `run.roster` order is stable across a SW restart |
| 7.3 | Implement `open_tab` with `openedByRun` | `open_tab` to an in-scope origin opens an inactive tab and journals `tab.opened`; to an out-of-scope origin returns `OUT_OF_SCOPE` and opens nothing; at roster 8 returns `ROSTER_FULL` |
| 7.4 | Implement run-end tab closing limited to `openedByRun` | A run that opened two tabs closes exactly those two; a pre-existing roster tab is untouched; `grep -rn 'close_tab' lib` returns nothing |
| 7.5 | Implement `onRemoved` and `onUpdated` roster handling | Closing a roster tab mid-read fails that agent `TAB_CLOSED`, keeps its journal, and the run continues; a roster tab navigating out of scope fails `OUT_OF_SCOPE` and raises a suspicion signal |
| 7.6 | Implement the bounded READ fan-out at width 4 | `multi-tab.spec.ts`: an 8-tab roster never has more than 4 reads in flight (asserted by an instrumented counter); Stop during fan-out drains without starting a fifth |
| 7.7 | Verify budget sharing under concurrency; implement draw-return on refusal | `budget.spec.ts`: four concurrent agents on a 40-action budget perform exactly 40 actions total, not 160; a gate refusal other than `STOPPED` returns the draw |
| 7.8 | Implement SYNTHESISE aggregation from the journal by `tabId` | `aggregate.spec.ts`: aggregation is unchanged when every `TabStatus` is corrupted, because it reads events; every null cell carries a `why` naming the tab and URL |
| 7.9 | Implement serial ACT with serial approvals | `multi-tab.spec.ts`: a three-tab run with a write in each produces exactly one pending approval at a time; a second Always-tier request while one is pending is refused `RUN_STATE` |
| 7.10 | Run the Q15 background-settle calibration and apply its consequence | `multitab_findings_phase7.md` §Q15 tabulates false-settle rates at five windows, foreground and background, and records which of the three consequences was taken; the constants in `settle.ts` match |
| 7.11 | Extend the cockpit — roster panel, per-tab step attribution, per-tab report grouping | A three-tab run shows three roster rows updating live; the report groups results by tab with its URL; a failed tab appears with its partial results, not omitted |
| 7.12 | Extend `RunBadge` with cross-tab orientation | On a tab the agent is not currently working in, the badge reads *"Pro Prompt is working in another tab"*; Stop from that badge still halts the whole run |
| 7.13 | `cross-tab.spec.ts` — the isolation hard gate | A tab-B handle on a tab-A request is refused `HANDLE_NOT_OWNED`, journaled, with no backend call; no verb in the built schema takes a `tabId` argument |
| 7.14 | J-4 end-to-end | `multi-tab.spec.ts`: three fixture monitor pages read concurrently; tab 3's collapsed table recovered inside its own agent with no user interaction and no effect on tabs 1–2; the comparison names 3 unknown cells, each with its tab and URL |
| 7.15 | Multi-tab failure isolation | One fixture serves a 500 mid-read: that tab fails, the other two complete, the report shows partial results from the failed tab and names where it stopped |
| 7.16 | Run the Q14 fan-out and roster study | `multitab_findings_phase7.md` §Q14 tabulates memory and timing at widths 1/2/4/6 and rosters 2/4/8, and either confirms 4/8 with numbers or proposes revised constants |
| 7.17 | Run the Q7 orientation study | `multitab_findings_phase7.md` §Q7 records six participants' answers to "where is it working" and "what stops it", with the changes made in response |
| 7.18 | Performance validation | Every §12 row met |

---

## 11. Milestone Definition

Phase 7 is **complete** when:

> A user has three monitor product pages open in three tabs, all on sites they granted earlier, plus four unrelated tabs including their bank. They open the side panel on the first and type *"Compare these three monitors and tell me which suits a dual-screen coding setup under ₹30,000."* The panel shows a roster picker listing **exactly three tabs** — the three granted ones. Their bank tab is not in the list, not greyed out, not mentioned; the extension cannot see it. They confirm all three and press Start. The roster panel shows three rows going amber together: *reading · reading · reading*. Within four seconds two turn green. The third sits at *reading · recovering (1)* — its specification table was collapsed, its own Tab Agent noticed 6 rows where the others had 24, clicked **Show more**, waited, and re-read. Ten seconds in, all three are green and the budget reads *14 of 40 actions*. The comparison table appears: twenty-four cells across three columns, of which twenty-one carry values and three read **unknown**, each with a note — *"Panel type — not listed on monitor-c.example.com/specs"*, *"Refresh rate — not listed on monitor-c.example.com/specs"*, *"Warranty — the section was read but the row was empty on monitor-a.example.com."* Every value present is one the user can find on the page it names. A recommendation follows with its reasoning attached. The user runs it again, and this time closes the third tab halfway through: that row turns red with *closed · partial results kept*, the other two finish, and the report says which of them completed and where the third stopped. On a third run — *"…and add the winner to my cart"* — the reads still fan out, but the write phase goes strictly one tab at a time, and exactly one approval prompt is ever on screen. Throughout, `chrome://extensions` still lists the extension's permissions as *Storage, Scripting, Offscreen, Side panel, Active tab* — it never asked to read their browsing history, and it never needed to.

---

## 12. Performance Validation

| Metric | How to Measure | Target |
|---|---|---|
| Read fan-out width | Instrumented in-flight counter | ≤ 4 in flight; roster ≤ 8 |
| Agent-runtime state memory | Heap snapshot, 8-tab roster mid-read | ≤ 20 MB (§3.8) |
| Transient clone traffic | Sum of serialised snapshot sizes in flight | ≤ 4 × 96 KB |
| Total read time, 3 tabs | J-4, 20 runs | Recorded against sequential reads; fan-out must be materially faster or width 4 is not earning its complexity |
| Actions across a 3-tab run | Journal | ≤ 40 total, **not 120** — hard gate |
| Concurrent approvals | `multi-tab.spec.ts` | **≤ 1** at any moment — hard gate |
| Cross-tab handle use | `cross-tab.spec.ts` | **0** permitted — hard gate |
| Tabs outside the grant appearing in a roster | `survey.spec.ts` | **0** — hard gate |
| Background-tab false settle | §5 calibration | < 2 %, or the stated consequence applied |
| Per-tab traceability | `aggregate.spec.ts` | 100 % of null cells carry a `why` naming a tab and URL |

---

## 13. Files to Create

```
lib/agent/
├── tab-roster.ts     # [modify] survey, cap 8, openedByRun, onRemoved/onUpdated
├── supervisor.ts     # [modify] distinct read/synthesise phases, fan-out, serial act
├── aggregate.ts      # [new] journal-by-tabId aggregation and whyMissing
└── budget.ts         # [modify] returnAction on non-STOPPED refusal
lib/page/settle.ts    # [modify] calibrated background constants
lib/page/overlay/RunBadge.tsx   # [modify] cross-tab orientation line
entrypoints/
├── sidepanel/Cockpit.tsx  # [modify] roster panel, per-tab attribution
└── background.ts          # [modify] onRemoved/onUpdated fan-out to supervisors
lib/schemas/action.schema.ts    # [modify] open_tab moves out of NOT_YET_IMPLEMENTED
tests/unit/{survey,roster,aggregate,budget-concurrent,fanout}.spec.ts
tests/e2e/{multi-tab,cross-tab,roster-isolation}.spec.ts
tests/e2e/fixtures/monitors/{a,b,c}.html   # c has the collapsed spec table
Docs/planning/multitab_findings_phase7.md  # [new] Q7 + Q14 + Q15
```

---

## 14. Estimated Complexity

| Component | New LOC | Modified LOC | Files |
|---|---|---|---|
| `tab-roster.ts` survey + lifecycle | ~240 | ~60 | 1 |
| `supervisor.ts` phases + fan-out + serial act | ~200 | ~120 | 1 |
| `aggregate.ts` | ~260 | — | 1 |
| Roster confirmation UI + roster panel | ~340 | ~80 | 2 |
| `open_tab` + run-end closing | ~90 | ~30 | 2 |
| Settle recalibration | ~30 | ~40 | 1 |
| Unit suites | ~560 | — | 5 |
| e2e + fixtures | ~640 | — | 6 |
| Studies (Q7/Q14/Q15 harnesses) | ~280 | — | 3 |
| **Total** | **~2,640** | **~330** | **22** |

New runtime dependencies: **0**. New permissions: **0** — and that is the headline.

---

## 15. Forward Dependencies Declared Here

- `captureVisibleTab` cannot reach a background tab, so visual escalation in a non-active roster tab is impossible on the DOM backend. **[Phase 10 notes this; capture in a background tab requires CDP's `Page.captureScreenshot`, which is Phase 9.]**
- `focusBeforeWrite` may be set true by the Q15 outcome. **[Phase 9's CDP backend targets a focused tab regardless, so if Q15 forces focusing, the CDP backend's constraint costs nothing extra.]**
- `TabStatus.localRecoveries` is rendered. **[Phase 12's eval harness uses it as a per-tab reliability gauge.]**
- The roster is user-confirmed at run start and never changes except by `open_tab` or failure. **[Phase 11's unattended modes must decide what a roster means with nobody present; that is part of OQ-6 and is Phase 11's problem, not this one's.]**
