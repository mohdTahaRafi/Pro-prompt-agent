# Phase 8 — Pro Prompt Integration: Profiles, Snippets, Text Verbs & Saved Tasks

**Document type:** Phase 8 execution document
**Architecture basis:** `architecture.md` §3.6 (`lib/agents/` retained), §3.7.10 (text verbs keep their direct path), §3.7.23 (disclosure classes), §3.9 (retention, imported tasks), §3.8 (SC-11 budget)
**PRD basis:** PR-POL-1…6, PR-TXT-1…5, PR-TASK-1/2/3, PR-PRV-4, PR-RUN-6, PP-8, J-1, J-6, SC-11
**Depends on:** Phases 1–7 in full

---

## 1. Objective

At the end of this phase the existing Pro Prompt product and the browser agent are **one product rather than two things in one extension**. Profiles carry agent policy alongside facts, and a fact used to fill a field is attributed in the run record to the profile entry it came from. Snippets are reachable from the agent and from the page. `refactor`, `generate`, `score` and `summarise` are agent verbs *and* keep their direct, planner-free path — so a one-step rewrite cannot become slower because a planner exists. Saved tasks exist and **re-plan rather than replay**. And the retention policy with its purge control ships, closing the MVP half of PR-PRV-4.

This is the phase where the MVP defined in PRD §14.1 is complete.

**By the end of this phase:** J-6 is unchanged in feel and measurably within +150 ms of the Phase 1 baseline. J-1 fills fourteen fields from profile facts, and the report says *"Full name — from your profile: name"* for each. A task saved as *"Fill a job application"* re-runs against a **different** form on a different site and works, because it re-plans rather than replaying steps.

**No export/import, no scheduling, no CDP, no vision, no MCP.** Task portability is PR-TASK-4 and is FUTURE — it lands in Phase 11 with the de-privileging trust model it requires. Nothing here makes a task shareable.

---

## 2. What exists today and what happens to it

| Component | State | This phase |
|---|---|---|
| `lib/agents/refactor.ts` | **[built]** works | Becomes the `refactor` verb; keeps its direct path |
| `lib/agents/generator.ts` | **[built]** works | Becomes the `generate` verb; keeps its direct path |
| `lib/agents/scorer.ts` | **[built]**, repair ladder deleted in Phase 4 | Kept **internal**; never surfaced as an objective measure (C-6) |
| `lib/agents/comprehension.ts` | **[built]** | Becomes the `summarise` verb, and is already the Class B condenser Phase 4 wired |
| `lib/agents/loop-controller.ts` | **[built]** refactor→score loop | Unchanged, and **must stay off the agent path** (PP-8). A `refactor` verb inside a run calls `refactorPrompt` once, not the three-iteration loop |
| `lib/agents/context-update-agent.ts` | **[dead]** since before Phase 1 | Decided here: see §3.4 |
| `Profile.contextMd` | **[built]** one flat token-capped markdown document | Gains **structured facts** alongside it; the free-text document is retained |
| `snippets` table + `SnippetManager` | **[built]**, rehomed into `agent.content.ts` in Phase 2 | Reachable as run inputs; unchanged in interaction |
| `tasks` table | Created empty in Dexie v2 (Phase 1) | First written here |
| `promptHistory` | **[built]**, stored indefinitely with no control | Gains the retention purge |

---

## 3. Profiles as agent policy

### 3.1 Facts, structured

PR-POL-1 asks that a profile carry user-supplied facts the agent may use. Today it carries `contextMd`: one flat markdown blob, capped at 4,000 tokens, appended to with `## Added <ISO timestamp>` separators. That shape is right for steering a *rewrite* and wrong for filling a *field* — the agent needs to answer "what is this person's postcode?" and a blob answers "here is everything, find it yourself."

So facts become structured **alongside** the document, not instead of it:

```ts
// lib/types/profile.types.ts
export interface ProfileFact {
  id: string;                  // stable, referenced by the journal for attribution
  key: string;                 // 'name' | 'email' | 'phone' | 'address.line1' | …
  label: string;               // "Full name" — what the user typed as the field's name
  value: string;
  sensitivity: 'normal' | 'private';   // 'private' is never offered to a Hybrid planner
  source: 'user' | 'imported';
  updatedAt: number;
}

export interface AgentPolicy {
  defaultMode: 'suggest' | 'step' | 'supervised';
  permittedOrigins: string[];          // narrower than the grants, never wider (PR-SEC-6)
  permittedCapabilities: Verb[];
  factsUsableByAgent: boolean;         // master switch, default true
}

export interface Profile {
  /* …existing fields, unchanged… */
  facts: ProfileFact[];                // [new]
  agentPolicy: AgentPolicy;            // [new]
}
```

A starter key set is seeded and fully editable: `name`, `email`, `phone`, `address.line1`, `address.line2`, `address.city`, `address.postcode`, `address.country`, `linkedin`, `github`, `website`, `current_role`, `current_employer`. The user adds their own keys freely — the key is a string, not an enum, because a field the agent will meet on some form is not enumerable in advance.

**`sensitivity: 'private'`** is a per-fact switch, defaulting to `normal`, that the user sets on anything they do not want reaching a remote planner even as a matched value. It changes what §3.3 sends.

`contextMd` is **retained unchanged**. It still steers refactor and generate, still has its 4,000-token cap, and is untouched by the agent's field matching. Two mechanisms for two jobs is correct here; merging them would degrade both.

### 3.2 Field matching and attribution (PR-POL-4)

Matching a form field to a profile fact is deterministic first, judge-tier second — the same ladder as `step-resolver.ts` (Phase 4 §8.4), for the same reason.

```ts
// lib/agent/facts.ts   [new]
export async function matchFact(
  el: ElementDescriptor, facts: ProfileFact[], posture: Posture,
): Promise<Result<FactMatch, 'NO_MATCH' | 'AMBIGUOUS'>> {
  // 1. autocomplete attribute — the web's own answer to this exact question.
  const ac = AUTOCOMPLETE_TO_KEY[el.autocomplete ?? ''];
  if (ac) { const f = facts.find(x => x.key === ac); if (f) return Ok({ fact: f, how: 'autocomplete' }); }

  // 2. Exact, then normalised, label match against fact.label.
  const norm = normaliseLabel(el.name);
  const exact = facts.filter(f => normaliseLabel(f.label) === norm);
  if (exact.length === 1) return Ok({ fact: exact[0], how: 'label' });

  // 3. Key-synonym table. Hand-written, ~80 entries, covering the labels real
  //    forms use: "Given name"/"First name"/"Forename" → name.first, and so on.
  const bySyn = facts.filter(f => SYNONYMS[f.key]?.some(s => norm.includes(s)));
  if (bySyn.length === 1) return Ok({ fact: bySyn[0], how: 'synonym' });

  // 4. Only now, the judge tier — and only over the candidate set, never over
  //    the whole profile. The model picks among facts the user already holds;
  //    it never invents a value.
  if (bySyn.length > 1 || (exact.length === 0 && facts.length > 0)) {
    const pick = await inferStructured({
      tier: 'judge', posture, system: FACT_MATCH_SYSTEM,
      user: renderFactCandidates(el, bySyn.length ? bySyn : facts),
      maxTokens: 40, temperature: 0,
    }, z.object({ factId: z.string(), confidence: z.number() }));
    if (pick.ok && pick.value.confidence >= 0.8)
      return Ok({ fact: byId(facts, pick.value.factId), how: 'judge' });
  }
  return Err('NO_MATCH');
}
```

**The model selects among facts; it never produces one.** `FactMatch.fact` is a reference into the user's own list, so a field can only ever be filled with something the user typed. That is PP-6 enforced structurally: there is no code path in which a value the user did not supply reaches a form field.

A `NO_MATCH` field is left blank and reported, and produces `ask_user` with reason `NEEDS_USER_DATA` when the plan says it is required. Phase 5 noted that this reason fired for *every* unmatched field because there were no facts; now it fires only for genuinely unmatched ones.

**Attribution** is journaled with every fill:

```ts
await journal.append(runId, 'action.observed', tabId, {
  verb: 'type', handle, verified, evidence,
  factAttribution: { factId: f.id, factKey: f.key, factLabel: f.label, how: 'autocomplete' },
});
```

The report renders it per row: *"Full name — Mohd Taha — from your profile: Full name"*. PR-POL-4 is satisfied by the journal, which means the reporter gets it for free (§3.7.5) and cannot report an attribution the journal does not carry.

### 3.3 Facts and the disclosure boundary

A matched fact's **value** is written into an `ActionRequest` as `type.text` — it goes to the gate and the page, both local. It reaches a remote planner only if the planner is asked to decide *what to type*, which the architecture avoids: `step-resolver` matches the fact locally and the planner sees the plan step as *"fill the full-name field from the profile"*, not the value.

Two rules make this enforceable:

1. **The planner's observation never contains fact values.** `PerceptionSnapshot` carries `valueShape`, and a field this run filled shows `filled`, not its contents.
2. **A `private` fact's label is sent, never its value**, in any Class A payload. `minimise.ts` (Phase 4 §7.2) gains an assertion: a Class A payload containing the literal value of any `private` fact returns `CLASS_A_CONTAINS_PRIVATE_FACT` and the call is refused.

`tests/unit/facts-disclosure.spec.ts` asserts both by constructing a profile whose `private` fact value is a unique sentinel string and grepping every outbound payload for it across a full Hybrid J-1 run.

### 3.4 `context-update-agent.ts` — the decision

Architecture §3.6 marks it `[dead]` and says Phase 8 decides. The decision: **it is deleted.**

It implements PR-POL-6 — merging profile facts rather than blind-appending, so newer information supersedes older. That requirement is marked **FUTURE** in the PRD (§14.4). Keeping 124 lines of unreferenced, untested code that implements a FUTURE requirement against the *old* flat `contextMd` shape — which structured facts now partly supersede — is carrying a liability for no benefit. The structured facts table makes merge a much smaller problem when it is wanted: `facts` is keyed, so a newer value for `address.postcode` replaces the old one by construction, and the free-text `contextMd` keeps its existing append-with-truncation behaviour.

What is lost is recorded here so it is a decision rather than an omission: intelligent merging of *free-text* context remains unbuilt, and PR-POL-6 remains FUTURE.

---

## 4. Text capabilities as verbs — with the direct path intact

### 4.1 The two paths (§3.7.10)

```
DIRECT PATH (unchanged, and this is PP-8):
  overlay / side panel / popup → background → lib/agents/refactor.ts → route({tier})
  No planner. No gate. No run. No journal write beyond promptHistory.

AGENT PATH (new):
  Tab Agent → ActionRequest{verb:'refactor'} → gate (Low, no approval)
            → lib/agents/refactor.ts → journal
```

Thinking verbs change no page state and need no gate approval, but they **still pass through the gate** — for budget accounting, stop enforcement, and journaling. Tier is Low, `requiresApproval` is false in every mode, and the check costs the same ~2–5 ms round trip every action pays.

**PP-8 and SC-11 are protected structurally**: a one-step rewrite cannot become slower because a planner exists, because the planner is not on that code path. `tests/unit/direct-path.spec.ts` asserts it by import analysis — the direct handler in `background.ts` must not transitively import `planner.ts`, `supervisor.ts` or `gate.ts`.

### 4.2 `textRef` — how a verb refers to text it did not receive

`summarise` and `transform` take a `textRef`, not raw text. Passing raw page text through the plan would put Class B content into the planner's observation, which §3.7.23 forbids.

```ts
// A textRef names a journal event that already holds the text.
type TextRef = `ev:${number}`;      // the seq of a read_page / read_element event
```

The Supervisor resolves the ref against the journal at call time. So the planner writes *"summarise what you read at step 3"*, the ref resolves locally, the text is condensed locally, and only the condensation crosses the wire if the posture is Hybrid — the whole Class B chain, unchanged.

### 4.3 `scorer.ts` stays internal

C-6 is explicit: the existing scorer is an LLM-as-judge with no golden set, no calibration and no regression check, and its output must not be presented as an objective measure.

So: `score` is **not** in the verb table (§3.3.2a lists eighteen; `score` is not among them). It remains reachable from the direct path where it always was, and the loop controller keeps using it internally. It is not exposed as an agent verb, is not shown in the run report, and the dashboard's score display gains the qualifier it always needed — *"a model's opinion, not a measurement"* — alongside the removal of the fabricated `{score: 50}` fallback that Phase 4 deleted.

---

## 5. Saved tasks

### 5.1 A task is a goal, not a macro (PR-TASK-2)

```ts
// lib/types/task.types.ts   [new]
export interface SavedTask {
  id?: number;
  name: string;
  goal: string;                    // the natural-language goal. THE task.
  tags: string[];
  hintOrigins: string[];           // where it has worked before — a hint, not a scope
  defaultMode: 'suggest' | 'step' | 'supervised';
  defaultPosture: Posture;
  createdAt: number; lastUsedAt: number; useCount: number;
  source: 'user' | 'imported';     // 'imported' is de-privileged — [Phase 11]
}
```

**No steps are stored.** Re-running produces a fresh plan against the current page. Recorded-macro replay was rejected outright (§3.5.1): it is brittle by construction and contradicts the recovery model — a replayed selector cannot notice that a modal appeared.

`hintOrigins` is what the task has previously run on. It is passed to the planner as context and is used to sort task suggestions when the user is on a matching site. It is **never** a scope grant: running a task still requires the current origin to be granted and in `run.scope`, and `hintOrigins` never touches `sitePolicy`.

### 5.2 Discovery

Tags, recency and usage count (PR-TASK-3). No embeddings, no vector store — that is explicitly Cerebro's territory (PRD §7.2), and tag + recency + frequency fits a few dozen local records better anyway.

```ts
export async function findTasks(q: string, currentOrigin?: string): Promise<SavedTask[]> {
  const all = await db.tasks.toArray();
  const scored = all.map(t => ({ t, s:
      (t.name.toLowerCase().includes(q) ? 10 : 0)
    + (t.tags.some(tag => tag.includes(q)) ? 6 : 0)
    + (t.goal.toLowerCase().includes(q) ? 3 : 0)
    + (currentOrigin && t.hintOrigins.includes(currentOrigin) ? 8 : 0)
    + Math.min(5, t.useCount)
    + recencyBoost(t.lastUsedAt) }));           // 4 / 2 / 1 / 0 for <1d / <7d / <30d / older
  return scored.filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.t);
}
```

Constants are small integers with a stated intent: an origin match (8) outranks a goal-text match (3) because being on the right site is a stronger signal than a word overlap; `useCount` is capped at 5 so a task used forty times does not permanently outrank a better match.

Saving a task from a completed run is one button in the report — the goal is already there, the origins are already known, and the mode and posture used are the sensible defaults.

---

## 6. Retention and purge (PR-PRV-4, PR-RUN-6)

`runEvents` may contain page-derived text, and a multi-tab run multiplies how much. Phase 6 shipped per-run and clear-all deletion. This phase ships the **policy**.

```ts
// lib/db/retention.ts   [new]
export interface RetentionSettings {
  runEventsDays: number;      // default 30
  promptHistoryDays: number;  // default 30 — today this is stored indefinitely
  purgeOnUninstall: boolean;  // default true
}

export async function purge(now = Date.now()): Promise<PurgeReport> {
  const s = await getRetentionSettings();
  const runCutoff = now - s.runEventsDays * 86_400_000;
  const terminal = await db.runs.where('startedAt').below(runCutoff)
    .filter(r => TERMINAL_STATES.includes(r.state)).toArray();   // never purge a live run
  await db.transaction('rw', db.runs, db.runEvents, async () => {
    for (const r of terminal) {
      await db.runEvents.where('runId').equals(r.id!).delete();
      await db.runs.delete(r.id!);
    }
  });
  const histCutoff = now - s.promptHistoryDays * 86_400_000;
  const hist = await db.promptHistory.where('createdAt').below(histCutoff).delete();
  return { runsPurged: terminal.length, historyPurged: hist, ranAt: now };
}
```

Run on `chrome.runtime.onStartup` and after every run's `finish`. **Not on an alarm** — `alarms` is not a declared permission until Phase 11 (§3.9), and adding it here to run a purge that two natural triggers already cover would widen the manifest for no reason.

The settings surface states plainly what is stored and offers `7 / 30 / 90 / forever` per category, a *purge now* button that reports how many rows it removed, and a line naming what a run record can contain: *"Run records include the text of pages the agent read. That is how the report can tell you where a value came from."*

---

## 7. J-6 and the SC-11 guarantee

J-6 is *"single-step rewrite in place — the existing product's behaviour, unchanged in feel."* This phase must prove it rather than assert it.

`tests/bench/text-ops.bench.ts`, created in Phase 1 before anything changed, is re-run against the same fixed 400-word prompt on the same machine. The budget is **≤ +150 ms vs the Phase 1 baseline** (§3.8, SC-11), and it is a CI check rather than a manual one.

Where the +150 ms is expected to go, so a regression is diagnosable rather than mysterious:

| Source | Expected cost |
|---|---|
| Zod validation of the message payload (Phase 1) | ~1–3 ms |
| Tier router chain selection (Phase 4) | ~1 ms |
| `route()` posture probe, cached 60 s | ~0 ms warm, ~40 ms cold |
| Engine change: WebLLM → `LanguageModel` where available | **negative** — usually faster |
| Everything else | 0 — the direct path touches no agent code |

If the bench exceeds the budget, the cause is one of the four rows above and the fix is in that row, not in the agent.

---

## 8. Tasks & Acceptance Criteria

| # | Task | Acceptance Criteria |
|---|---|---|
| 8.1 | Extend `Profile` with `facts[]` and `agentPolicy`; migrate existing profiles | Dexie opens an existing v2 database and every profile gains an empty `facts` array and a default `agentPolicy` without losing `contextMd`; the six seeded profiles keep their guidelines verbatim |
| 8.2 | Build the profile facts editor with per-fact `sensitivity` | The user can add, edit, delete and reorder facts; marking one `private` shows what that changes; PR-POL-3 — everything the agent knows is visible and editable on one screen |
| 8.3 | Implement `lib/agent/facts.ts` with the four-stage matching ladder | `facts.spec.ts` over 30 real form fields: `autocomplete` matches take precedence; a label match resolves with zero model calls; two synonym candidates invoke the judge once; judge confidence < 0.8 returns `NO_MATCH`; **no code path produces a value not present in `facts[]`** |
| 8.4 | Journal fact attribution on every fill; render it in the report | J-1's report shows *"from your profile: <label>"* on every filled field; a field filled without attribution is impossible — the `type` action carrying a fact value must carry a `factId` |
| 8.5 | Enforce the private-fact disclosure rule | `facts-disclosure.spec.ts`: a Hybrid J-1 run with a sentinel-valued `private` fact produces zero outbound payloads containing the sentinel; a Class A payload constructed with one returns `CLASS_A_CONTAINS_PRIVATE_FACT` |
| 8.6 | Wire `refactor`, `generate`, `summarise`, `transform` as verbs | Each is permitted Low with no approval in every mode; each journals; a `refactor` verb inside a run calls `refactorPrompt` **once** — `loop-controller.ts` is not on the agent path (asserted by import analysis) |
| 8.7 | Implement `textRef` resolution against the journal | `summarise` with `textRef: 'ev:12'` resolves to that event's text; an unresolvable ref returns `MALFORMED_ACTION` at the gate; no raw page text appears in any planner observation |
| 8.8 | Preserve the direct path | `direct-path.spec.ts`: the direct handlers do not transitively import `planner.ts`, `supervisor.ts` or `gate.ts`; J-6 works with the agent runtime entirely absent |
| 8.9 | Keep `scorer.ts` internal | `score` appears in no verb schema and no report; the dashboard's score display carries the "a model's opinion, not a measurement" qualifier |
| 8.10 | Delete `lib/agents/context-update-agent.ts` | The file is gone; `PR-POL-6 — FUTURE` is recorded in `TECHNICAL_DECISIONS.md` with the reasoning from §3.4 |
| 8.11 | Implement the `tasks` table, save-from-report, and `findTasks` | Saving from a completed run captures goal, origins, mode and posture; searching by name, tag and goal text works; being on a `hintOrigin` promotes a task; **no steps are stored** — asserted by schema |
| 8.12 | Re-run a saved task against a **different** form | `saved-task.spec.ts`: a task saved on `form-a.html` runs on `form-b.html` (different field order, different labels, one extra field) and completes with attribution; the journal shows a fresh `plan.proposed`, not a replay |
| 8.13 | Implement `lib/db/retention.ts` and the settings surface | Setting 7 days and pressing *Purge now* removes older terminal runs and their events in one transaction and reports the count; a live run is never purged; `promptHistory` is purged on the same schedule |
| 8.14 | Integrate snippets as run inputs | A snippet body is insertable into a goal box and into a `type` step's value from the plan editor; the popover interaction is unchanged from Phase 2 |
| 8.15 | Re-run the SC-11 bench in CI | Within **+150 ms** of `baseline_phase1.md` for REFACTOR, SCORE, GENERATE and SAVE_CONTEXT, p50 and p95, on all available providers |
| 8.16 | J-1 with profile facts, end to end | `form-fill.spec.ts` extended: 14 fields, ≥ 12 filled from facts with attribution, 1 `NEEDS_USER_DATA`, 1 file input reported as `MISSING_CAPABILITY`, Submit held |

---

## 9. Milestone Definition

Phase 8 is **complete** when:

> A user opens the dashboard's **Profile** tab and sees, on one screen, everything the agent knows about them: eleven facts with labels they wrote themselves, two of them marked *private*, plus the free-text guidelines document that has steered their prompt rewrites since before any of this existed. They mark their date of birth *private* and a line appears: *"Private facts are used to fill fields on your machine. They are never sent to a remote model, even on a Hybrid run."* They open a job application on a site they granted, state *"Fill this from my details and stop before submitting"*, and watch fourteen fields fill. The report afterwards reads, line by line: *Full name — Mohd Taha — from your profile: Full name*; *Email — taharafi05@gmail.com — from your profile: Email*; *Postcode — from your profile: Postcode*; *"How did you hear about us?" — not filled, I have nothing in your profile that matches*; *CV — this needs a file, which only you can attach*. They press **Save as task**, name it *"Job application"*, and tag it `jobs`. A week later, on an entirely different company's site with a differently-ordered form and one extra field, they type `job` into the task box; *Job application* is first in the list because they are on a site it has worked on before. They run it. The panel produces a **new plan** — eleven steps in a different order, with one step for the field that did not exist last time — and fills the form. The journal shows `plan.proposed`, not a replay. Then they select an awkward paragraph on the page, press the rewrite shortcut, and the rewritten text appears in **1.4 seconds** — the same as it did before any of this was built, and within 90 ms of the number recorded in `baseline_phase1.md` eight phases ago. Finally they open **Privacy**, set run-record retention to 7 days, press *Purge now*, and are told *"Removed 12 runs and 419 events."* Nothing about the single-step product they started with feels different. Everything around it is new.

---

## 10. Performance Validation

| Metric | How to Measure | Target |
|---|---|---|
| Single-step text operation | `text-ops.bench.ts` vs `baseline_phase1.md` | ≤ **+150 ms** p50 and p95 — CI gate (SC-11, PP-8) |
| Fact match, deterministic share | `facts.spec.ts` over the 30-field corpus | ≥ 80 % matched with zero model calls |
| Fact match, judge tier | Same | ≤ 1.2 s p95 |
| Values in a filled field not present in `facts[]` | `facts.spec.ts` | **0** — hard gate |
| Private fact values in any outbound payload | `facts-disclosure.spec.ts` | **0** — hard gate |
| Saved-task re-plan on a different form | `saved-task.spec.ts` | Completes; zero replayed steps |
| Purge transaction | 500 runs × 40 events | ≤ 2 s, single transaction, no partial state |
| Report attribution coverage | J-1 report | 100 % of filled fields carry a `factId` |

---

## 11. Files to Create

```
lib/
├── agent/facts.ts          # [new] four-stage matching, attribution
├── db/
│   ├── retention.ts        # [new] settings + purge
│   └── tasks.ts            # [new] CRUD + findTasks
├── types/
│   ├── profile.types.ts    # [modify] facts[], AgentPolicy
│   └── task.types.ts       # [new]
├── schemas/action.schema.ts # [modify] textRef verbs leave NOT_YET_IMPLEMENTED
├── model/minimise.ts       # [modify] private-fact assertion
└── agents/context-update-agent.ts   # [DELETE]
entrypoints/
├── options/App.tsx         # [modify] Profile facts editor, Tasks view, Privacy view
├── sidepanel/Cockpit.tsx   # [modify] task picker, attribution in step rows
└── background.ts           # [modify] task and retention message handlers
tests/unit/{facts,facts-disclosure,tasks,retention,direct-path,textref}.spec.ts
tests/e2e/{saved-task,form-fill}.spec.ts
tests/e2e/fixtures/{form-a.html, form-b.html}
```

---

## 12. Estimated Complexity

| Component | New LOC | Modified LOC | Files |
|---|---|---|---|
| `facts.ts` + synonym table | ~330 | — | 1 |
| Profile facts editor | ~420 | ~60 | 1 |
| Text verbs + `textRef` resolution | ~180 | ~90 | 3 |
| `tasks.ts` + Tasks view + save-from-report | ~380 | ~70 | 3 |
| `retention.ts` + Privacy view | ~260 | — | 2 |
| Attribution journaling and rendering | ~120 | ~80 | 3 |
| Unit suites | ~740 | — | 6 |
| e2e + fixtures | ~420 | — | 4 |
| **Total** | **~2,850** | **~300** | **23** |

Deleted: `context-update-agent.ts` (124 LOC). New runtime dependencies: **0**.

**The MVP defined in PRD §14.1 is satisfied at the end of this phase.**

---

## 13. Forward Dependencies Declared Here

- `SavedTask.source` accepts `'imported'` and nothing produces it. **[Phase 11 builds export/import with the de-privileging trust model — an imported task carries no origin grants, no autonomy mode above Step, no saved approvals, is re-planned from scratch, and its text passes through `suspicion.ts` like page content (§3.9).]**
- `SavedTask.defaultMode` accepts `'watch'` only from Phase 11.
- `RetentionSettings.purgeOnUninstall` is stored and unused — an uninstall handler needs `chrome.runtime.setUninstallURL` or nothing at all, and the honest answer is that IndexedDB is removed by Chrome on uninstall anyway. **[Phase 14 states this accurately in the disclosure copy rather than implying an active purge.]**
- `PR-POL-6` (intelligent fact merging) remains **FUTURE** and is now unimplemented in both forms.
- Scheduled task runs need `alarms`, which is still not declared. **[Phase 11, and only then.]**
