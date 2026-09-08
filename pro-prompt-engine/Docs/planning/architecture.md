# Pro Prompt Browser Agent — System Architecture & Technical Design

**Document type:** Phase 0 — Architecture
**Status:** Draft for approval. No implementation has begun against this document.
**Date:** 2026-08-31

---

## Document Basis

| Source | Role here |
|---|---|
| `PRO_PROMPT_BROWSER_AGENT_CONCEPT.md` | Conceptual source of truth — principles, capability categories, safety philosophy, failure taxonomy |
| `PRO_PROMPT_BROWSER_AGENT_PRD.md` | Product requirements — every `PR-*`, `PP-*`, `SC-*`, `PRE-*` referenced below is defined there |
| `PRO_PROMPT_TECHNICAL_CAPABILITY_AUDIT.md` (2026-08-27) | Baseline claims about the current system |
| The repository at `pro-prompt-engine/` | Read directly for this document. Every "today" statement below was verified against source, not taken from the audit |
| `skywalker/architecture_demo.md` + `CLAUDE.md` | Document structure and depth conventions only. None of SkyWalker's technology choices are carried over |

This document is the technical bridge between the PRD and the phase documents. It fixes the runtime topology, the contracts between components, the directory layout, and the numbers that later phases validate against. It does **not** contain task lists, acceptance criteria, or per-file implementation detail — those belong to `phase_1_*.md` … `phase_14_*.md`.

### Status marks used throughout

| Mark | Meaning |
|---|---|
| **[built]** | Exists and works in the repository today |
| **[built-broken]** | Exists, but source inspection confirms a correctness or security defect |
| **[dead]** | Written in the repository, imported by nothing |
| **[new]** | Does not exist in any form; this architecture introduces it |

Pro Prompt is an in-development project. Nothing below may be assumed complete because a file with a plausible name exists.

---

### 3.1 Vision

Pro Prompt today is a text improver: the user presses a button, an LLM rewrites the text in the field they are focused on, and the extension never learns whether anything landed. The Browser Agent inverts that shape — the user states a goal, and the extension plans, acts on the page, observes what actually changed, verifies it, recovers when the page misbehaves, and stops at every boundary the user cannot undo. The non-obvious part is not the planning loop; planning loops are commodity. It is that **the model is architecturally untrusted**: planning runs in one extension context and can only emit a request from a closed vocabulary of eighteen verbs — constrained at decode time by a JSON schema, not merely validated after the fact — addressed to opaque element handles it did not invent, which must cross a process boundary into a Policy Gate that classifies the action by reversibility, checks it against a per-origin grant and the user's original goal, and refuses anything outside that envelope — with no way for the model, or for text embedded in a webpage, to reach the gate's rules. The second load-bearing property is that **the run report is generated from an append-only journal of observed outcomes, not from the planner's account of itself**, so the product structurally cannot claim it filled fourteen fields when it filled nine. The third is that the runtime is shaped by a rule the problem imposes rather than one we chose: **a run is a Supervisor over one Tab Agent per tab, reads fan out and writes serialize** — because consent cannot be given to three tabs at once, because only one tab per window is active, and because a background tab's timers are throttled. Single-tab work is simply the one-Tab-Agent case, so multi-tab is an instantiation rather than a migration. Everything else is a swappable mechanism underneath that boundary: how an action is performed (isolated-world DOM by default, Chrome DevTools Protocol when the user opts in), how a page is perceived (structured DOM first, a cropped screenshot only when structure has demonstrably failed), and which engine decides. On that last point the architecture takes a deliberate position: **planner-grade reasoning is not available from a 1.5–4B in-browser model, and pretending otherwise would breach the product's own truthfulness principle at the moment it costs most**. On-device inference remains the differentiator where it genuinely wins — verification, inline completion, local vision — while multi-step planning runs on a local Ollama model or, on a run the user has explicitly declared Hybrid, on a provider whose key they hold. Pro Prompt operates no server of its own; what leaves the machine on a Hybrid run is a typed page skeleton, not page content.

---

### 3.2 High-Level Architecture

#### 3.2.1 Current runtime topology (verified against source, 2026-08-31)

Five WXT entrypoints over one `chrome.runtime` message union (~40 `MessageType` members, `{status, data, message}` envelope). ~3.6k LOC, no tests, no CI.

```
┌───────────────────────── Chrome (MV3) ──────────────────────────────┐
│                                                                      │
│  popup/App.tsx ────────┐                                             │
│  options/App.tsx ──────┤  chrome.runtime.sendMessage                 │
│  toolbar.content.tsx ──┤  (6 AI hosts only, shadow root)             │
│  content.ts ───────────┤  (<all_urls>: snippets, autocomplete,       │
│                        │   keep-alive ping, Readability scan)        │
│                        ▼                                             │
│              ┌────────────────────────────┐                          │
│              │  background.ts             │                          │
│              │  service worker            │                          │
│              │  · message router (switch) │                          │
│              │  · agents run HERE         │                          │
│              │  · llm-router fallback     │                          │
│              │  · 3-layer keep-alive      │                          │
│              └───────┬──────────┬─────────┘                          │
│                      │          │                                     │
│   chrome.runtime     │          │  Dexie 4 / IndexedDB                │
│   {target:'offscreen'}          ▼  (profiles, snippets,               │
│                      │   ┌──────────────┐  promptHistory,             │
│                      ▼   │ ProPromptEngine │ settings, analytics)     │
│         ┌──────────────────────────┐                                  │
│         │ offscreen/main.ts        │                                  │
│         │ WebLLM MLCEngine (WebGPU)│                                  │
│         │ cold→loading→hot→error   │                                  │
│         └──────────────────────────┘                                  │
└──────────────────────────────────────────────────────────────────────┘
        │                              │
        │ https://api.groq.com/*       │ http://localhost:11434/*
        ▼                              ▼
   Groq (PII-scrubbed)            Ollama (local)
```

There is no planner, no tool registry, no `MutationObserver`, no element model, no run state, and no actuation beyond writing a string into `element.value` and dispatching a synthetic `input` event.

#### 3.2.2 Target runtime topology

Six contexts. The additions that matter are the **Run Supervisor and its Tab Agents** (the orchestration layer, hosted in the offscreen document alongside every inference engine) and the **Policy Gate** (in the service worker, on the critical path of every action). Beneath the gate sits the swappable actuation backend; the dashed-in `mcp/` box is deferred and shown only so its position is not improvised later. Arrows are labelled with the actual transport.

```
┌───────────────────────────────── Chrome (MV3) ────────────────────────────────────┐
│                                                                                   │
│  ┌──────────────────────┐              ┌──────────────────────────────────────┐   │
│  │ sidepanel/ — COCKPIT │              │ options/ — DASHBOARD                 │   │
│  │ goal · plan · steps  │              │ runs · saved tasks · site grants ·   │   │
│  │ tab roster · STOP◄── authoritative  │ profile+policy · backend & posture   │   │
│  └──────────┬───────────┘              └──────────────────┬───────────────────┘   │
│             │  runtime.sendMessage / port 'cockpit'       │  runtime.sendMessage  │
│             ▼                                             ▼                       │
│  ┌──────────────────────────────────────────────────────────────────────────────┐ │
│  │ background.ts — SERVICE WORKER  (stateless; may be terminated and re-woken)  │ │
│  │                                                                              │ │
│  │  ┌─────────────── POLICY GATE — eight ordered checks ───────────────┐        │ │
│  │  │ 1 run identity          5 action + risk tier                     │        │ │
│  │  │ 2 tab identity          6 run state                              │        │ │
│  │  │ 3 origin scope OF THAT  7 stop state                             │        │ │
│  │  │   TAB (not the run)     8 approval requirement                   │        │ │
│  │  │ 4 handle ownership        one approval queue, strictly serial    │        │ │
│  │  └───────────────────────────┬──────────────────────────────────────┘        │ │
│  │  ┌───────────────────────────▼──────────────────────────────────────┐        │ │
│  │  │ ACTUATION BACKEND — per run; the gate sits ABOVE both            │        │ │
│  │  │   dom-backend  default · isolated world · no extra permission    │        │ │
│  │  │   cdp-backend  opt-in  · "debugger" · ANY detach halts the run   │        │ │
│  │  └──────────────────────────────────────────────────────────────────┘        │ │
│  │ message router · chrome.scripting · chrome.permissions · tab roster          │ │
│  └──┬──────────────────────────┬───────────────────────────────┬────────────────┘ │
│     │ runtime{target:'agent'}  │ tabs.sendMessage (granted     │ Dexie 4          │
│     ▼                          │                    origin)    ▼                  │
│  ┌──────────────────────────────────────────────────┐   ┌──────────────┐          │
│  │ offscreen/ — AGENT RUNTIME                       │   │ IndexedDB    │          │
│  │ ┌──────────────────────────────────────────────┐ │   │ runs         │          │
│  │ │ RUN SUPERVISOR                               │ │   │ runEvents    │          │
│  │ │ roster ≤8 · phase · SHARED budget            │ │   │ sitePolicy   │          │
│  │ │ aggregation · cancellation · journal writer  │ │   │ tasks        │          │
│  │ │ SURVEY ▸ READ (fan-out ≤4) ▸ SYNTHESISE ▸    │ │   │ profiles     │          │
│  │ │ ACT (serial) ▸ END                           │ │   │ snippets     │          │
│  │ └───┬──────────────┬──────────────┬────────────┘ │   │ settings     │          │
│  │ ┌───▼────────┐ ┌───▼────────┐ ┌───▼────────┐     │   └──────────────┘          │
│  │ │ TAB AGENT 1│ │ TAB AGENT 2│ │ TAB AGENT n│     │                             │
│  │ │ snapshot   │ │ snapshot   │ │ snapshot   │     │                             │
│  │ │ epoch      │ │ epoch      │ │ epoch      │     │                             │
│  │ │ HANDLES —  │ │ HANDLES —  │ │ HANDLES —  │     │                             │
│  │ │ its own    │ │ its own    │ │ its own    │     │                             │
│  │ │ only       │ │ only       │ │ only       │     │                             │
│  │ │ local recov│ │ local recov│ │ local recov│     │                             │
│  │ └────────────┘ └────────────┘ └────────────┘     │                             │
│  │ ┌──────────────────────────────────────────────┐ │                             │
│  │ │ MODEL ROUTER — four tiers, no silent crossing│ │                             │
│  │ │  planner  Ollama 7–14B | remote on user key  │ │                             │
│  │ │           NEVER a 1.5–4B in-browser model    │ │                             │
│  │ │  judge    LanguageModel ▸ WebLLM  (local)    │ │                             │
│  │ │  vision   LanguageModel image | remote VLM   │ │                             │
│  │ │  inline   LanguageModel warm session, LOCAL  │ │                             │
│  │ │           ONLY — no remote path exists       │ │                             │
│  │ └──────────────────────────────────────────────┘ │                             │
│  │ ┌──────────────────────────────────────────────┐ │                             │
│  │ │ mcp/ client [DEFERRED — contract §3.7.15]    │ │                             │
│  │ └──────────────────────────────────────────────┘ │                             │
│  └────────────────────────────┬─────────────────────┘                             │
│                               ▼                                                   │
│      ┌─────────────────────────────────────────────────────────────┐              │
│      │ EACH TAB IN THE ROSTER (one content script per tab)         │              │
│      │  ┌───────────────────────────────────────────────────────┐  │              │
│      │  │ agent.content.ts — isolated world, per-grant          │  │              │
│      │  │ · Perception snapshot   · Element Registry            │  │              │
│      │  │ · Settle Detector       · DOM actuator                │  │              │
│      │  │ · Deterministic verifier                              │  │              │
│      │  │ · overlay: goal box · STOP mirror · highlight         │  │              │
│      │  └───────────────────────────────────────────────────────┘  │              │
│      └──────────────────────────────▲──────────────────────────────┘              │
│                                     │ chrome.debugger, from the SW, cdp-backend   │
│                                     │ only — user-visible banner while attached:  │
│                                     └─ Accessibility.getFullAXTree ·              │
│                                        Input.dispatchMouse/KeyEvent ·             │
│                                        Page.captureScreenshot                     │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Ownership rules that the diagram encodes:**

- The **Supervisor schedules**; it owns the roster, the run phase, the shared budget and aggregation. It holds no handles and no browser capability.
- Each **Tab Agent decides for one tab**; it holds that tab's snapshot, epoch, handles and local recovery state, and **cannot name a handle belonging to another tab** — that handle does not exist in its context, and would fail the gate's ownership check if it did (§3.7.17).
- The **gate permits**; it holds every browser capability and none of the intelligence. It never calls a model. Its origin check resolves against **the tab named in the request**, not against a run-level union.
- The **content script executes and observes** on the default backend; it is the only code with a DOM, and it refuses any target not in its own registry.
- The **actuation backend is a mechanism, never an authority**. Swapping `dom-backend` for `cdp-backend` changes how a permitted action is performed and how richly the page is perceived. It changes nothing about what is permitted, because the gate's checks are expressed over verbs, handles, tiers, tabs and origins — not over transports (§3.7.12).
- The **cockpit shows and interrupts**; it renders from the journal and the run state, never from planner narration. **Its Stop is authoritative**; the in-page Stop is a mirror, because an in-page overlay dies on navigation and the authoritative control must not (§3.7.19).

#### 3.2.3 What changes from the current topology, and why

| Change | Reason |
|---|---|
| The run loop becomes a **Run Supervisor over N Tab Agents**, not a single-tab kernel | Multi-tab is a near-term requirement (PR-NAV-4/5, J-4). Parameterising a single-tab loop with a `tabId` produces a loop with an implicit scheduler — the worst version of multi-tab. Splitting the concept now costs ~600 lines and makes multi-tab an instantiation rather than a migration (§3.7.16) |
| The planner tier stops being an on-device small model | A 1.5–4B model selecting among ~120 element descriptors across a multi-step plan produces confidently wrong plans, which is a PP-6 truthfulness failure in the place it costs most. Planning moves to Ollama 7–14B or, on a declared Hybrid run, a provider the user holds the key to (§3.7.9) |
| The planner is invoked on triggers, not on every step | Uncosted in the first draft: 40 actions × 3–6 s of planner inference is 2–4 minutes against a 12-minute wall clock, on the user's own key. The Tab Agent executes plan steps directly and re-invokes the planner only when the next action is not derivable (§3.7.20) |
| Run loop moves from the service worker to the offscreen document | An MV3 service worker is terminated on idle; a run is multi-minute. The offscreen document created with `reasons: ['WORKERS']` is not idle-terminated, already exists, and already hosts the model. Running the loop next to the model also removes a message hop per inference |
| The three-layer keep-alive is **deleted** | It existed to keep the SW alive across a 30 s inference. With the loop in the offscreen document, every action wakes the SW by message anyway. Removing it also removes the `chrome.tabs.query` over all tabs — one of the two `tabs`-permission violations (PR-SEC-8). The offscreen VRAM no-op tick is retained; it solves a different problem |
| `content.ts` on `<all_urls>` is **replaced** by `agent.content.ts` registered only on granted origins | `<all_urls>` at install time is the store-review risk (R-4) and the reason a password field on any site is currently reachable. Registration follows the grant (PR-SEC-5, PR-SEC-9) |
| The AI-site-only toolbar is **replaced** by side panel + minimal in-page overlay | The current toolbar matches six AI hosts and is a launcher for five modals. The cockpit must survive navigation within a run; an in-page React tree does not |
| A Policy Gate is introduced between decision and action | Today nothing sits between "an agent decided" and "the DOM changed". PP-3 requires the enforcement point to be somewhere the model cannot reach |
| Inference gains a third engine: Chrome's built-in on-device `LanguageModel` | It is available to extensions with no origin trial, needs no multi-gigabyte download of our own, supports JSON-Schema-constrained decoding, and accepts image input. WebLLM stays as the fallback and as the pinnable option (§3.7.14) |
| Actuation becomes a two-backend abstraction | The current synthetic-`input`-event write is the single most common source of silent action failure. CDP's trusted input and real accessibility tree fix that class outright, but cost a heavyweight permission — so they are opt-in, not default (§3.7.12) |

---

### 3.3 Data Flow Summary

#### 3.3.1 One complete run, end to end

The scenario is PRD journey **J-1**: *"Fill this application from my details and stop before submitting"*, stated on a page whose origin the user has already granted.

1. **Goal intake.** The user opens the in-page overlay (shadow root, injected by `agent.content.ts`) or the side panel and types the goal. The overlay posts `RUN_START {goal, tabId, originalUrl}` to the service worker.

2. **Run admission (gate).** The gate reads `sitePolicy` for the origin, confirms a live host permission via `chrome.permissions.contains`, resolves the active profile's policy defaults, creates a `runs` row with `state='planning'`, autonomy mode, the permitted-origin set, the declared inference posture, and the **shared** budget `(maxActions=40, maxRetriesPerStep=3, maxPlannerCalls=30, maxWallClockMs=720_000)`. It writes journal event `run.created`. It then hands `RUN_ADMITTED {runId, roster, scope, budgets, mode, posture}` to the Supervisor, whose roster here holds exactly one tab. **If the origin is not granted, the run never reaches the Supervisor.** If the posture is Local-only and no planner-capable local model answers, the run is refused here with a stated reason rather than started on a weaker model (§3.7.9).

3. **First perception.** The run's single Tab Agent requests `read_structure`. The gate forwards it to `agent.content.ts` on the bound tab. The content script waits for settle (§3.7.3), walks the DOM including open shadow roots, builds a **PerceptionSnapshot**: `epoch=1`, a pruned list of interactive elements each with an opaque handle (`e0…eN`), role, accessible name, type, current value shape, visibility, and enclosing form. Password / payment / OTP-classed fields are present in the snapshot as `{kind:'excluded'}` with **no value and no handle** — they cannot be addressed. The registry (handle → live node + re-resolution descriptor) stays in the content script; only the serialized snapshot crosses the boundary.

4. **Plan.** The Supervisor assembles the planner prompt from three structurally separate segments — `GOAL` (user text), `POLICY` (capability list, tier rules, budgets), `OBSERVATION` (the snapshot, fenced and labelled untrusted, §3.7.6) — and calls `routeInference` against the **planner model**. The response is parsed and validated by schema into a `Plan {steps[], willNotDo[], clarifyingQuestion?}`. Invalid output is retried once with a repair instruction, then the run fails with `MODEL_OUTPUT_INVALID` rather than guessing.

5. **Plan presentation.** `plan.proposed` is journaled; the cockpit renders the ordered steps and the explicit "what I will not do" list. In Suggest and Supervised modes the run holds at `awaiting_plan_approval`. The user edits step 4, removes step 7, presses Start. `plan.edited` and `plan.approved` are journaled with the user's version.

6. **Decide.** The Tab Agent takes the next step from the approved plan and resolves it against the current snapshot, using the cheap **judge tier** to pick the target handle among candidates. It produces `{verb:'type', handle:'e12', text:'Mohd Taha', reason:'Full name field, matched to profile fact name'}`. **The planner tier is not called here.** It is re-invoked only on one of the seven triggers in §3.7.20 — which for this journey fires three to six times across roughly thirty actions, not thirty times.

7. **Gate.** The gate re-validates against the persisted run row, not against anything the agent runtime asserted: run is `running`; `handle=e12` exists in snapshot `epoch=1` for this run and tab; the tab's current origin is still in scope; `verb=type` on a non-sensitive text input classifies **Low**; the action is on-goal; budget not exhausted; the stop flag in `chrome.storage.session` is clear. Permitted. `action.permitted` journaled.

8. **Act.** The gate hands the permitted action to the run's actuation backend (§3.7.12). On the default `dom-backend`, the content script resolves `e12` to a live node, checks it is still connected, visible, enabled and not obscured at its centre point (`elementFromPoint`), focuses it, and writes using the native value setter plus `input`/`change` dispatch — the technique the existing snippet manager already uses for React-controlled inputs. On the opt-in `cdp-backend` the same permitted action becomes `DOM.focus` plus `Input.dispatchKeyEvent`, producing trusted input. **The preceding step is byte-identical either way**: the gate does not know or care which backend will carry out what it permitted.

9. **Settle and verify.** The Settle Detector waits for the mutation/resource quiet window. The Verifier performs a **deterministic** state check: read `e12`'s value back and compare to the intended text. It also runs a negative check for a newly-appeared validation message inside the element's form. Result: `{verified:'confirmed', evidence:{value:'Mohd Taha'}}`. Journaled as `action.observed`. **No model call was needed** — the deterministic path (§3.7.4). Its share of all verifications is instrumented and reviewed, not fixed as a target; what §3.8 makes a hard gate is that a `confirmed` verdict is never wrong (§3.7.4).

10. **Iterate.** Steps 6–9 repeat. On field 5 the read-back returns empty: `verified:'failed'`, cause `WRITE_REJECTED`. The Tab Agent consults the recovery table (§3.3.2), selects *adapt*: `click(e17)` to focus first, then re-`type`. Second attempt confirms. The retry counter for that step increments; at 3 it would escalate.

11. **A step the agent cannot do.** The snapshot marks `e22` as `type=file`. The vocabulary has no `upload` verb. The Tab Agent emits `ask_user` with reason code `MISSING_CAPABILITY` — journaled, rendered in the cockpit as a question, and the run holds at `awaiting_user` without burning wall-clock budget.

12. **The boundary.** The plan's final step would `click(e30)`, accessible name "Submit application", `type=submit` inside a form. The gate classifies **Always**: irreversible and externally visible. It does not execute. It writes `approval.requested {verb, target label, origin, consequence}` and moves the run to `awaiting_approval`. The cockpit shows the specific action, on the specific site, with the reason. The user was told at plan time that this step exists; they now decline. `approval.denied` journaled; per PR-APR-5 the agent re-decides rather than aborting, and concludes the goal ("stop before submitting") is met.

13. **Report.** The Supervisor calls `finish`. The **Reporter reads the journal, not the planner**: 12 fields confirmed, 1 recovered on second attempt, 1 unconfirmed (a select whose page gave no readable post-state), 1 requiring a file the user must attach, Submit untouched. `run.completed` journaled with `outcome='completed_with_gaps'`. The cockpit renders the report; the dashboard keeps it in run history until the user's retention setting purges it.

14. **If anything dies mid-run.** The service worker may be terminated at any point between steps; it is stateless and re-derives everything from `runs`/`sitePolicy` on wake. If the *agent runtime* is lost (offscreen document closed, browser restart), the run is not silently resumed: on next start the SW finds a `runs` row in a non-terminal state, journals `run.interrupted`, and moves it to `halted`. **A run is never automatically resumed until the system can verify that the persisted state, page state, tab state, and element handles are still trustworthy** — and after an interruption it cannot, because every handle epoch is void and each tab may have navigated (§3.7.11).

#### 3.3.1b The same run across three tabs

Journey **J-4** in full: *"Compare these three monitors and tell me which suits a dual-screen coding setup under ₹30,000."* Only the differences from §3.3.1 are given.

1. **Roster construction (SURVEY).** The Supervisor enumerates candidate tabs with `chrome.tabs.query`. **It sees `url` and `title` only for tabs whose origin the user has already granted** — host permissions expose exactly those four sensitive `Tab` fields, and nothing else is visible (§3.7.18). The user confirms the three tabs. The roster is capped at 8. `run.roster` is journaled with one entry per tab.

2. **Budget split.** The run's `maxActions=40` is **shared across the whole roster, not multiplied by it**. Three tabs at 40 actions each would be 120 actions, which breaks the supervisability the budget exists to protect. Each Tab Agent draws from the shared pool and the Supervisor refuses a draw that would exhaust it.

3. **READ — bounded fan-out.** The Supervisor dispatches `read_structure` to all three Tab Agents concurrently, capped at **4 in flight** (§3.8). Each builds its own snapshot with its own epoch and its own handle namespace. Tab 2 is in a background window, so its settle detector runs under Chrome's clamped timers and uses the background calibration (§3.7.3).

4. **A tab fails; the others continue.** Tab 3's spec table is collapsed behind a "Show more" control, so extraction returns an anomalously low field count. Recovery happens **inside Tab Agent 3** — click the toggle, wait for settle, re-extract — and never reaches the Supervisor. Had local recovery been exhausted, Tab Agent 3 would enter `failed` with its partial journal intact while tabs 1 and 2 kept their results.

5. **SYNTHESISE.** The Supervisor aggregates by reading the **journal filtered by `tabId`**, not by trusting anything a Tab Agent reported about itself. This is what produces per-tab traceability: three of twenty-four cells are unknown, and each names the tab and URL it was missing from.

6. **ACT would be serial.** This journey writes nothing. Had the goal ended "…and add the winner to my cart", the Supervisor would leave READ, enter ACT, and drive **exactly one Tab Agent at a time** through a single approval. Concurrent approval requests are never issued (§3.7.16).

7. **A tab the user closes mid-run.** `chrome.tabs.onRemoved` moves that Tab Agent to `failed:TAB_CLOSED`, journaled, with the run continuing on the remainder. The agent never closes a tab it did not itself open (PR-NAV-6); tabs it opened via `open_tab` are closed at run end.

#### 3.3.2 Core runtime contracts

These five contracts are the seam every phase document builds against. Shapes are given at architecture depth; exhaustive field lists belong to the phase docs.

**(a) The capability vocabulary — eighteen verbs, closed set (nineteen from Phase 7).** The planner may emit nothing else. The set is enforced twice: the JSON schema derived from `action.schema.ts` constrains decoding where the engine supports it (§3.7.14), and the gate rejects unknown verbs before parsing arguments where it does not. Verbs are listed one per row so the count is checkable; earlier drafts of this document grouped paired verbs on shared rows and mis-stated the total as fifteen.

| Verb | Args | Class | Default tier |
|---|---|---|---|
| `read_page` | — | Perception | Low |
| `read_structure` | `region?` | Perception | Low |
| `read_element` | `handle` | Perception | Low |
| `look_at` | `handle \| 'viewport'` | Perception (visual escalation, §3.7.13) | Low |
| `wait_for_settle` | `maxMs?` | Perception | Low |
| `scroll` | `handle \| direction, amount` | Interaction | Low |
| `click` | `handle` | Interaction | **classified per target** |
| `type` | `handle, text, mode` | Interaction | Low, or Medium if replacing user text |
| `select` | `handle, value` | Interaction | Medium |
| `navigate` | `url` | Navigation | Medium; Always if unsaved input present |
| `history_back` | — | Navigation | Medium |
| `history_forward` | — | Navigation | Medium |
| `open_tab` | `url` | Navigation | Medium — **Phase 7 only** |
| `summarise` | `textRef, shape?` | Thinking | Low (no page access) |
| `transform` | `textRef, shape` | Thinking | Low (no page access) |
| `refactor` | `text` | Thinking | Low (existing agents) |
| `generate` | `description` | Thinking | Low (existing agents) |
| `ask_user` | `question, reason, options?` | Control | — |
| `finish` | `outcome, summary` | Control | — |

`request_approval` is deliberately **not** a verb. Approval is an outcome the gate produces, never something the planner can decide it needs or decide it does not need.

`look_at` is the one verb the planner cannot reach freely: the gate refuses it unless the run's journal shows one of the three trigger conditions in §3.7.13 for the current step. This keeps a screenshot from becoming the lazy default perception.

`ask_user` carries a **reason code** — `AMBIGUOUS_TARGET`, `MISSING_CAPABILITY`, `NEEDS_USER_DATA`, `SITE_BLOCKED` — journaled with the event. The rate of `MISSING_CAPABILITY` per run is the measurement that answers whether the vocabulary is large enough, at near-zero cost and without argument (§3.11 Q9).

**Three tab verbs were considered and rejected.** `close_tab`: PR-NAV-6 makes closing a prohibition rather than an approval gate, so the Supervisor closes only tabs it opened and the model never expresses it. `focus_tab` / `switch_tab`: tab selection is a Supervisor scheduling concern, and exposing it would let page content influence which tab receives attention — a cross-tab steering vector for no capability gain. **Tab-scoped variants** of `read_page`, `click` and the rest: a Tab Agent's verbs are implicitly scoped to its own tab, and adding a `tabId` argument would make cross-tab addressing *expressible*, which is exactly what §3.7.17 forbids.

When the deferred MCP capability lands (§3.7.15), its tools occupy a **separate namespace** — `mcp:<serverId>:<toolName>` — and never join this table. The browser vocabulary stays closed at eighteen.

**(b) `PerceptionSnapshot`** — the only view of a page the model ever receives.

```ts
interface PerceptionSnapshot {
  runId: string; tabId: number; epoch: number;   // handles are valid only within this epoch
  url: string; origin: string; title: string;
  settled: boolean; settleWaitedMs: number;
  elements: ElementDescriptor[];                 // pruned to the TOKEN budget (§3.8)
  excludedCount: number;                         // sensitive fields, counted not described
  regions: RegionCompleteness[];                 // per-region, never one global boolean
  unreachableRegions: string[];                  // closed shadow roots, cross-origin iframes
}

interface RegionCompleteness {
  regionId: string;                // form id, landmark role, or repeating-block signature
  label: string;                   // human-readable, for the cockpit and the report
  complete: boolean;               // false => this region was pruned
  shown: number; total: number;    // so the planner can see HOW much is missing
}

interface ElementDescriptor {
  handle: string;            // "e12" — opaque, allocated by the content script
  role: string;              // button | textbox | link | checkbox | combobox | …
  name: string;              // accessible name, whitespace-normalised, ≤120 chars
  tag: string; inputType?: string;
  valueShape?: 'empty' | 'filled' | string;   // literal only for non-sensitive fields
  enabled: boolean; visible: boolean; inViewport: boolean;
  formId?: string; ordinal: number;           // disambiguates identical names
}
```

`unreachableRegions` is load-bearing: PRD §9.2 requires unreachable content be *reported*, never treated as empty.

`regions` replaces the single `truncated: boolean` of the first draft, and the change is not cosmetic. A global flag tells the planner *that* something was dropped but not *what*, which is precisely the pruning that can silently hide the element a task needs. Per-region completeness makes the gap addressable: the planner can see that the form it is working in is complete while a sidebar was pruned, and `read_structure {region}` exists to fetch what was left out. **Pruning is structure-aware** (§3.7.21): it never truncates inside the form the current step targets, and never partially truncates a repeating block — a half-listed table would also silently corrupt the `count` verification kind.

**(c) `ActionRequest` → `ActionOutcome`** — the gate's input and the journal's raw material.

```ts
interface ActionRequest {
  runId: string; tabId: number;    // tabId is mandatory: the gate resolves origin from THIS tab
  epoch: number;                   // valid only within this tab's snapshot epoch
  verb: Verb; args: unknown; reason: string;
}

interface ActionOutcome {
  requestId: string; verb: Verb; permitted: boolean;
  tier: 'low' | 'medium' | 'always' | 'never';
  refusal?: RefusalCode;                       // OUT_OF_SCOPE | NEVER_TIER | OFF_GOAL | BUDGET
                                               // | STOPPED | UNKNOWN_HANDLE | HANDLE_NOT_OWNED
  verified: 'confirmed' | 'unconfirmed' | 'failed';
  evidence?: { before?: string; after?: string; check: VerificationKind };
  failureCause?: FailureCause;
  costedActions: number; elapsedMs: number;
}
```

`verified` has exactly three values by design. There is no fourth for "we assume so" (PR-VER-7, PP-5).

`HANDLE_NOT_OWNED` is the refusal that makes cross-tab isolation enforceable rather than conventional: a handle allocated in tab 2's registry presented on a request naming tab 1 is refused at the gate, before any backend sees it (§3.7.17).

**(e) `TabStatus`** — the Supervisor's view of one tab. The cockpit renders the roster from this; aggregation reads the journal, never this.

```ts
interface TabStatus {
  tabId: number; origin: string; title: string;
  state: 'pending' | 'reading' | 'read' | 'acting' | 'failed' | 'done';
  epoch: number;                   // current snapshot epoch for this tab
  actionsDrawn: number;            // against the run's SHARED budget, not a per-tab one
  failureCause?: FailureCause;     // set iff state === 'failed'
  localRecoveries: number;         // attempts resolved inside the Tab Agent
}
```

A Tab Agent in `failed` keeps its partial journal and its results stay in the aggregate; the run continues on the remaining tabs. This is the J-4 requirement — one page's specs collapsed behind a control must not cost the other two.

**(d) The recovery table** — the mapping from `FailureCause` to response. Cause interpretation is the whole of recovery (concept §7.2); a uniform retry is the failure mode being designed out.

| `FailureCause` | Detected by | Response | User involved |
|---|---|---|---|
| `NOT_SETTLED` | settle timeout, or read-back differs from a second read | retry same action after settle | no |
| `TARGET_MISSING` | handle no longer resolves, descriptor re-resolution finds nothing | re-snapshot, replan the step | no |
| `TARGET_AMBIGUOUS` | descriptor re-resolves to >1 node | **stop the step and ask** — never pick one | yes |
| `OBSCURED` | `elementFromPoint` at target centre returns a non-descendant | dismiss overlay if it is a known banner shape, retry once, else ask | usually no |
| `WRITE_REJECTED` | read-back after `type` ≠ intended | focus-then-retype, then re-verify | no |
| `AUTH_REQUIRED` | login form appears where content was expected | pause → offer take-over → resume with fresh snapshot | yes |
| `SITE_REFUSED` | 429, bot-challenge markers, repeated identical refusals | **end the run**, report honestly, do not circumvent (PP-9) | informed |
| `NAVIGATION_FAILED` | URL unchanged past timeout, or error page | one retry, then ask | maybe |
| `PARTIAL_EFFECT` | a submit/send produced an error banner | never auto-retry; approval required to retry (PR-REC-7) | yes |
| `MODEL_OUTPUT_INVALID` | schema validation of planner output fails | one repair attempt, then fail the run with the raw output journaled | informed |
| `STUCK` | same verb+handle+args 3× with identical outcome | end the run as *stuck*, distinct from *failed* (PR-REC-9) | informed |
| `TAB_CLOSED` | `chrome.tabs.onRemoved` for a roster tab | that Tab Agent → `failed`; run continues on the rest; never reopen the tab | informed |
| `BACKEND_DETACHED` | `chrome.debugger.onDetach`, any reason | **halt the run and surface the reason.** Never silently fall back to `dom-backend` (§3.7.12) | yes |

---

### 3.4 Tech Stack

| Layer | Choice | Justification |
|---|---|---|
| **Extension framework** | WXT 0.20+ | Already in use and working; file-based entrypoints, Vite under the hood, generated manifest. The offscreen-document-as-entrypoint fix (`Docs/TECHNICAL_DECISIONS.md §7`) depends on WXT's bundling, and re-platforming would re-break it |
| **Language** | TypeScript 5.9+, `strict: true` | Already present. `strict` is not currently enforced beyond `tsc --noEmit` run by hand; the gate and the contracts in §3.3.2 are only worth writing under strict null checks |
| **UI** | React 19 + Tailwind 3.4 | Both already dependencies. Side panel and dashboard use Tailwind; the in-page overlay keeps the existing inline-style approach because the shadow root should not carry a Tailwind bundle onto every granted page |
| **Cockpit surface** | `chrome.sidePanel` (Chrome 114+) | The only extension surface that survives page navigation *and* sits beside the page. A run that navigates would destroy an in-page React tree and its state |
| **Run persistence** | Dexie 4 over IndexedDB, schema v2 | Already the store. Journal writes are append-only single-table adds — Dexie's transaction model is sufficient and adds no new dependency |
| **Ephemeral run control** | `chrome.storage.session` | Stop flags and approval tokens must be readable by the gate on a cold service-worker wake, must not survive a browser restart, and must never hit disk. `session` is exactly this; `local` is wrong (persists) and in-memory is wrong (dies with the SW) |
| **Schema validation & constrained decoding** | Zod 4+ | **New dependency.** Every untrusted structure — planner output, cross-context messages, MCP tool results if that ever lands — needs one validator, not the hand-rolled brace-repair ladder currently in `scorer.ts`. Version 4 specifically, because its native `z.toJSONSchema()` lets a *single* schema serve as both the gate's runtime validator and the JSON Schema handed to a constrained-decoding engine. Two sources of truth for the action shape would be a bug waiting to happen |
| **Planner-tier inference** | Ollama 7–14B on `localhost:11434`, **or** a remote provider on a user-held key (Groq / Anthropic / OpenAI-compatible) | **Changed from the first draft.** Multi-step planning over ~120 element descriptors, under adversarial page content, with recovery reasoning, is not work a 1.5–4B in-browser model does adequately — it produces confidently wrong plans, which is a PP-6 failure at the point it costs most. There are exactly three paths to planner-grade reasoning and the in-browser tier is not one of them (§3.7.9). Ollama is the local path and keeps a genuine Local-only posture; the remote path is opt-in, disclosed before the run, and uses a key the user holds |
| **Judge-tier inference (primary)** | Chrome Built-in AI **Prompt API** (`LanguageModel`, Gemini Nano), Chrome 138+ | Available to extensions without an origin trial; the model is browser-managed, so we stop shipping users a multi-gigabyte download of our own. Two capabilities decide it: `responseConstraint` accepts a JSON Schema and constrains generation, which turns the closed verb vocabulary from a thing we validate into a thing the decoder cannot violate; and it accepts image input, which gives us a local vision engine without adding a second ML runtime. Verification, target disambiguation, suspicion scoring and text condensation are short, narrow, high-frequency calls — exactly what a small instruct model is good at. **Unavailable in Web Workers**, which is a second independent reason the runtime belongs in the offscreen document rather than the service worker. **Its reachability from an offscreen document is unverified and is a Phase 1 go/no-go (§3.11 Q11)** |
| **Judge-tier inference (fallback)** | `@mlc-ai/web-llm` 0.2.78+ in the offscreen document | Built and working: model state machine, Cache API download detection, `initProgressCallback`, VRAM keep-alive, GPU-device-lost recovery. Retained unchanged in mechanism, for two things it is better at than the built-in model: the user chooses and *pins* the exact weights, and it works where Chrome's built-in model is unavailable. It has **no constrained-decoding mechanism**, so the validate-and-repair path (§3.7.14) is its fallback and is tested as such |
| **Inline-completion inference** | Chrome Prompt API warm session, `clone()` per request — **local only, no remote path exists** | A separate tier because the workload is separate: short continuations at very high call frequency with a ≤400 ms budget. It is local by decision, not by preference — autocomplete has no *run*, so PR-PRV-6's per-run disclosure cannot cover it, and keystrokes on arbitrary sites reaching a remote provider under a global toggle is the exact thing the security model exists to prevent (§3.7.22). Chrome's own guidance — keep a session warm, `clone()` it per prompt — is the mechanism the budget depends on |
| **Vision engine** | Local: the Prompt API's image input. Remote (Hybrid runs only): a vision-capable model over the planner path | Two engines, chosen by the run's inference posture and disclosed before the run starts. §3.7.13 states plainly which cases the local engine is not good enough for |
| **Remote inference** | Groq and OpenAI-compatible providers, on a user-held key, optional | Its role has changed twice. It is no longer a silent fallback beneath every call, and it is no longer only a convenience: it is now the **primary planner path for users without Ollama**, reached only on a run explicitly declared Hybrid |
| **Local network inference** | Ollama on `localhost:11434`, optional | Promoted from convenience to **the definition of Local-only**. It is the only way to run a planner-capable model (7B\u201314B) on the user's own machine, so a Local-only multi-step run requires it, and a user without it is told so before the run rather than given a degraded planner (\u00a73.7.9) |
| **Readable text extraction** | `@mozilla/readability` 0.5 | Retained for the `read_page` verb only. It is the wrong tool for `read_structure` \u2014 it deliberately discards the interactive chrome the agent needs. Its output is **raw page content**, which puts it in disclosure class B (\u00a73.7.23) rather than class A |
| **Change detection** | `MutationObserver` + `PerformanceObserver('resource')` | Platform APIs, no dependency. Both observe from the isolated world without patching page globals, which a MAIN-world `fetch` monkeypatch would require |
| **Tokenizer** | `gpt-tokenizer` 2.8 | Already present for the context cap. Reused to enforce the observation token budget (§3.8) before a snapshot reaches the planner |
| **Unit tests** | Vitest 2+ | **New.** Vite-native, so it shares WXT's transform pipeline with no second build config. The gate, the tier classifier, the scrubber, the settle heuristic and the journal reducer are all pure functions and all currently untested |
| **End-to-end tests** | Playwright 1.4x with a persistent context loading the unpacked build | **New.** `SC-6` (stop halts mid-flight) and the never-tier prohibitions cannot be proven by unit tests. Playwright is the only mature runner that can drive a real Chromium with an extension loaded |
| **CI** | GitHub Actions | **New.** `PRE-6` makes a test practice a shipping gate. Typecheck + unit + a small e2e suite on every push |
| **Agent framework** | None — a hand-written Run Supervisor over N Tab Agents | Re-evaluated three times against LangGraph.js / LangChain.js, most recently against the multi-tab requirement specifically, and against the shipped packages rather than documentation. The measured basis is in §3.5.1. Short form: the framework's fan-out strength lands on *reads*, which are idempotent and cheap to redo, while its human-in-the-loop primitive is unusable in a browser under exactly the fan-out that multi-tab needs |
| **Orchestration shape** | `lib/agent/supervisor.ts` + `lib/agent/tab-agent.ts` | Single-tab is the one-Tab-Agent case, so the near-term multi-tab requirement (PR-NAV-4/5, J-4) is an instantiation rather than a second orchestration migration. The split follows the read/write seam the safety model already draws (§3.7.16) |
| **Run state machine** | Hand-written transition table in `lib/agent/run-state.ts`, plus a five-state per-tab enum in `TabStatus` | Re-examined against XState in \u00a73.5.1, including under multi-tab. The run machine is shared verbatim by the Supervisor and the gate, and the gate \u2014 routinely cold-started \u2014 must answer `canAct(state, tabId)` from a persisted string without rehydrating an interpreter |
| **Tool interoperability** | None until Phase 13; MCP contract fixed now in §3.7.15 | The 2026-07-28 MCP transport is simple enough to implement directly, but its OAuth 2.1 surface is a phase of work and it introduces a second untrusted domain before the first is proven. Its start is **evidence-gated, not date-gated** (§3.11 Q13). Deferred, not dismissed — §3.5.2 |

---

### 3.5 Why NOT These Alternatives

Entries below have been re-evaluated three times: against current documentation after the first draft, then against the shipped packages, then against the near-term multi-tab requirement. Three changed verdict and one changed its *reason* entirely. The section is split accordingly: **§3.5.1 is what we are not building**; **§3.5.2 is what we are building but not by default, or not yet**. Nothing appears in both. Where a rejection rests on a measurement, the measurement is given rather than asserted.

#### 3.5.1 Rejected outright

| Rejected | Reason |
|---|---|
| **LangGraph.js / LangChain.js as the agent runtime** | **The reason has changed; the verdict has not.** The first draft rejected this on durable execution and non-idempotent replay. That argument was overstated and is withdrawn: measured against `@langchain/langgraph` 1.4.13, replay on resume is scoped to *exactly the node that was in flight* (a completed node's writes are keyed by a deterministic task id and skipped), and `getState().next` names that node **before** you resume — so refusing to resume a dispatched click is a decision the framework hands us, not one it takes. The rejection now rests on three measured findings against the multi-tab requirement. **First**, the browser build is genuinely good at fan-out: a three-way `Send` with a failure in branch 3 preserved the other two branches' results, replayed only the failed branch, and honoured a static `interruptBefore` — the J-4 shape, working, with no shim. **Second**, its human-in-the-loop primitive is not. `interrupt()` throws in a browser (`@langchain/core` falls back to `MockAsyncLocalStorage`); a single-slot `AsyncLocalStorage` shim fixes the linear case and **provably corrupts under fan-out** — one of three concurrent branches read `undefined` config, and an `interrupt()` inside a parallel branch threw outright, while the identical graph on Node's real `AsyncLocalStorage` worked perfectly. The fault is the browser environment, so it is not ours to fix: `langgraphjs#879` is open and unassigned, and TC39 AsyncContext is Stage 2 and stalled on implementer concerns. The browser-viable substitute, `interruptBefore`, is the path upstream's own type docs tell you not to prefer, and resuming it with `Command({goto})` **executes the pending node anyway** — measured: the reject path still clicked. **Third**, the asymmetry that follows. The framework's strength lands on reads, which are idempotent and cost a few hundred milliseconds to redo; its weakness lands on approval, the most safety-critical flow in the product. Cost of adopting regardless: **233 KB gzipped** measured over a Zod-4 baseline (of which 202 KB is `langsmith`, imported at module scope by core's ALS singleton and never called by us), plus a checkpointer holding run state that overlaps the journal in a different shape — two sources of truth in the one subsystem whose failure mode is "the report becomes incomplete". **What we keep:** a checkpoint per step and explicit interrupt/resume states, implemented as the journal and the run state machine. **Adoption trigger, stated so it can actually fire:** a documented, supported browser tier with a working `interrupt()`, or AsyncContext reaching Stage 3 with a Chrome intent to ship |
| **`langchain`'s `createAgent` and middleware, without LangGraph** | Not an available option, which is worth recording because it looks like one. `langchain` 1.5.10 depends on `@langchain/langgraph` ^1.4.10 — `createAgent` **is** a prebuilt LangGraph graph. Adopting it means adopting LangGraph plus a ReAct shape we did not choose, plus a `BaseChatModel` implementation for each of our four tiers, plus surrendering `responseConstraint`: constrained *decoding* has no expression in `withStructuredOutput`, which is a post-hoc parse. That would trade away the mechanism §3.7.14 depends on |
| **XState for the run state machine** | **Settled, not deferred — and the earlier revisit trigger was badly specified.** The first draft named multi-tab as the condition under which XState becomes correct. Multi-tab is now near-term, so the trigger was tested rather than left to fire on its own. It fires literally — during the READ phase N Tab Agents genuinely are in concurrent sub-lifecycles — but the conclusion does not follow: those regions are **isolated and non-communicating by design** (§3.7.17), and N identical non-communicating machines need an array, not statechart hierarchy. The run-level machine is unchanged at 11 states and ~30 flat edges; each Tab Agent carries a five-state enum. The decisive objection is untouched by multi-tab: the machine is enforced in **two processes from a persisted state string**, and the gate — routinely cold-started — must answer one boolean, `canAct(state, tabId)`, on the critical path of every action. Rehydrating an interpreter to do that is disproportionate and puts a library between a security-critical predicate and its reviewer. **Replacement trigger, written so it is capable of firing:** cross-tab state dependencies, where one tab's transition depends on another tab's state. The isolation property forbids that by construction, so on the current architecture this trigger can never fire — which is the honest way to say XState is rejected rather than pending |
| **Screenshot-plus-vision as the *primary* perception layer** (Set-of-Mark and similar) | Distinct from the visual escalation we **are** building (§3.5.2, §3.7.13). Rejected as the default because every MVP journey — form fill, structured extraction, buried settings, page comparison, draft-and-stop, in-place rewrite — is DOM-legible, and a viewport image costs roughly two orders of magnitude more payload per step than 120 element descriptors while discarding exactly the thing the gate needs: stable, addressable handles. Grounding a click in pixel coordinates also reintroduces the forged-target problem that opaque handles eliminate |
| **Pro Prompt as an MCP *server*** | The obvious and attractive inverse — expose `read_page`, `read_structure` and gated `click`/`type` to Claude Desktop or an IDE. It is rejected on a hard platform fact rather than a preference: an extension cannot listen on a socket, so a Streamable HTTP endpoint requires a companion native-messaging host or a local daemon. That is a server component, and "no server at all" is both the product's differentiator and a safety argument for software that reads private pages (C-1) |
| **Transformers.js / ONNX Runtime Web as a second local ML runtime** | The route to a local VLM (SmolVLM, Florence-2, Moondream) now that WebLLM has no vision support. Rejected because it means a second inference engine, a second model catalogue, a second download-and-VRAM story, and a second set of failure modes — to serve a capability that fires on a minority of steps. The Prompt API's image input covers the local vision case at zero marginal runtime cost, and where it is not good enough the honest answer is a remote model on a disclosed Hybrid run, not a second engine |
| **`chrome.automation` / the platform accessibility tree** | The right data model, and unavailable to ordinary desktop-Chrome extensions. Note the consequence for §3.5.2: `Accessibility.getFullAXTree` over CDP is the *only* route to a browser-computed AX tree, which is a large part of why the CDP backend was reconsidered |
| **Recorded-macro replay (record once, replay selectors)** | Cheap, deterministic, and would make many tasks work immediately. Rejected because it is brittle by construction and contradicts the recovery model — a replayed selector cannot notice that a modal appeared. PR-TASK-2 settles this at product level: a saved task is a goal, not a macro |
| **A backend orchestrator (planner on a server, thin extension client)** | **Reason rewritten.** The first draft rejected this because "no server at all is the differentiator". Once planning is remote by default for users without Ollama (§3.7.9), that sentence is no longer true as written, and leaving it would make this document contradict itself. The rejection survives in the form that actually matters: **Pro Prompt operates no server of its own.** A user's key going directly to a provider they chose is a relationship we broker but do not sit inside — we never see the traffic, never hold the key, and never become a party that could be compelled to retain page content. A Pro Prompt-operated orchestrator would reverse all three, and would also make every user's page content transit our infrastructure by default rather than by their choice. What is *not* claimed any more is that nothing leaves the machine (§3.7.23) |
| **Vector store / embeddings for run memory or task recall** | Explicitly Cerebro's territory (PRD §7.2). Run memory stays scoped to the current run's journal; task discovery uses tags, recency and usage count, which fits a few dozen local records better anyway |
| **CSS selectors emitted by the model** | A security decision, not an ergonomic one: a model that can name an arbitrary selector can be talked into naming any element on the page, including one the snapshot deliberately excluded. Opaque handles make the wrong target *inexpressible* |
| **Keeping the run loop in the service worker** | The smallest change from today. Rejected: MV3 terminates the worker on idle, the current mitigation is three keep-alive timers pinging every tab, and it still cannot hold state across a termination. Independently confirmed by the Prompt API's unavailability in Web Workers |

#### 3.5.2 Adopted, but optional or deferred — not rejected

These are real parts of the architecture. They are separated from the stack table because each is either off by default or scheduled after MVP, and calling any of them "rejected" would be false.

| Technology | Status | Where it sits | Why not default / not yet |
|---|---|---|---|
| **`chrome.debugger` / CDP actuation backend** | **Optional, opt-in — Phase 9** | `lib/actuation/cdp-backend.ts`, beneath the Policy Gate (§3.7.12) | Buys trusted input and a real accessibility tree, which between them retire the `WRITE_REJECTED` failure class and sharply reduce `TARGET_AMBIGUOUS`. Costs a heavyweight permission most users filling in two forms should not have to grant, conflicts with DevTools on the same tab, and is Chromium-only. Correct as an escalation the user enables, wrong as a baseline |
| **Visual escalation (`look_at` + screenshots)** | **Optional capability — Phase 10** | `lib/vision/`, one verb, three trigger conditions (§3.7.13) | Genuinely necessary for canvas-rendered UI, identical-label disambiguation, and verification the DOM cannot confirm. Not necessary for any MVP journey, so it lands after recovery exists to tell it when to fire |
| **MCP client** | **Phase 13, evidence-gated; contract fixed now (§3.7.15)** | `lib/mcp/`, tools in their own `mcp:<server>:<tool>` namespace | The 2026-07-28 spec made the transport easy — stateless POST-per-message, no sessions, no GET stream — but the official TypeScript SDK v2 targets Node/Bun/Deno and is not browser-compatible, so the client is ours to write, and MCP's OAuth 2.1 surface (protected-resource metadata discovery, PKCE, resource indicators, `iss` validation, step-up scopes) is a phase of work on its own. Two further concrete frictions: local servers **MUST** validate `Origin`, and ours is `chrome-extension://<id>`; and Client ID Metadata Documents want an HTTPS-hosted JSON, which sits awkwardly in a product with no hosting. Deferred on cost and sequencing — the second untrusted domain should not arrive before the first one is proven — not on principle. The first slice when it comes is read-only tools on unauthenticated or bearer-token servers |

### 3.6 Project Directory Structure

This tree is the contract. Phase documents create exactly these files; a file not listed here requires an amendment to this document. `[built]` files exist today and are modified in place; everything else is new.

```
pro-prompt-engine/
├── entrypoints/
│   ├── background.ts                  # [built] SW: message router; becomes the Policy Gate host. Keep-alive removed
│   ├── agent.content.ts               # [new] Replaces content.ts. Registered ONLY on granted origins.
│   │                                  #       Hosts registry, perception, settle, actuator, verifier, overlay
│   ├── offscreen/
│   │   ├── index.html                 # [built] Offscreen host page
│   │   └── main.ts                    # [built] WebLLM engine host; gains the Supervisor bootstrap
│   ├── sidepanel/
│   │   ├── index.html                 # [new] Side-panel document
│   │   ├── main.tsx                   # [new] React root
│   │   └── Cockpit.tsx                # [new] Goal, plan, live steps, approvals, controls
│   ├── options/
│   │   ├── index.html                 # [built]
│   │   ├── main.tsx                   # [built]
│   │   └── App.tsx                    # [built] Rebuilt around Runs / Tasks / Permissions / Profile+Policy / Models
│   └── popup/
│       ├── index.html                 # [built]
│       ├── main.tsx                   # [built]
│       └── App.tsx                    # [built] Reduced to: active run status, grant this site, open cockpit
│
├── lib/
│   ├── agent/                         # [new] THE AGENT RUNTIME — offscreen document
│   │   ├── supervisor.ts              #   Run Supervisor: roster, phase machine, shared budget,
│   │   │                              #     bounded read fan-out, aggregation, cancellation
│   │   ├── tab-agent.ts               #   One per tab. observe → decide → request → verify, for ONE tab.
│   │   │                              #     Holds that tab's snapshot, epoch and handles; nothing else
│   │   ├── tab-roster.ts              #   TabStatus records, tabs.onRemoved handling, roster cap
│   │   ├── run-state.ts               #   Run machine + legal transitions (shared with the gate),
│   │   │                              #     plus the five-state per-tab enum
│   │   ├── planner.ts                 #   Goal → Plan. Invoked on the §3.7.20 triggers, NOT per step
│   │   ├── step-resolver.ts           #   Plan step + snapshot → ActionRequest, judge tier only.
│   │   │                              #     This is the per-step hot path; the planner is not
│   │   ├── prompts.ts                 #   Verbatim planner/judge system prompts and the untrusted frame
│   │   ├── budget.ts                  #   Shared action/retry/wall-clock counters; planner-call budget;
│   │   │                              #     stuck detection. Budgets are per RUN, never per tab
│   │   ├── recovery.ts                #   FailureCause → response, per the §3.3.2 table
│   │   ├── journal.ts                 #   Append-only writer. The ONLY path into runEvents. Tags tabId
│   │   └── reporter.ts                #   Journal → report, grouped by tab. Reads no planner output
│   │

│   ├── policy/                        # [new] THE GATE — runs in the service worker
│   │   ├── gate.ts                    #   The eight ordered checks of §3.3.1 step 7. No model calls, ever
│   │   ├── ownership.ts               #   handle ↔ tab binding; the HANDLE_NOT_OWNED refusal (§3.7.17)

│   │   ├── tiers.ts                   #   Action + target + origin → Low|Medium|Always|Never
│   │   ├── never-rules.ts             #   Sensitive-field and sensitive-origin classifiers. No override path
│   │   ├── scope.ts                   #   Origin grants, chrome.permissions bridge, mid-run revocation
│   │   ├── goal-anchor.ts             #   Is this action consistent with the run's ORIGINAL goal
│   │   └── suspicion.ts               #   Hidden text, instruction-shaped content, origin drift, credential asks
│   │
│   ├── actuation/                     # [new] Backends — run in the service worker, BENEATH the gate
│   │   ├── backend.ts                 #   ActuationBackend interface: perceive / act / capture / attach / detach
│   │   ├── dom-backend.ts             #   Default. Proxies to agent.content.ts. No extra permission
│   │   └── cdp-backend.ts             #   [Phase 9, opt-in] chrome.debugger: AX tree, trusted input, clipped capture
│   │
│   ├── vision/                        # [new, Phase 10] Visual escalation — never primary perception
│   │   ├── triggers.ts                #   The three conditions under which `look_at` is permitted at all
│   │   ├── capture.ts                 #   captureVisibleTab + OffscreenCanvas crop, or CDP clip; downscale to budget
│   │   └── look.ts                    #   Prompt-API image call (local) or remote vision call (Hybrid runs only)
│   │
│   ├── mcp/                           # [Phase 13, evidence-gated; contract in §3.7.15, do not build early]
│   │   ├── client.ts                  #   Streamable HTTP (2026-07-28): POST per message, per-request SSE, no sessions
│   │   ├── oauth.ts                   #   OAuth 2.1: PRM discovery, PKCE, resource indicators, iss validation
│   │   ├── registry.ts                #   Enrolled servers, per-tool enablement, user-assigned tier (default Always)
│   │   └── untrusted.ts               #   Tool descriptions and results into the same nonce-fenced frame as page text
│   │
│   ├── page/                          # [new] THE BODY — runs in the content script
│   │   ├── registry.ts                #   handle ↔ node, epochs, descriptor-based re-resolution
│   │   ├── perception.ts              #   DOM + open shadow roots → PerceptionSnapshot; pruning and capping
│   │   ├── settle.ts                  #   MutationObserver + PerformanceObserver quiet-window detector
│   │   ├── actuator.ts                #   click / type / select / scroll, with pre-action target re-checks
│   │   ├── verifier.ts                #   Deterministic state/appearance/disappearance/negative/location checks
│   │   ├── sensitive.ts               #   Field classifier used to exclude before a value is ever read
│   │   └── overlay/
│   │       ├── mount.ts               #   Shadow-root host, lifecycle across SPA navigation
│   │       ├── GoalBox.tsx            #   In-page goal intake (PR-UX-1)
│   │       └── RunBadge.tsx           #   Current step, target highlight, always-present STOP
│   │
│   ├── model/                         # [new] Tier routing. Replaces the flat cascade in llm-router
│   │   ├── router.ts                  #   tier → engine. HARD no-cascade across the local/remote
│   │   │                              #     boundary; within-locality fallback only (§3.7.9)
│   │   ├── tiers.ts                   #   planner | judge | vision | inline — capabilities and budgets
│   │   ├── posture.ts                 #   Local-only vs Hybrid; pre-run disclosure payload (§3.7.23)
│   │   └── minimise.ts                #   Disclosure class A/B split; local condensation of raw page
│   │                                  #     text before any remote call (§3.7.23)
│   │
│   ├── adapters/                      # [built] Retained as plumbing

│   ├── agents/                        # [built] Text capabilities — now agent verbs, not top-level features
│   │   ├── refactor.ts                #   [built]
│   │   ├── scorer.ts                  #   [built] Kept internal; never surfaced as an objective measure (C-6)
│   │   ├── generator.ts               #   [built]
│   │   ├── comprehension.ts           #   [built] Becomes the `summarise` verb
│   │   ├── loop-controller.ts         #   [built] Refactor loop, unchanged; must stay off the agent path (PP-8)
│   │   └── context-update-agent.ts    #   [dead] Stays dead until Phase 8 decides; not deleted, not wired
│   │
│   ├── db/
│   │   ├── dexie-db.ts                #   [built] Schema v2 + migration
│   │   ├── runs.ts                    #   [new] Run and journal queries; retention purge
│   │   └── policy-store.ts            #   [new] Per-origin grants, capability limits, autonomy defaults
│   │
│   ├── cache/
│   │   ├── cache-manager.ts           #   [built-broken] isActive index bug and stub-poisoning fixed (PRE-3)
│   │   └── lru-cache.ts               #   [built]
│   │
│   ├── ui/
│   │   ├── snippet-manager.ts         #   [built-broken] Popover moved into a shadow root; no innerHTML
│   │   └── autocomplete-manager.ts    #   [built-broken] Rebuilt in Phase 4: local-only inference,
│   │                                  #     origin-granted only, shares page/sensitive.ts (§3.7.22)
│   │
│   ├── utils/
│   │   ├── pii-scrubber.ts            #   [built-broken] Phone rule narrowed; sensitive-field bypass removed
│   │   ├── token-counter.ts           #   [built] Also enforces the observation token budget
│   │   ├── debounce.ts                #   [built]
│   │   └── result.ts                  #   [new] Typed Result/Outcome helper; no throw across context boundaries
│   │
│   ├── schemas/                       # [new] Zod 4 schemas — the trust boundary, and the decoding constraint
│   │   ├── action.schema.ts           #   Verb union, per-verb args, ActionRequest. z.toJSONSchema() feeds
│   │   │                              #     responseConstraint; the same object validates at the gate
│   │   ├── plan.schema.ts             #   Plan, PlanStep, clarifying question
│   │   ├── snapshot.schema.ts         #   PerceptionSnapshot, ElementDescriptor
│   │   └── message.schema.ts          #   Every cross-context message payload
│   │
│   └── types/
│       ├── message.types.ts           #   [built] Extended with run/gate/perception message types
│       ├── llm.types.ts               #   [built] Model union corrected to the six actually offered
│       ├── profile.types.ts           #   [built] Gains AgentPolicy: default mode, origins, capability limits
│       ├── snippet.types.ts           #   [built]
│       ├── run.types.ts               #   [new] Run, RunState, RunEvent, Report
│       └── agent.types.ts             #   [new] Verb, ActionRequest, ActionOutcome, FailureCause, Tier
│
├── tests/                             # [new] — none of this exists today
│   ├── unit/
│   │   ├── tiers.spec.ts              #   Every row of the tier table, both directions
│   │   ├── never-rules.spec.ts        #   Sensitive-field classifier against a fixture corpus
│   │   ├── gate.spec.ts               #   Each of the six checks, each refusal code
│   │   ├── settle.spec.ts             #   Quiet-window behaviour under synthetic mutation streams
│   │   ├── recovery.spec.ts           #   FailureCause → response mapping
│   │   ├── run-state.spec.ts          #   Every legal edge, and that every illegal edge is refused
│   │   ├── vision-trigger.spec.ts     #   `look_at` refused unless one of the three triggers is in the journal
│   │   ├── journal.spec.ts            #   Report contains nothing absent from the journal
│   │   ├── supervisor.spec.ts         #   Phase machine, shared-budget draw, aggregation by tabId
│   │   ├── ownership.spec.ts          #   A tab-2 handle on a tab-1 request is refused (§3.7.17)
│   │   ├── pruning.spec.ts            #   Structure-aware pruning never splits a form or a repeating block
│   │   ├── replan-trigger.spec.ts     #   Each of the seven §3.7.20 triggers fires, and nothing else does
│   │   └── scrubber.spec.ts           #   Including the false-positive cases the audit names
│   ├── e2e/
│   │   ├── fixtures/                  #   Local static pages: forms, overlays, React inputs, injected text
│   │   ├── stop.spec.ts               #   SC-6: stop halts before the in-flight action completes
│   │   ├── never-tier.spec.ts         #   SC-2: password/payment/OTP never read or typed
│   │   ├── scope.spec.ts              #   SC-3: no action on a non-granted origin
│   │   ├── backend-parity.spec.ts     #   Same run, both backends, identical gate decisions and journal shape
│   │   ├── cdp-sensitive.spec.ts      #   CDP key dispatch never lands on an excluded field (§3.7.12)
│   │   ├── cross-tab.spec.ts          #   Isolation: no tab can address, read or act on another's handles
│   │   ├── multi-tab.spec.ts          #   J-4: one tab fails, the other two complete and aggregate
│   │   └── form-fill.spec.ts          #   J-1 end to end against a local fixture
│   ├── captures/                      #   [new] Frozen HTML+asset captures of real sites, served by
│   │                                  #     Playwright. Messy like the live web, deterministic like a
│   │                                  #     fixture — the layer neither of the other two provides (Q5)
│   ├── eval/
│   │   ├── suite.ts                   #   Runs fixtures + captures + the live set; emits the metric table
│   │   └── metrics.ts                 #   Hard gates vs tracked gauges, kept structurally distinct
│   └── redteam/
│       └── injection-corpus/          #   Hostile pages: hidden instructions, fake approvals, origin drift
│
├── Docs/
│   ├── planning/
│   │   ├── PRO_PROMPT_BROWSER_AGENT_CONCEPT.md   # [built]
│   │   ├── PRO_PROMPT_BROWSER_AGENT_PRD.md       # [built]
│   │   ├── architecture.md                        # this document
│   │   └── phase_1..14_*.md                   # [new] written after this is approved
│   ├── ARCHITECTURE.md                # [built] Legacy engine doc; superseded, to be marked as such
│   └── TECHNICAL_DECISIONS.md         # [built] Retained; extended per phase
│
├── .github/workflows/ci.yml           # [new] typecheck → unit → build → e2e
├── wxt.config.ts                      # [built] Permissions rewritten (§3.9)
├── vitest.config.ts                   # [new]
├── playwright.config.ts               # [new]
├── package.json                       # [built] test/lint scripts added
└── README.md                          # [built] Rewritten; the audit records it overstates current behaviour
```

**Dexie schema v2** — three new tables, migrated from v1:

| Table | Keys / indexes | Purpose |
|---|---|---|
| `runs` | `++id, state, startedAt, origin` | One row per run: goal, plan, mode, scope, **shared** budgets, inference posture, tab roster, outcome |
| `runEvents` | `++id, runId, seq, kind, at, tabId` | Append-only journal. The single source of truth for every report. `tabId` is indexed because multi-tab aggregation and per-tab traceability are both journal queries |
| `sitePolicy` | `origin` | Per-origin grant: capabilities allowed, default autonomy mode, granted/revoked timestamps |
| `tasks` | `++id, name, *tags, lastUsedAt, useCount` | Saved goals. Tag + recency + frequency lookup, no embeddings |
| `profiles` | `++id, name, isActive, createdAt` | [built] `isActive` migrated to `0 \| 1` so the index actually works |
| `snippets`, `settings` | [built] unchanged | |
| `promptHistory` | [built] gains a retention purge | |
| `analytics` | **dropped** | One event type written, never read by the view that claims to show it |

---

### 3.7 Key Design Decisions

#### 3.7.1 The Model Proposes, the Gate Disposes — and They Live in Different Contexts

The planner runs in the offscreen document. The Policy Gate runs in the service worker. They communicate only by serialized `ActionRequest`. This is not layering for its own sake: it means the enforcement rules are not in the same memory, the same prompt, or the same call stack as the thing being enforced. PP-3 says a rule that exists only in a prompt is not a control; this is what "not in a prompt" looks like structurally.

**Consequence:** every action costs one extra message round trip (~2–5 ms). **Complexity accepted:** the gate must re-derive run context from persisted state on every call, because the service worker may have been terminated since the last one. **Complexity eliminated:** there is no code path where a model's output reaches the DOM without passing a validator, so "did we remember to check this action?" stops being a question about discipline.

#### 3.7.2 Opaque Handles, Never Selectors

The model addresses elements by `e12`, allocated by the content script, valid only within one snapshot epoch, and resolvable only through the registry that allocated it. A hallucinated handle fails validation. A handle for an excluded field does not exist. A handle from a stale epoch triggers descriptor re-resolution, and if that is ambiguous the step stops and asks rather than picking.

This is the answer to two problems at once: hallucinated element references (audit: a common model failure) and the "two buttons labelled Continue" case (R-2). The second is not solved — it is *converted* from a silent wrong action into an explicit `TARGET_AMBIGUOUS` question, which is the best available outcome.

#### 3.7.3 Settling Is a Deterministic Heuristic With a Declared Failure Mode

After every action the content script waits for a **quiet window**: no DOM mutations *and* no new `PerformanceObserver` resource entries for **400 ms**, capped at **8 s**, after which the snapshot is taken anyway and marked `settled: false`.

400 ms is chosen because it is longer than a React commit + paint (typically 16–100 ms) and longer than a same-origin XHR round trip on a fast connection (~150 ms), but short enough that a 15-action run spends under 6 s in settle waits. 8 s is the point past which waiting longer stops being useful and the honest thing is to tell the planner the page never settled.

**Background tabs use a different calibration, because the platform forces it.** Chrome clamps timers in hidden tabs — sub-100 ms becomes 500 ms, sub-1 s becomes 2 s — and applies intensive throttling to roughly one check per minute after five minutes hidden. A 400 ms quiet window is therefore not measurable in a background tab. The detector reads `document.visibilityState` and switches to a **1,000 ms quiet window capped at 15 s** when hidden, recording which calibration was used on the snapshot so the planner and the report can tell the difference. `MutationObserver` and `PerformanceObserver` callbacks are not timer-throttled and still fire on the real events; it is only the quiet-window measurement that stretches. **The exact background constants are a Phase 7 measurement, not a Phase 2 assumption** (§3.11 Q15).

**Declared failure mode:** a page that polls on an interval shorter than the quiet window never goes quiet and always hits the cap. The snapshot is still returned, `settled: false` is visible to the planner and recorded in the journal, and any verification performed on it is downgraded to `unconfirmed` rather than `confirmed`. This is C-3 contained, not solved.

#### 3.7.4 Verification Is Deterministic First, Model-Interpreted Only When It Must Be

Six verification kinds run as plain code with no model call: **state** (read the value back), **appearance** (a node matching an expected description exists), **disappearance**, **location** (URL/origin changed as expected), **count** (extracted rows vs detected repeating blocks), and **negative** (a new `role=alert` / validation-message node appeared within the target's form). Only two require a model: **semantic** ("does this page content answer the question") and **traceability** ("is every extracted value present in text we actually read" — which is a substring check first and a model call only for normalised values like reformatted prices).

**The deterministic share is instrumented, not targeted.** An earlier draft made "≥80 % of verifications resolve deterministically" a pass/fail budget line. That was the wrong hard gate. A deterministic check that is silently wrong is worse than a model check that honestly returns `unconfirmed`, so optimising the ratio can actively damage the property the ratio was standing in for. What §3.8 makes a **zero-tolerance gate** is instead: **a `confirmed` verdict on an Always-tier action that did not take effect — a false confirmation — must never occur.** The ratio remains recorded, with ≥80 % kept as a *review trigger*: falling below it means per-action cost has roughly tripled and the design should be looked at, not that a test fails.

#### 3.7.5 The Report Is Generated From the Journal, Not From the Planner

`reporter.ts` takes `runEvents` and produces the end-of-run report. It has no access to planner output. If the journal contains no `action.observed` with `verified:'confirmed'` for a step, the report cannot say that step succeeded — not as a matter of prompt discipline but because the data is not there.

This makes PP-5, PP-6, PR-TRU-1..4 and SC-4/SC-5 testable by a unit test over a synthetic journal (`tests/unit/journal.spec.ts`), which is the only way these requirements become real rather than aspirational.

#### 3.7.6 Page Content Never Enters the Instruction Channel

The planner prompt has three fixed segments in a fixed order: `GOAL` (user text, quoted), `POLICY` (capabilities, tiers, budgets, the run's scope), and `OBSERVATION`. The observation segment carries a per-run random nonce in its opening and closing fences, is prefixed with an explicit statement that its contents are untrusted data which may attempt to issue instructions, and — critically — **the planner never receives raw page HTML or raw page text in the deciding call.** It receives the `PerceptionSnapshot`, where page-authored strings appear only as the `name` and `valueShape` fields of typed objects.

That last point does more work than the framing does. Injected text arriving as `elements[7].name` is structurally a label, and the only thing the planner can do with a label is choose or not choose its handle. It cannot name an origin, cannot widen scope, cannot approve anything, and cannot reach a verb outside the fifteen.

**Stated honestly:** this reduces the attack surface; it does not close it. A page can still name a button "Continue to your account" to steer a choice within scope. That is why `goal-anchor.ts` and `suspicion.ts` exist as separate layers, and why PR-SEC-16 forbids ever claiming immunity.

#### 3.7.7 Stop Is Enforced at the Gate, Not by the Loop

Pressing Stop writes a flag to `chrome.storage.session` and fires an `AbortController` on any in-flight inference. The Supervisor is *told*, but it is not *trusted*: the gate reads the flag as check 5 of 6 on every action, so a kernel that is wedged, mid-decision, or looping cannot execute one more action. The content-script actuator checks it once more immediately before touching the DOM.

**Consequence:** stop cannot un-do an action already dispatched to the page — the physical floor is one in-flight DOM operation. Everything after it is refused. This is what PR-CTL-8 costs, and it is the reason stop is designed as a shared flag rather than a message the loop must choose to honour.

#### 3.7.8 Host Access Is Granted Per Origin at Runtime, Not Requested at Install

The manifest ships with **no** `<all_urls>` and no broad host permissions. It declares `optional_host_permissions: ["*://*/*"]`; the user grants an origin from the popup or the cockpit, which triggers `chrome.permissions.request` and, on success, `chrome.scripting.registerContentScripts` for that origin. Revocation unregisters it and marks any active run on that origin as halted.

This is the answer to R-4 (an agent needs access that an agent looks alarming asking for) and it is what makes PR-SEC-5/6/7/9 implementable rather than aspirational. It also fixes the current situation, where a content script on `<all_urls>` with autocomplete on by default is the single largest liability in the repository.

#### 3.7.9 Four Model Tiers; the Planner Is Never a Small In-Browser Model

Work is split by difficulty, not by convenience, and the four tiers have genuinely different requirements rather than being one model used four ways.

| Tier | Workload | Engine | Failure mode |
|---|---|---|---|
| **Planner** | Goal decomposition, plan revision, recovery choice, ambiguity handling. Selection among ~120 descriptors under adversarial page content | Ollama 7–14B, **or** a remote provider on a user-held key | No planner available → **multi-step runs do not start**, and the user is told why. Text capabilities and the single-action copilot continue to work |
| **Judge** | Semantic verification, target disambiguation, suspicion scoring, condensation. Short context, constrained output, high call rate — the majority of calls by count | Chrome `LanguageModel` → WebLLM. Local in both postures | Neither available → semantic verification returns `unconfirmed`, **never** `confirmed`. The run continues with a smaller confirmed set |
| **Vision** | `look_at` only, on the three §3.7.13 triggers | `LanguageModel` image input (local); a remote VLM on a Hybrid run | Unavailable → the step escalates to `ask_user`, never to a guess |
| **Inline completion** | Ghost-text continuation in a text field. Very high frequency, ≤400 ms | `LanguageModel` warm session, `clone()` per request. **Local only** | Suggestion suppressed silently. It never blocks or delays typing (§3.7.22) |

**The planner tier is deliberately not available in-browser, and this is a decision rather than a deferred measurement.** There are exactly three routes to planner-grade reasoning: a remote API, Ollama at 7–14B, and an in-browser 1.5–4B model. Only the first two qualify. A ~3B model doing multi-step browser planning does not fail loudly — it produces confidently wrong plans, which is a PP-6 truthfulness failure at the point it costs most, and offering it as a planner in order to measure how badly it does would spend a phase learning something already known. Two things that changed since the first draft help without changing this: schema-constrained decoding (§3.7.14) removes malformed output as a confound, and Chrome's built-in model removes the download barrier. Neither makes a 3B model a planner.

**What the two postures now mean.** Each run declares its inference posture before it starts and shows it to the user (PR-PRV-6, PR-LOC-2):

- **Local-only** — planner on Ollama; judge, vision and inline local. Nothing leaves the machine. **If no capable local planner is reachable, a multi-step run does not start**; the user is offered the single-action copilot and the text capabilities instead of a degraded agent. This is the honest form of the posture and it is what makes "Local-only" a claim rather than a label.
- **Hybrid** — planner (and, where §3.7.13 says it is the better choice, vision) on a remote provider whose key the user holds; judge and inline stay local. The destination is named before the run starts, and what crosses the wire is governed by §3.7.23.

**No silent crossing of the locality boundary.** Fallback *within* a locality is permitted, because it does not change what the user was told: `LanguageModel` → WebLLM is fine. Fallback *across* it is prohibited and enforced in `model/router.ts`, not by intent. This replaces the current `FALLBACK_ORDER = ['webgpu','ollama','groq']` cascade in `llm-router.ts`, which silently reaches a remote provider through a `catch` — the exact anti-pattern (PR-LOC-4).

**Which OQ this resolves.** The original open question — *can a 1.5–3B local model plan well enough for Local-only runs to be useful?* — is **answered here rather than carried forward**: not well enough to be trusted with a plan, so Local-only planning means Ollama. What remains open, and is now a Phase 2 exit criterion rather than a Phase 8 hope, is *which* planner-capable models are good enough at this specific task (§3.11 Q1).


#### 3.7.10 Existing Text Capabilities Keep Their Direct Path

`refactor`, `generate`, `score` and `summarise` are reachable as agent verbs *and* directly from the overlay, and the direct path does not go through the kernel, the planner, or the gate — thinking verbs change no page state and need no gate. PP-8 and SC-11 are protected structurally: a one-step rewrite cannot become slower because a planner exists, because the planner is not on that code path.

#### 3.7.11 Interrupted Runs Halt; They Do Not Auto-Resume

If the offscreen document is torn down mid-run, the next service-worker wake finds a `runs` row in a non-terminal state, journals `run.interrupted`, and sets `state='halted'`. The user is shown what was completed and verified up to that point and may start a fresh run.

The rule, stated as the condition rather than the outcome: **a run is never automatically resumed until the system can verify that the persisted state, page state, tab state, and element handles are still trustworthy.** After an interruption it cannot verify any of the four — every handle epoch is void, each roster tab may have navigated or closed, and a partially-completed form is precisely the situation where a confident wrong resumption does damage. Halting is worse UX and better behaviour, and it is consistent with PR-REC-7's treatment of partial effects.

Note what this does *not* rest on. An earlier draft argued that durable execution is unsafe here because checkpoint-and-replay would re-run a click. That was overstated and is withdrawn (§3.5.1): replay in a real implementation is scoped to the node that was in flight, and is refusable before it happens. The reason we halt is the four-part trustworthiness condition above, which no checkpointer can satisfy on our behalf — and the reason we carry no checkpointer is that a second store of run state would compete with the journal, not that replay is inherently unsafe.

**Consequence for durability work:** the architecture deliberately adds no machinery for a theoretical interruption. Whether one is *needed* depends on how often interruptions actually happen, which is a Phase 1 measurement (§3.11 Q8), not a design assumption.

#### 3.7.12 Actuation Is a Swappable Backend; CDP Is an Opt-In Escalation, Never the Default

`ActuationBackend` is an interface with two implementations, chosen per run:

| | `dom-backend` (default) | `cdp-backend` (opt-in) |
|---|---|---|
| Permission | none beyond the origin grant | `optional_permissions: ["debugger"]`, requested at enable time |
| Perception | our DOM walk, computed accessible names, open shadow roots | `Accessibility.getFullAXTree` — browser-computed roles, names and states, piercing shadow DOM and frames |
| Input | native value setters + dispatched `input`/`change`; `isTrusted === false` | `Input.dispatchMouseEvent` / `dispatchKeyEvent`; genuinely trusted input |
| Capture | `captureVisibleTab`, viewport only | `Page.captureScreenshot` with `clip`, including outside the viewport |
| Visible to the user | the in-page overlay only | the overlay **plus** Chrome's own attached-debugger banner |

**The decision, stated as a rule: the backend is a mechanism, the gate is the authority.** Every check in §3.3.1 step 7 is expressed over verbs, handles, tiers and origins. None of them names a transport. Switching backends therefore changes how a permitted action is performed and how richly the page is read; it cannot change what is permitted. This is what makes CDP safe to adopt at all — the alternative framing, "CDP gives the agent more power", is only true of an architecture with no gate.

**Why the banner is an asset, not a cost.** For a product whose proposition is that you can always see what it is doing and stop it, an un-spoofable, browser-rendered, extension-attributed indicator that appears exactly while the agent is acting is aligned with the trust story rather than against it. The first draft of this document rejected CDP partly on the banner; that was wrong. It cannot be hidden, and it should not be.

**Backends never silently substitute for one another.** `chrome.debugger` fires `onDetach` with a reason, and that mechanism is known now even though the specific reason strings are not. The design is therefore fixed today: **any detach, for any reason, halts the run, journals `BACKEND_DETACHED` with the reason, and surfaces it to the user.** A run that was granted trusted input must never quietly finish on synthetic events — the user consented to a mode of operation, the gate's decisions were recorded against it, and a silent downgrade would make the journal a misleading record of what actually happened. Restarting on the DOM backend is a fresh run the user starts.

**What it genuinely costs, and why it stays off by default.** The `debugger` permission is heavy for a user who wants two forms filled on two sites, and store review scrutinises it. Only one CDP client may attach to a target, so a user opening DevTools on the agent's tab is a conflict. Three further conflict sources belong in the same handling: another extension attaching to the same tab, the tab being duplicated, and the tab being moved to another window. Phase 9 must determine the exact observed behaviour and the message the user sees for each, rather than assuming it (§3.11 Q12). And it is Chromium-only, though `chrome.offscreen` already made that true.

**New hazard this creates, and its mitigation.** `Input.dispatchKeyEvent` types at whatever is focused, so it does not consult our element registry the way a DOM write does. The never-tier exclusion would be bypassable by a focus that lands on a password field. Mitigation, enforced in `cdp-backend.ts`: a CDP type is a three-step sequence — resolve the handle to a `backendNodeId`, `DOM.focus` it, then assert via `Runtime.evaluate` that the focused element is the intended non-excluded node — and the key dispatch is refused if the assertion fails. `tests/e2e/cdp-sensitive.spec.ts` exists for exactly this.

#### 3.7.13 Vision Is an Escalation Capability, Not a Perception Layer

Structured perception is always first. `look_at` is permitted by the gate only when the run's journal shows one of exactly three conditions for the current step:

1. **`TARGET_AMBIGUOUS`** — descriptor re-resolution matched more than one node. A cropped image of each candidate plus "which of these is the primary submit control" is precisely the narrow visual classification a small model handles well, and it converts an ask-the-user interruption into a resolved step.
2. **A canvas-only `unreachableRegion`** — the step's target region has interactive pixels and no interactive DOM. Without vision the honest report is "I cannot see this"; with it there is a chance of proceeding.
3. **An `unconfirmed` verification on an Always-tier step** — the DOM produced no signal either way about something irreversible. A visual check is worth its cost precisely here.

Everything else is refused, journaled as `look_at.refused`, and the planner is told why. Without that rule a screenshot becomes the lazy default perception and the payload budget collapses.

**Said plainly, because it matters:** for the canvas case and for Always-tier disambiguation, **a remote vision model is the better choice** on a Hybrid run. A 3–4B on-device model's OCR and spatial grounding on dense application UI is not reliable enough to base an irreversible decision on, and pretending otherwise would breach PP-6 at the exact moment it counts most. On a Local-only run the honest behaviour is the opposite: use the local engine, and where it returns low confidence, report *unknown* and ask.

**Payload discipline.** Cropped element captures — bounding box plus 24 px padding, downscaled so the long edge is ≤768 px — never whole pages. Full-viewport capture is reserved for trigger 2. Screenshots are **not written to the journal** by default; the journal records that a look occurred, its trigger, and its verdict. An image can contain anything that was on screen, and the run record already has a retention policy to answer for.

#### 3.7.14 The Verb Vocabulary Is Enforced at Decode Time, Not Only at Validation Time

`action.schema.ts` is a Zod 4 schema. `z.toJSONSchema()` derives the JSON Schema handed to the engine's constrained-decoding parameter — `responseConstraint` on Chrome's built-in `LanguageModel`, the provider's structured-output mode on the remote path — and the same Zod object validates the result at the gate. One definition, two enforcement points, no drift.

This matters more than it sounds. The single most defensive file in the current repository is `scorer.ts`, whose three-tier recovery ladder (strict parse → brace repair → regex digit extraction → `{score: 50}`) exists because a small model asked for JSON in a prompt frequently does not produce it. Constrained decoding removes the cause rather than patching the symptom, and it is the difference between a 1.5B model being unusable for structured action selection and being adequate for it. Where an engine offers no constraint mechanism, behaviour is unchanged from §3.3.1 step 4: validate, one repair retry, then fail the run rather than guess.

**Failure mode.** Chrome's built-in model is unavailable on devices below its hardware floor and its availability is a runtime probe, not a guarantee. The adapter reports `unavailable` and the router falls to WebLLM, which has no constraint mechanism — so the validate-and-repair path is not dead code, it is the fallback, and it is tested as such.

#### 3.7.15 MCP Is a Capability Namespace, Never an Authority — Deferred, With the Contract Fixed Here

MCP is scheduled after MVP (§3.5.2). The contract is written now so that it cannot be bolted on badly later, because the tempting integration — merge MCP tools into the agent's tool list and let the model pick — would dissolve the gate.

| Rule | Consequence |
|---|---|
| MCP tools live in their own namespace, `mcp:<serverId>:<toolName>` | The browser vocabulary stays closed at eighteen verbs. A tool can never masquerade as `click`, and no tool can name a tab |
| A tool is invocable only if the server is enrolled **and** the individual tool is enabled **and** the user assigned it a tier at enable time | Tiering cannot be derived by inspection — a tool named `send_email` could do anything — so it is declared, not inferred. Default is **Always**: approve every call until the user lowers it |
| Tool names, descriptions, annotations and results are untrusted content | Wrapped in the same nonce-fenced frame as page text and passed through `suspicion.ts`. The MCP specification asks hosts for exactly this: tool behaviour descriptions "should be considered untrusted, unless obtained from a trusted server" |
| Elicitation (`InputRequiredResult` under MRTR) is mediated, never honoured directly | Rendered as an `ask_user`. A server can request information; it can never produce an approval |
| Tool results cannot widen scope, name an origin, or allocate a handle | The gate's origin check and the element registry are unreachable from a tool response |
| Goal anchoring and run budgets apply to `mcp:*` calls identically | An off-goal tool call is refused the same way an off-goal click is |

The answer to the question this deferral was weighed against — *can MCP provide interoperability without becoming the authority that decides what the agent may do?* — is **yes**, and the reason is that the authority was never in the tool list. It is in a process the tool cannot address, operating on a tier the user assigned. What defers MCP is cost and sequencing: OAuth 2.1 with protected-resource-metadata discovery, PKCE, resource indicators, `iss` validation and step-up scopes is a phase of work, the official TypeScript SDK is not browser-compatible so the client is ours to write, and a second untrusted domain should not arrive before the first one is proven against a red-team corpus. **The first slice, when it comes:** `tools/list` plus `tools/call` restricted to tools the user marked read-only, on unauthenticated or bearer-token servers, with no OAuth. Write-capable tools and the full authorization flow follow only after that.

---

#### 3.7.16 Reads Fan Out, Writes Serialize — and That Is the Shape of a Run

A run is a **Run Supervisor** over **one Tab Agent per tab**, moving through `SURVEY → READ → SYNTHESISE → ACT → END`. Reads across tabs run concurrently, bounded (§3.8). Writes run strictly one tab at a time.

This is not a scheduling preference. Three independent constraints force it, and any one of them would be sufficient:

1. **Consent.** Concurrent approval requests from three tabs are unsupervisable. One at a time is the only meaningful consent model (concept §11.4, PR-AUT-1…6).
2. **The platform.** `captureVisibleTab` captures only the active tab of a window; CDP trusted input targets a focused tab; occlusion checks and `scrollIntoView` are meaningful only where the user could see them. Only one tab per window is active at a time.
3. **Timing.** Background tabs run under clamped timers (§3.7.3), so a write whose verification depends on a settle measurement is less reliable in a hidden tab than in a visible one.

**Single-tab is the one-Tab-Agent case.** Phase 5 ships exactly that; Phase 7 raises the roster cap. The near-term multi-tab requirement therefore costs an instantiation rather than a second orchestration migration, which is the whole reason the split is being made now rather than when it is needed.

**Budgets are per run and shared, never per tab.** Three tabs at forty actions each is one hundred and twenty actions, which destroys the supervisability the budget exists to protect. Each Tab Agent draws from one pool; the Supervisor refuses a draw that would exhaust it.

**Failure mode:** a Tab Agent that exhausts its local recovery attempts enters `failed`, keeps its partial journal, and leaves the rest of the run running. The report names which tab failed and at what point. A failure in one tab never aborts the others, and never silently omits them.

#### 3.7.17 A Tab Agent Cannot Name Another Tab's Handles — Enforced, Not Conventional

Each Tab Agent owns exactly one tab's snapshot, epoch, handle namespace, and local recovery state. Handles are allocated by that tab's content-script registry and are meaningless anywhere else.

The gate makes this enforceable rather than a matter of discipline. Every `ActionRequest` carries a mandatory `tabId`, and the gate's **eight ordered checks** are: run identity · tab identity · **origin scope resolved from that tab's current URL** · **handle ownership** · action and risk tier · run state · stop state · approval requirement. A handle allocated in tab 2 presented on a request naming tab 1 is refused with `HANDLE_NOT_OWNED` before any backend is consulted.

Two of those checks are corrections to an earlier draft and are worth naming. **Origin scope is per tab, not per run:** a run granted two origins must not let a tab on origin A act with origin B's scope, so the check resolves the origin from the tab in the request rather than from the run's union of grants. **Handle ownership is a separate check** rather than an implication of the epoch check, because epochs are per tab and a stale-epoch refusal is a different failure from a wrong-tab refusal — and the report must distinguish them.

**Why this is a security property and not tidiness.** Cross-tab targeting is the natural escalation for a prompt-injection payload: content on tab 3 that can influence an action on tab 1 escapes the origin grant that made tab 3 safe to read. Under this design that attack has nothing to express — a Tab Agent reading tab 3 has never held a tab-1 handle, and the vocabulary contains no verb that takes a tab argument (§3.3.2a). `tests/e2e/cross-tab.spec.ts` exists to keep it that way.

#### 3.7.18 Multi-Tab Needs No New Install-Time Permission

Enumerating and identifying tabs looks like it requires the `tabs` permission, which presents to users as "read your browsing history" and is exactly the kind of ask R-4 warns about. It does not. Chrome's documentation is explicit: *"Host permissions allow an extension to read and query a matching tab's four sensitive `tabs.Tab` properties"* — `url`, `pendingUrl`, `title` and `favIconUrl`.

Because host access is already granted per origin at runtime (§3.7.8), `chrome.tabs.query` returns identifying information for **exactly the tabs the user has granted and no others**. The roster can only ever contain tabs the agent was already permitted to act on, and tabs outside the grant are not merely off-limits — they are invisible.

This closes the current `chrome.tabs.*`-without-declaration defect (PR-SEC-8) by narrowing rather than by declaring more, and it means the permission story does not get worse when multi-tab arrives.

#### 3.7.19 The Side Panel's Stop Is Authoritative; the In-Page Stop Is a Mirror

Both surfaces show Stop. Only one owns it. The in-page overlay is destroyed and recreated on every navigation, so during a run that navigates there is a window in which the in-page control does not exist — and a run that navigates is the normal case, not the exception. The side panel survives navigation and survives tab switches, so it holds the authoritative control; the in-page button posts the same message and is a convenience.

Both write the same flag to `chrome.storage.session`, and the gate reads that flag on every action (§3.7.7). Neither surface is trusted to stop the run by itself.

**Failure mode:** if the side panel is closed mid-run, the run continues and the in-page mirror remains. If both are gone — the panel closed and the tab navigating — the run is not uncontrollable: the budget and the wall clock still bound it, and reopening the panel reattaches to the live run from persisted state.

#### 3.7.20 The Planner Runs on Triggers, Not on Every Step

Calling the planner once per action is the obvious design and it is unaffordable. Forty actions against a 3–6 s planner is two to four minutes of pure inference inside a twelve-minute wall clock, on a key the user pays for. So the per-step hot path is `step-resolver.ts` — plan step plus current snapshot plus the **judge tier** to choose the target handle — and the planner is re-invoked only when the next action is **not derivable**:

| # | Re-planning trigger |
|---|---|
| 1 | Run start — the initial plan |
| 2 | Verification returned `failed` |
| 3 | Two consecutive `unconfirmed` verdicts on the same step |
| 4 | The current plan step's target descriptor fails to re-resolve |
| 5 | A URL change or large mutation burst the plan did not predict |
| 6 | The user edited the plan mid-run |
| 7 | Anomaly detection fired — e.g. a field count far below comparable pages |

This is adaptive rather than fixed, which is the point. J-1 form fill is largely derivable and costs roughly three to six planner calls across about thirty actions. J-3 menu navigation is the opposite — *"the next screen is not knowable in advance"* is the journey's own description, so trigger 5 fires nearly every step and the run is planner-heavy. That is correct behaviour, and J-3 is short.

**This does not weaken iterative planning (PR-PLAN-5).** The triggers are the mechanism by which the agent re-plans under uncertainty; what they remove is re-planning when there is no uncertainty. **Failure mode:** if triggers fire on more than half of steps for a journey the plan should have covered, the planner prompt is producing plans too vague to execute, and that is a prompt defect surfaced by a budget line (§3.8) rather than a silent cost.

#### 3.7.21 Perception Is Pruned by Token Budget and by Structure, Not by an Element Count

An earlier draft capped snapshots at 120 elements. The cap is the wrong unit: descriptors vary substantially in size, so a fixed count is a poor proxy for the thing that actually matters, and a real token budget already exists. The element cap becomes **advisory**; the **6,000-token observation budget is what is enforced**, measured with real BPE counts.

More importantly, pruning is **structure-aware**. Three rules, each of which exists because violating it causes a specific failure:

1. **Never truncate inside the form the current step targets.** Dropping the second half of a long form is how the agent silently fails to find the field it needs.
2. **Never partially truncate a repeating block.** A half-listed table corrupts the `count` verification kind (§3.7.4), turning a pruning decision into a false verification result.
3. **Report completeness per region, not globally.** `regions[]` replaces a single `truncated` boolean, so the planner can see that its working form is complete while a sidebar was pruned, and can fetch what was left out with `read_structure {region}`.

Viewport-first ordering with form-scoped expansion is the starting strategy and does not need a study to justify. What does need evidence is the pruning strategy's behaviour on genuinely large and dynamic pages, which is a **Phase 2 exit criterion** (§3.11 Q3).

**One correction carried into §3.11:** the CDP accessibility tree does *not* make the budget more generous. `Accessibility.getFullAXTree` on a large application returns thousands of nodes and needs the same pruning. What it provides is better *names*, which reduces `TARGET_AMBIGUOUS`; it does not reduce payload.

#### 3.7.22 Inline Autocomplete Is Local-Only, and That Is a Security Decision

Inline completion is a required product capability (PRD OQ-8 is closed: it stays). It returns in Phase 4 under four conditions, all of which are constraints the current implementation violates:

| Condition | Why |
|---|---|
| **Local inference only. No remote path exists in the code.** | Autocomplete has no *run*, so PR-PRV-6's per-run disclosure cannot cover it. Keystrokes on arbitrary sites reaching a remote provider under a global toggle is the precise thing the rest of this security model exists to prevent. Rather than design a second consent surface for the highest-frequency, lowest-supervision path in the product, the remote path is not built |
| **Only on origins the user has granted**, via the same runtime grant as the agent (§3.7.8) | Today it runs on `<all_urls>`, on by default. That is the single largest liability in the repository |
| **The same `page/sensitive.ts` classifier as the agent, not a parallel implementation** | Today `isValidTarget()` accepts `type="password"`. One classifier means one place to be right, and one place the tests cover |
| **Rendered as text nodes, never `innerHTML`** | Today ghost text is built by string-concatenating model output into `innerHTML` (PRE-2) |

**Latency is the workload, not a preference.** The budget is ≤400 ms p95 (§3.8), achieved with a warm `LanguageModel` session `clone()`d per request — Chrome's own guidance, and the reason the session lives in the offscreen document where the Prompt API is reachable, at the cost of two message hops from the content script. Ghost text that arrives after the user has typed past it is noise, and a feature that is noise gets switched off.

**The 2–3 s allowance belongs to a different feature.** On-demand prompt improvement — an explicit shortcut or button, not a typing pause — may take 2–3 s and may use the planner tier, remotely, on a Hybrid posture. It has an explicit trigger, so it can carry its own disclosure. Both are good products; a 2–3 s *inline* completion is not.

#### 3.7.23 Two Disclosure Classes, and Raw Page Text Is Condensed Locally First

What leaves the device is not one thing, and treating it as one thing was the weakest part of the first draft's privacy story.

| Class | What crosses the wire | Reached by |
|---|---|---|
| **A — "this run uses a remote planner"** | `ElementDescriptor[]` — role, accessible name, value *shape* — plus the goal and the journal tail. A typed page **skeleton** | The planner tier on a Hybrid run |
| **B — "this task sends page text"** | Raw extracted page content | `read_page`, and `summarise` / `transform` over a `textRef` |

**Class A is strong by construction and always was.** The planner's deciding call receives typed objects, not page text (§3.7.6), and sensitive fields were excluded at snapshot construction so there is no handle and no value to leak. Structured perception *is* the minimisation.

**Class B is the real exposure, and it gets its own rule:** raw page text is condensed by the **local judge tier first**, and only the condensation crosses the wire. A task that genuinely requires full text at a remote model is a **separate, named, per-task disclosure** — not something folded into "this run uses a remote planner". **Failure mode:** if no local judge is available to condense, a Class B remote call is **refused**, never silently upgraded to sending raw text.

**The defences, in the order they apply.** The ordering matters because it is the difference between a guarantee and a mitigation:

1. **Structural — exclusion.** Password, payment, OTP and the rest of the `sensitive.ts` set are excluded during snapshot construction. They are never in a message, so no later stage can leak them. There is no setting, mode, or approval that produces a handle for one.
2. **Structural — minimisation.** The planner receives descriptors, not content (Class A).
3. **Structural — local condensation.** Class B text is reduced on-device before any remote call.
4. **Best-effort — the scrubber.** `pii-scrubber.ts` runs on the remote path only. It is pattern matching, it has known false positives, and it is **never** described to users as a guarantee. It is the fourth line, not the first.
5. **Disclosure.** Posture chosen and shown before the run; every remote call journaled with tier, provider and payload size, and surfaced in the report.

**What is no longer claimed.** The first draft's positioning was that page content need never leave the machine. That is true of a Local-only run and false of a Hybrid one, and the store listing and §3.9 must say so. The claim that survives, and that no cloud agent can copy, is narrower and still real: **Pro Prompt operates no server.** On a Hybrid run the user's own key talks to a provider they chose; we never see the traffic, never hold the key, and are never a party that could be compelled to retain their page content.

---

### 3.8 Performance Budget


Measurement conditions where they matter: a mid-range 2023 laptop, a visible foreground tab, a page with ~2,000 DOM nodes and ~150 interactive elements, a 1.5–3B judge model.

**Gates and gauges are kept structurally distinct**, because mixing them is how a safety property gets traded against a latency number. A **gate** fails CI. A **gauge** is recorded, reviewed, and moved on evidence.

**Hard gates — zero tolerance, enforced in CI**

| Metric | Target | Rationale |
|---|---|---|
| False confirmation on an Always-tier action | **0** | A `confirmed` verdict on an irreversible action that did not take effect is the single failure that destroys the product's claim. This — not the deterministic ratio — is the verification gate (§3.7.4) |
| Unapproved Always-tier actions | **0** | SC-2 / PR-SEC-2. No mode, setting or autonomy dial weakens it |
| Never-tier field access | **0** reads, **0** writes, **0** appearances in any message, journal entry or remote payload | Structural, not behavioural: exclusion happens at snapshot construction (§3.9) |
| Actions after Stop is set | **0**; flag visible to the gate **≤ 250 ms** | SC-6. The 250 ms covers the `storage.session` write and cockpit round trip |
| Cross-tab handle use | **0** — any tab-B handle on a tab-A request is refused `HANDLE_NOT_OWNED` | §3.7.17. Enforced by `tests/e2e/cross-tab.spec.ts` |
| Actions on a non-granted origin | **0** | SC-3 |
| Silent locality crossing | **0** — a Local-only run reaching a remote provider is a build failure, not a bug report | §3.7.9 |
| Silent backend substitution | **0** — any CDP detach halts the run | §3.7.12 |
| Report claims absent from the journal | **0** | §3.7.5, provable by unit test over a synthetic journal |

**Performance gauges — measured, budgeted, reviewed**

| Metric | Target | Rationale |
|---|---|---|
| Perception snapshot build (content script) | **≤ 120 ms p95** | Runs on the page's main thread. Above ~150 ms the user sees the page hitch on every agent step |
| Observation budget to the planner | **≤ 6,000 tokens**, enforced with real BPE counts | This, not an element count, is the enforced limit (§3.7.21). Element count ~120 is advisory ordering guidance |
| Region completeness reporting | **100 %** of pruned regions appear in `regions[]` with `shown`/`total` | Silent pruning is the failure mode; the count being large is not |
| Snapshot serialization crossing contexts | **≤ 96 KB** | `chrome.runtime` structured-clone cost becomes visible past ~100 KB, per tab, per step |
| Settle quiet window / cap — **visible** tab | **400 ms / 8 s** | §3.7.3 |
| Settle quiet window / cap — **background** tab | **1,000 ms / 15 s**, starting values | Chrome clamps hidden-tab timers (sub-1 s → 2 s). Calibrated in Phase 7, not assumed now (§3.11 Q15) |
| Deterministic verification share | **≥ 80 %**, as a **review trigger, not a gate** | Below this, per-action cost roughly triples. It is not a quality target — see the false-confirmation gate above |
| Action → verified outcome (deterministic path) | **≤ 1.5 s p95** | Settle window + read-back + journal write. Sets the felt pace of a run |
| Planner calls per run | **≤ 8 p50, ≤ 20 p95**, hard cap 30 | The direct cost and latency lever (§3.7.20). Above p95 the plan is too vague to execute and the prompt is at fault |
| Planner decision latency | **≤ 8 s p95 Ollama 7–14B, ≤ 6 s p95 remote** | With ≤8 planner calls this is ~48 s of a 12-minute run rather than the 2–4 minutes a per-step planner would cost |
| Step resolution (judge tier, per action) | **≤ 1.2 s p95** | This is the per-step hot path, not the planner |
| Schema-valid action output, first attempt | **≥ 98 % with constrained decoding; ≥ 85 % without** | The measured value of §3.7.14. The 85 % figure is the WebLLM fallback path and is why validate-and-repair is tested, not dead code |
| **Inline completion round trip** | **≤ 400 ms p95**, including both message hops | §3.7.22. The interaction fails above this; it does not merely feel slower |
| Inline completion warm-session hit rate | **≥ 95 %** — a cold `LanguageModel.create()` on the typing path is a defect | `clone()` from a warm base session is the mechanism the budget depends on |
| Read fan-out width | **≤ 4 tabs in flight**; roster **≤ 8 tabs** | Four concurrent snapshots is ~4×96 KB of transient clone traffic and four pages traversing their DOM at once. Eight is the roster ceiling because the cockpit must show every tab's state at a glance — beyond that the run stops being supervisable, which is the same argument as the action budget |
| Run budgets | **40 actions · 3 retries/step · 12 min wall clock · 3 identical repeats → stuck**, **shared across the whole roster** | 40 covers J-1 (14 fields ≈ 30 actions with verification) with headroom. Shared, not per tab: 3 × 40 would be 120 (§3.7.16) |
| Journal write | **≤ 10 ms, never blocking the loop** | One Dexie `add` per event, ~40 events per run. If this blocks, the report becomes incomplete — the one thing that must not happen |
| `look_at` escalation rate | **≤ 1 per step, ≤ 3 per run, ≤ 10 % of steps across the evaluation set** | Above 10 % the structured perception layer has failed and the fix belongs in `perception.ts`, not in more screenshots |
| Screenshot payload | **≤ 200 KB per capture; long edge ≤ 768 px** | Enough for a cropped control to be legible, ~1/100th of a full-page native capture |
| `look_at` round trip | **≤ 4 s p95 local, ≤ 3 s p95 remote** | It fires on an already-failed step, competing with asking the user |
| CDP attach → first AX tree | **≤ 600 ms p95** | Paid once per run when enabled. Longer reads as a hang, since the banner appears first |
| Backend parity | **Identical gate decisions and journal event shape** for the same fixture run on both backends | The assertion that §3.7.12's "mechanism, not authority" claim is true |
| Content-script bundle | **≤ 80 KB gzipped** | Injected into every granted page. Above this the extension is a measurable page-load tax and users revoke grants |
| **Offscreen document bundle** | **≤ 250 KB gzipped**, excluding lazily-loaded WebLLM | New line, and the one an orchestration framework would have to fit inside: LangGraph measured at **233 KB gzipped** marginal (§3.5.1). The offscreen document also serves judge-tier text scoring, so its parse cost sits in front of SC-11 |
| Side panel + dashboard bundle | **≤ 400 KB gzipped**, excluding WebLLM | WebLLM is lazy-loaded in the offscreen document only |
| Agent-runtime state memory | **≤ 8 MB** for a 40-action run; **≤ 20 MB** for an 8-tab roster | Journal tail plus the last two snapshots *per active tab*; everything else read from IndexedDB on demand |
| Single-step text operation regression | **≤ +150 ms vs the current direct path** | SC-11 / PP-8. Baselined in Phase 1 before anything changes |
| Cold service-worker wake → gate decision | **≤ 300 ms p95** | Every gate check may hit a cold worker. Above this, runs visibly stutter between steps |
| Offscreen document survival | **≥ 90 % over 30 min**, measured across screen lock and sleep/wake | Not a design assumption — a Phase 1 measurement that decides whether the wall-clock budget is realistic (§3.11 Q8) |

---


### 3.9 Security Model

Threat model in one line: **the page is hostile, the model is fallible, and the user is the only trusted party.** Multi-tab adds a fourth clause that is easy to miss: **one granted tab is hostile to another**, so cross-tab reach is treated as an escalation path rather than an internal convenience.

| Concern | Mitigation |
|---|---|
| **Instructions embedded in page content (prompt injection)** | Six layers, none sufficient alone: (1) the planner receives typed `ElementDescriptor` objects, not raw page text, in the deciding call; (2) the observation segment is nonce-fenced and explicitly framed as untrusted; (3) the verb set is closed and validated by schema before the gate sees arguments; (4) `goal-anchor.ts` rejects actions inconsistent with the original goal; (5) origin scope is enforced by the gate and by Chrome's own permission model, so no instruction can widen reach; (6) Always-tier escalation requires a human, and no page-derived content can supply one. Per PR-SEC-16, none of this is presented to users as immunity |
| **Sensitive fields (password, payment, OTP)** | Excluded at the earliest possible point: `sensitive.ts` classifies during snapshot construction, so such fields never receive a handle and their values are never read into memory, never serialized, never journaled, never sent to any provider. There is no setting, approval, or autonomy mode that produces a handle for one. This is the fix for the current `isValidTarget()` accepting `type="password"` |
| **Irreversible actions** | `tiers.ts` classifies before execution from (verb, target descriptor, origin). Always-tier actions hold the run at `awaiting_approval` with a per-instance prompt naming the action, the target's label, the origin and the consequence. Never batched, never remembered, never disabled by any mode (PR-SEC-2) |
| **Over-broad host access** | No install-time host permissions. Per-origin runtime grants via `chrome.permissions.request` + dynamic content-script registration. Revocation is immediate and halts any run on that origin (§3.7.8) |
| **Declared vs actual permissions** | Target manifest: `storage`, `scripting`, `offscreen`, `sidePanel`, `activeTab`, plus `optional_host_permissions` and — only from Phase 9 — `optional_permissions: ["debugger"]`. `alarms` returns in Phase 11 for scheduled runs, and only then. `tabs` is **not** declared even under multi-tab — granted host permissions already expose the four sensitive `Tab` fields for permitted origins (§3.7.18), resolving PR-SEC-8 by narrowing rather than by declaring more |
| **A hostile page tampering with our content script** | The content script runs in Chrome's isolated world; page script cannot reach the registry or the actuator. We do not inject into `MAIN` world and do not patch page globals, so there is no shared object to poison. The overlay lives in a closed-mode shadow root |
| **Model output as an injection vector into our own UI** | Every rendering path uses text nodes and React children. The current `innerHTML` construction in `autocomplete-manager.ts` and the host-document snippet popover are removed (PRE-2). Zod validates every model output before it reaches a renderer |
| **Secrets at rest** | The Groq key moves from `chrome.storage.sync` (which replicates it to every browser signed into the same account) to `chrome.storage.local`, with the change and its reason surfaced to the user. Run control flags live in `chrome.storage.session` and never touch disk |
| **Sensitive content at rest** | `runEvents` may contain page-derived text, and a multi-tab run multiplies how much. A user-visible retention setting (default: 30 days) with per-run delete and a clear-all control (PR-RUN-6, PR-PRV-4), shipped in Phase 8 rather than at release since it is MVP scope. The same purge applies to `promptHistory`, which today is stored indefinitely with no control |
| **Data leaving the machine** | **Two classes, handled differently (§3.7.23).** *Class A* — a Hybrid run's planner receives typed `ElementDescriptor` objects, not page text: a skeleton of roles, accessible names and value *shapes*. *Class B* — raw page text from `read_page` / `summarise` / `transform` is condensed by the **local judge tier first**, and only the condensation crosses the wire; a task needing full text remotely carries its own separate disclosure, and if no local judge is available to condense, the remote call is **refused rather than silently upgraded**. Local-only runs cannot reach a remote provider at all — enforced by the router's no-cascade mode, not by intent. The scrubber is the **fourth** line of defence behind exclusion, minimisation and condensation, with its `\b\d{10,12}\b` phone rule narrowed; it is never presented as a guarantee |
| **What the product may and may not claim about privacy** | The claim "your page content never leaves your machine" is true of a Local-only run and **false of a Hybrid one**, and the store listing must not blur them. The claim that survives both postures: **Pro Prompt operates no server.** On a Hybrid run the user's own key reaches a provider they chose — we never see the traffic, never hold the key, and are never a party that could be compelled to retain their page content. PR-SEC-16's prohibition on overclaiming applies to privacy exactly as it does to injection resistance |
| **Inline autocomplete as an unsupervised exfiltration path** | Autocomplete has no *run*, so no per-run disclosure can cover it. It is therefore **local-only by construction — the remote code path does not exist** — restricted to granted origins, and routed through the same `page/sensitive.ts` classifier as the agent rather than a parallel implementation (§3.7.22). This closes the current situation, where a content script on `<all_urls>` sends whole field values, including from `type="password"` inputs, to whichever provider the cascade reaches |
| **Abuse of a site's defences** | Bot challenges, CAPTCHAs and rate limits are terminal conditions (`SITE_REFUSED`), never obstacles. No solving, no evading, no backing off and retrying under a different shape. This is a product prohibition, implemented as a run-ending cause |
| **Approval fatigue hollowing out consent** | Two mechanisms, one structural and one measured. **Structural:** every Always-tier step is disclosed in the plan *before* the run starts (§3.3.1 step 5), so an approval request confirms a decision the user already saw rather than interrupting with a surprise — and denial is non-fatal (PR-APR-5), so declining is a normal move rather than a run-ending one. **Measured:** approval frequency, denial rate and time-to-decision per run are journaled for Phase 12. Under multi-tab this gets stronger, not weaker: approvals are strictly serial across the whole roster (§3.7.16), so a three-tab run cannot triple the prompt count |
| **One granted tab reaching another** | Handles are allocated per tab and validated by the gate's ownership check; a tab-B handle on a tab-A request is refused `HANDLE_NOT_OWNED` before any backend is consulted. Origin scope is resolved from the tab named in the request, never from the run's union of grants. No verb in the vocabulary takes a tab argument, so cross-tab targeting is inexpressible rather than merely refused (§3.7.17). `tests/e2e/cross-tab.spec.ts` is a hard gate |
| **Tabs outside the grant becoming visible** | Roster enumeration relies on host permissions, which expose `url`/`title`/`favIconUrl`/`pendingUrl` **only for tabs matching a granted origin** (§3.7.18). The `tabs` permission is not declared, so ungranted tabs are not merely off-limits — the extension cannot see them at all |
| **Suspicion signals** | `suspicion.ts` halts the run and names the reason for: text hidden from view but present in the accessible name, instruction-shaped content in element labels, an unexpected origin change mid-run, and any page requesting credentials during a run that did not begin at a login |
| **Denial of service against the extension** | A page firing high-frequency mutations cannot exhaust us: the settle detector is capped (8 s visible / 15 s background), perception is capped by a 6,000-token budget, read fan-out is capped at 4 tabs in flight with a roster ceiling of 8, and the run is capped at 40 actions, 30 planner calls and 12 minutes — **all shared across the roster**, so opening tabs cannot multiply the work a page can cause |
| **The `debugger` permission itself** | Declared in `optional_permissions`, never at install; requested behind an explicit enable flow that names what it grants; attached only for a run's duration and detached on completion, stop, or tab close. Chrome's own attached-debugger banner is retained deliberately as an out-of-band indicator the extension cannot spoof or suppress (§3.7.12) |
| **CDP input bypassing the sensitive-field exclusion** | `Input.dispatchKeyEvent` types at the focused element and does not consult the registry. Every CDP type is resolve-handle → `DOM.focus` → assert the focused node is the intended non-excluded node → dispatch, refusing on assertion failure. Covered by `tests/e2e/cdp-sensitive.spec.ts`; this is the one place where enabling the optional backend creates a new class of risk rather than reducing one |
| **Screenshots as a data-exposure surface** | Captures are cropped to the target element wherever the trigger allows, are not written to the journal by default, are never sent off-device on a Local-only run, and on a Hybrid run count as remote transmission for the purposes of the pre-run disclosure (PR-PRV-6) |
| **MCP tools as a second injection domain** *(deferred capability)* | Tools are namespaced, individually enabled, and tiered by the user at **Always** by default; descriptions and results are untrusted content in the same nonce-fenced frame as page text; elicitation is mediated as `ask_user` and can never approve anything; results cannot widen scope, allocate handles, or name a tab (§3.7.15). None of this ships before the browser injection surface has been proven against the Phase 12 red-team corpus — the trigger is evidence, not a date (§3.11 Q13) |
| **Imported saved tasks** | An imported task is executable instruction text authored by a third party, so it is treated as untrusted content and not as a user goal. On import it is **de-privileged**: it carries no origin grants, no autonomy mode above Step, and no saved approvals; it is **re-planned from scratch** against the current page rather than replayed; and its text passes through `suspicion.ts` like page content. Phase 11 builds this alongside export (PR-TASK-4) |

---

### 3.10 Phase Roadmap Summary

#### 3.10.1 The gap being closed

Stated plainly, so the phase boundaries are traceable to evidence rather than to preference:

| Area | Today (verified in source) | Target |
|---|---|---|
| Decision-making | A `while` loop with a fixed 3-step sequence and no choice of action | A Run Supervisor over N Tab Agents; a plan whose steps resolve to one of eighteen verbs, constrained at decode time, re-planned on triggers rather than per step |
| Page model | Readability text, capped at 15,000 chars | `PerceptionSnapshot` with handles, roles, names, state, and declared unreachable regions |
| Actuation | `element.value = text` + synthetic `input`, in two UI managers | Two backends behind one gate: isolated-world DOM by default, CDP with trusted input when the user opts in |
| Change detection | None. No `MutationObserver` in the repository | Settle detector on mutations + resource entries |
| Verification | None | Six deterministic kinds plus two model-interpreted, with `unconfirmed` as a first-class outcome |
| Safety enforcement | None. `isValidTarget()` accepts `type="password"`; content script on `<all_urls>`; autocomplete on by default | Tier classification, never-rules, per-origin runtime grants, goal anchoring, suspicion halts |
| Run state | None. No concept of a run | Persisted run machine plus a per-tab status record, with an append-only journal indexed by `tabId` |
| Tabs | `chrome.tabs.*` called without declaring the permission; no concept of a tab set | A roster of granted tabs, enumerated through host permissions only, with per-tab handle isolation enforced at the gate |
| Model strategy | One cascade that silently falls through WebGPU → Ollama → Groq | Four tiers with distinct requirements and a hard no-cascade boundary between local and remote |
| Interruption | None | Stop enforced at the gate; pause, take-over, resume |
| Reliability engineering | Zero tests, zero CI, no lint config, four commits, "load unpacked" | Vitest + Playwright + GitHub Actions as a shipping gate, then a store release |
| Structured output | A three-tier regex repair ladder in `scorer.ts` because small models drift off JSON | JSON-Schema-constrained decoding from one Zod 4 schema, with validate-and-repair as the tested fallback |
| Known defects | `isActive` indexed as boolean (active profile silently missing on cold start); key in `storage.sync`; `innerHTML` from model output; `chrome.tabs.*` without permission; dead alarm; stale Groq model id | All closed in Phase 1 as preconditions |

| Phase | Title | Outcome |
|---|---|---|
| **1** | **Foundation, Preconditions, Test Infrastructure & the Runtime Spike** | Every PRD precondition (PRE-1…PRE-6) closed: no sensitive-field path, no `innerHTML` rendering, active profile resolves on cold start, key out of `storage.sync`, declared permissions match usage. Install-time host access removed; per-origin runtime grants. Dexie v2. Zod 4. Vitest + Playwright + CI green on every push, plus the frozen-page capture harness the later evaluation layers depend on. **And the combined runtime spike**, because everything from Phase 4 rests on it: does the offscreen document survive 30 minutes across a screen lock and a sleep/wake, and is `LanguageModel` reachable there with `responseConstraint` and image input? **Demonstrable:** granting `example.com` registers the script and revoking it unregisters it; a password field is provably untouchable; CI is green; the spike produces a written go/no-go with its fallback declared |
| **2** | **Perception** | `agent.content.ts` builds a `PerceptionSnapshot` with the element registry, handle epochs, shadow-root traversal, the settle detector, and **structure-aware pruning under the token budget** with per-region completeness. **Exit criterion, not a later phase: the planner bake-off.** Candidate planner models are scored on target selection and plan quality against fixture snapshots — which is all a bake-off needs, and both exist at the end of this phase. That decides the Phase 4 default. **Demonstrable:** open a granted page and see handles, roles and per-region completeness in the panel; a `type=password` field appears only in `excludedCount`; the bake-off table names a default planner and a runner-up |
| **3** | **Policy Gate, Actuation & Verification — *the single-action copilot*** | The gate's eight checks, the tier classifier, the never-rules, the `ActuationBackend` interface with its DOM implementation, and the deterministic verification kinds. No planner yet: the user names one action and it executes, verifies and journals. **Demonstrable:** "click the Continue button" runs and reports a confirmed outcome; "click Submit" holds for approval and names the consequence; the same request on a non-granted origin is refused `OUT_OF_SCOPE` |
| **4** | **Model Tiers, Routing & Structured Decoding** | Four-tier router with the hard no-cascade boundary, posture selection and pre-run disclosure, disclosure-class A/B handling with local condensation, schema-constrained decoding from one Zod schema, and **inline autocomplete restored** under its four §3.7.22 conditions. **Demonstrable:** choosing Local-only with no Ollama present refuses a multi-step run and explains why; a plan is generated from a goal and displayed without executing; ghost text appears within 400 ms and never on a password field |
| **5** | **The Agent Loop — Run Supervisor + one Tab Agent** | Supervisor, phase machine, Tab Agent, run state machine, plan presentation and editing, the seven re-planning triggers, shared budgets, stuck detection, goal anchoring, Suggest/Step/Supervised modes. Roster size is one; the seam for more exists and is unused. **Demonstrable:** J-1 — state a goal on a form, edit the plan, watch fields fill and verify one by one, stop before Submit; the journal shows planner calls in single figures |
| **6** | **Recovery, the Journal & Honest Reporting** | The full `FailureCause` taxonomy and its response mapping, overlay dismissal, take-over/resume, anomaly detection, the journal-derived reporter with `ask_user` reason codes, and run history. **Demonstrable:** J-2/J-3 — the agent recovers from a collapsed section unassisted and reports what it could not confirm, with the reason each question was asked |
| **7** | **Multi-Tab — Roster, Bounded Fan-Out & Aggregation** | Tab roster through host-permission enumeration, `open_tab`, bounded read fan-out, per-tab isolation enforced at the gate, aggregation by `tabId` with per-tab traceability, `tabs.onRemoved` handling, background-tab settle calibration, and serialized writes with strictly serial approvals. Q7's two-surface split is validated here, where it is actually stressed. **Demonstrable:** J-4 in full — three tabs read concurrently, one fails and is isolated while the other two complete, and the comparison names which tab each unknown came from |
| **8** | **Pro Prompt Integration — Profiles, Snippets, Text Verbs & Saved Tasks** | Profiles carry agent policy alongside facts, with fact attribution in the journal; snippets integrated; refactor/generate/score/summarise wired as verbs while keeping their direct planner-free path; saved tasks that re-plan rather than replay; retention policy and purge control (PR-PRV-4, MVP scope). **Demonstrable:** J-6 is unchanged in feel and measurably within +150 ms of the Phase 1 baseline; a saved task re-runs against a different form with each value attributed to its profile entry |
| **9** | **CDP Backend & Accessibility-Tree Perception** | `cdp-backend` behind `optional_permissions: ["debugger"]`, `Accessibility.getFullAXTree` perception, trusted input, the focus assertion that keeps never-tier exclusions intact, and detach handling that halts rather than substitutes. **Demonstrable:** a React input that silently rejects programmatic writes fills first try with CDP enabled and reports `WRITE_REJECTED` without it; opening DevTools on the tab halts the run with a named reason; `backend-parity.spec.ts` shows identical gate decisions |
| **10** | **Visual Escalation** | The `look_at` verb with its three gate-enforced triggers, cropped capture, payload discipline, and the local/remote engine split — including capture in a background tab, which requires CDP because `captureVisibleTab` cannot reach one. **Demonstrable:** a canvas-rendered control is acted on after DOM perception reports it unreachable; two identically-labelled buttons resolve by cropped image instead of stopping to ask |
| **11** | **Unattended Execution — Watch, Batch, Scheduled & Task Portability** | Watch mode (PR-AUT-5), list iteration with per-item verification stopping at first failure (J-7), scheduled runs via `chrome.alarms` (PR-TASK-5), and task export/import with the de-privileging trust model (PR-TASK-4). Each carries its own precondition; scheduled runs additionally require OQ-6 resolved. **Demonstrable:** Watch completes a known task stopping only at always-tier boundaries; a batch of five stops at the first failure rather than continuing; an imported task runs at Step mode with no inherited grants |
| **12** | **Hardening, Red-Team & Evaluation Harness** | The injection corpus, the three evaluation layers (fixtures → frozen real-page captures → a small live set), the gate/gauge metric split, and HAR capture per live run so a failure can be diffed against the previous one. **Demonstrable:** the corpus produces zero out-of-scope actions, zero unapproved always-tier actions and zero false confirmations; a live-set failure is attributed to *our* regression or *the site changing*, with the diff shown |
| **13** | **MCP Capability Namespace** | The client, server enrolment, per-tool enablement with user-assigned tiers, untrusted framing of descriptions and results, and mediated elicitation. **Gated, not scheduled:** it starts only once Phase 12's red-team passes clean **and** a concrete journey exists that no native browser capability can serve. **Demonstrable:** an enrolled read-only tool is used inside a run, namespaced and tiered, and a tool result attempting to widen scope is refused and journaled |
| **14** | **Polish, Privacy Disclosure & Store Release** | Accessibility and keyboard control, bundle budgets enforced in CI, permission-rationale copy, and a data-handling disclosure that distinguishes disclosure class A from class B and Local-only from Hybrid rather than blurring them. **Demonstrable:** a submitted, reviewable Chrome Web Store listing whose privacy description matches what the code actually does |

**Shape of the roadmap.** Phases 1–8 are the product; 9–11 are capability escalation; 12–14 are release. **Phase 3 is a defensible stopping point on its own** — the concept's stage-3 "browser copilot" — which is the architecture's answer to R-7. The MVP definition in PRD §14.1 is satisfied at the end of Phase 8.

**On the phase count.** CLAUDE.md offers 4–7 as typical and warns that more than eight usually means phases are too thin. Fourteen is a deliberate departure, taken because the alternative was worse: each of Phases 9–13 introduces either an optional permission with its own enable flow, a new untrusted domain, or a capability with its own precondition already stated in the PRD, and merging any pair would produce a phase that cannot be demonstrated as one thing. Phases 9–14 are written at lower initial depth and deepened when reached; what must be fixed now, and is, are the interfaces they consume.

**Question sequencing is part of the roadmap, not separate from it.** The first draft deferred five open questions to the final phase, which would have meant discovering in Phase 8 that a Phase 4 design was wrong. They are now sorted by cost-of-being-wrong against cost-of-finding-out: **Phase 1** answers what is cheap to test and expensive to be wrong about (offscreen durability, Prompt API reachability); **decided now on reasoning** are the ones no amount of measurement improves (the planner is not an in-browser model; inline completion is sub-second and local); **Phase 2 exit** takes what genuinely needs data but not a finished agent (the planner bake-off, the pruning strategy); and only what truly needs a working product at scale — verification ratio, approval frequency, the benchmark — waits for Phase 12.

---


### 3.11 Open Architectural Questions

Every question below names **the phase that will produce its evidence**, because a question with no owner is a question that gets answered by accident. Two questions from the first draft have been **closed** rather than carried, and are recorded as closed so the reasoning is not lost.

**Closed since the first draft**

| # | Question | Resolution |
|---|---|---|
| ~~Q1a~~ | *Can a 1.5–3B on-device model plan multi-step tasks well enough for Local-only runs to be useful?* | **Closed: no.** Not a measurement worth spending a phase on — a ~3B model does not fail loudly at planning, it produces confidently wrong plans, which is a PP-6 failure at the point it costs most. Local-only planning means Ollama 7–14B, and a run without a capable planner does not start (§3.7.9). What replaced it is Q1 below |
| ~~Q6a~~ | *Remove inline autocomplete entirely, or keep a restricted form?* | **Closed: it stays, restricted.** Local-only inference with no remote code path, granted origins only, the shared sensitive-field classifier, and text-node rendering (§3.7.22). The open part is now model choice, which is Q6 below |

**Open, each attached to the phase that will answer it**

| # | Question | Owning phase | Status |
|---|---|---|---|
| Q1 | *Which* planner-capable models are good enough at browser task planning — Ollama 7–14B classes versus remote frontier models — and how far apart are they? | **Phase 2 exit** | Pulled forward from Phase 8 deliberately. A bake-off needs a planner prompt and fixture snapshots, both of which exist at the end of Phase 2; waiting until an agent is built would risk invalidating Phase 4's design after it is written. The output is a default and a runner-up, not a permanent answer |
| Q2 | What is the right deterministic-vs-model verification ratio? (PRD OQ-5) | Phase 12 | Reframed. The ratio is a **review trigger**, not a gate; the gate is zero false confirmations on Always-tier actions (§3.7.4). Which verification kinds genuinely need model interpretation is measured with the eval harness |
| Q3 | How should perception prune on large and dynamic pages? (PRD OQ-4) | **Phase 2 exit**, revisited Phase 9 | Viewport-first with form-scoped expansion is the starting strategy and needs no study. What needs evidence is behaviour on genuinely large pages — and specifically whether structure-aware pruning ever still hides a needed element. Phase 9 revisits it with the AX tree, which gives **better names, not fewer nodes**: it should reduce `TARGET_AMBIGUOUS`, not payload |
| Q4 | What approval frequency keeps consent meaningful? (PRD OQ-3) | Phase 12 | Partly answered structurally rather than by measurement: Always-tier steps are disclosed in the plan before the run, and denial is non-fatal, so an approval confirms a known decision (§3.9). Frequency, denial rate and time-to-decision are journaled for real numbers |
| Q5 | How is agent quality evaluated against a web that moves? (PRD OQ-7) | Phase 12, harness from Phase 1 | Three layers: hand-built fixtures (clean, deterministic), **frozen real-page captures** (messy and deterministic — the layer neither of the others provides), and a small live set accepted as unstable. HAR capture per live run is what makes "our regression vs the site changed" answerable rather than merely stated as a goal |
| Q6 | Which local model gives the best inline-completion quality within 400 ms? | Phase 4 | Benchmarked in the real extension environment, not in isolation, because the two message hops to the offscreen document are part of the budget. The *interaction* is decided (sub-second, local); only the model is open |
| Q7 | Does the in-page overlay plus side panel split keep users oriented? (PR-UX-1, PR-UX-4) | **Phase 7** | Moved from Phase 4. The split is barely stressed by a single-tab run; it is stressed by a three-tab run where "where is it doing this?" becomes a real question. Stop ownership is already decided (§3.7.19); what is open is comprehension |
| Q8 | How reliable is the offscreen document as a multi-minute runtime? | **Phase 1 spike** | Moved from Phase 4 because everything from Phase 4 onward assumes it. Measured across screen lock, sleep/wake and 30-minute idle, with a ≥90 % survival budget (§3.8). If survival is materially worse, the honest response is a shorter wall-clock budget — **not** durability machinery added for a theoretical interruption |
| Q9 | Does the eighteen-verb vocabulary cover the journeys, or will it grow under pressure? | Phase 6 onward, continuously | Answered with data rather than argument: `ask_user` carries a reason code, and the rate of `MISSING_CAPABILITY` per run measures the gap directly at near-zero cost. Every verb added is a new tier-classification surface and a new gate case, so growth remains a governed change to this document |
| Q10 | Do handle epochs survive SPA route changes that do not fire navigation? | Phase 2 | The settle detector advances the epoch on large mutation bursts, but a route change that swaps content without a URL change is exactly where a stale handle could re-resolve onto a *different* element with the same descriptor. If re-resolution proves unsafe, the fallback is to invalidate all handles on any burst above a threshold and pay the extra snapshot |
| Q11 | Is Chrome's `LanguageModel` reachable from an offscreen document, with `responseConstraint` and image input? | **Phase 1 spike** | **The single riskiest unverified assumption in this document.** An offscreen document is a DOM document rather than a worker, so it *should* work — but "should" is not "is". If it does not: the judge tier falls to WebLLM, which has no constrained decoding, so the ≥98 % schema-valid budget collapses to the 85 % path and `scorer.ts`-style repair returns; local vision disappears, making §3.7.13's remote recommendation the only option; and inline completion needs a different local engine. Declared with its fallback before Phase 4 builds on it |
| Q12 | What exactly happens when DevTools — or another extension — attaches to a tab the CDP backend holds? | Phase 9 | The *design* is already fixed and does not wait: any `onDetach`, for any reason, halts the run and surfaces the reason; there is never a silent fall back to the DOM backend (§3.7.12). What Phase 9 determines is the observed reason strings, the direction of the conflict, and the user-facing message — for DevTools, for a competing extension, for tab duplication, and for a tab moved between windows |
| Q13 | What triggers the MCP work? | Phase 13, gated | Evidence, not a date. Two conditions, both required: Phase 12's red-team corpus passes clean on the browser injection surface, **and** a concrete journey exists that browser capabilities **cannot serve** — deliberately stricter than "would benefit from", which is satisfiable by anyone motivated to satisfy it |
| Q14 | Is a fan-out width of 4 and a roster cap of 8 right? | Phase 7 | Both are reasoned starting values (§3.8) rather than measured ones: four concurrent snapshots is roughly 4×96 KB of transient clone traffic with four pages traversing their DOM at once, and eight is where a roster stops fitting in a cockpit at a glance. Whether memory or supervisability binds first is what Phase 7 measures |
| Q15 | How badly does background-tab throttling degrade settle detection and verification? | Phase 7 | The 1,000 ms / 15 s background calibration is a starting value. The real question is whether some verifications are unreliable enough in a hidden tab that the Supervisor should **focus each tab in turn** before acting — which would trade wall-clock time for reliability and would make the fan-out narrower in practice than Q14 assumes |
| Q16 | Can scheduled runs be reconciled with always-available interruption? (PRD OQ-6) | Phase 11, blocking | Carried directly from the PRD, where PR-TASK-5 conflicts with PP-7 as written: a run nobody is present for cannot be interrupted by a user who is not there. Until this is resolved, scheduled runs stay blocked — the plausible shapes are restricting them to Low-tier-only work, or requiring the user to be present at the always-tier boundary and abandoning the run if they are not |


## Appendix — Requirement Traceability

| Architecture element | Satisfies |
|---|---|
| Policy Gate in the service worker (§3.7.1) | PP-3, PP-4, PR-SEC-1, PR-SEC-4, PR-SEC-13 |
| Opaque handles + registry (§3.7.2) | PR-ACT-5, PR-ACT-7, R-2, C-4 |
| Settle detector (§3.7.3) | PR-PERC-4, PR-VER-1, C-3 |
| Deterministic verification set (§3.7.4) | PR-VER-1…8, SC-4, OQ-5 |
| Journal-derived reporter (§3.7.5) | PP-5, PP-6, PR-RUN-1…4, PR-TRU-1…4, SC-4, SC-5 |
| Channel separation + typed snapshot (§3.7.6) | PR-SEC-10, PR-SEC-11, PR-PERC-6 |
| Stop flag read by the gate (§3.7.7) | PP-7, PR-CTL-8, SC-6 |
| Runtime per-origin grants (§3.7.8) | PR-SEC-5…9, SC-3, R-4 |
| Two-tier inference, no cascade (§3.7.9) | PR-LOC-1…5, PR-PRV-6, C-2 |
| Direct path for text verbs (§3.7.10) | PP-8, PR-TXT-1…3, SC-11 |
| `sensitive.ts` exclusion at snapshot time (§3.9) | PR-ACT-6, PR-PERC-7, PR-PRV-1, SC-2 |
| Recovery table (§3.3.2d) | PR-REC-1…10 |
| Actuation backend abstraction, gate above both (§3.7.12) | PP-3, PP-4, PR-ACT-2, PR-ACT-5, PR-REC-4, R-2 |
| CDP focus assertion before key dispatch (§3.7.12) | PR-ACT-6, PR-PERC-7, PR-PRV-1, SC-2 |
| `look_at` with three gate-enforced triggers (§3.7.13) | PR-PERC-2, PR-VER-3, PR-VER-7, PP-6, OQ-4 |
| Schema-constrained decoding from one Zod 4 schema (§3.7.14) | PR-PLAN-6, PR-REC-2, PR-SEC-4, C-6 |
| MCP namespace, user-assigned tiers, untrusted results (§3.7.15) | PP-3, PR-SEC-1…4, PR-SEC-11, PR-SEC-14 |
| Phase 1 as a precondition phase (§3.10) | PRE-1…PRE-6 |
| Run Supervisor over N Tab Agents (§3.7.16) | PR-NAV-5, J-4, J-7, OQ-2 |
| Per-tab handle isolation, enforced at the gate (§3.7.17) | PR-SEC-1, PR-SEC-4, PR-SEC-13, R-2 |
| Roster enumeration via host permissions only (§3.7.18) | PR-NAV-4, PR-SEC-8, R-4 |
| `open_tab` verb, Phase 7 (§3.3.2a) | PR-NAV-4 |
| Never closing a tab the agent did not open (§3.3.1b) | PR-NAV-6 |
| Authoritative Stop in the side panel (§3.7.19) | PP-7, PR-CTL-8, PR-UX-4, SC-6 |
| Four model tiers; planner never in-browser (§3.7.9) | PR-LOC-1…5, PR-PRV-6, C-2, OQ-9 (closed) |
| Trigger-based re-planning (§3.7.20) | PR-PLAN-5, C-5 |
| Structure-aware pruning, per-region completeness (§3.7.21) | PR-PERC-3, PR-PERC-6, OQ-4 |
| Local-only inline completion (§3.7.22) | PR-TXT-4, PR-PRV-1, PR-SEC-5, OQ-8 (closed) |
| Disclosure classes A/B, local condensation (§3.7.23) | PR-PRV-2…6, PR-LOC-2, PR-SEC-16 |
| Watch mode, batch iteration, scheduled runs (Phase 11) | PR-AUT-5, J-7, PR-TASK-5, OQ-6 |
| De-privileged imported tasks (§3.9) | PR-TASK-4 |
| Three-layer evaluation, gates vs gauges (§3.8, Phase 12) | SC-1…SC-11, OQ-7 |
| Retention policy and purge control (Phase 8) | PR-RUN-6, PR-PRV-4 |
