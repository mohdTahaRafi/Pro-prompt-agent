# Product Requirements Document — Pro Prompt Browser Agent

**Document type:** Product Requirements Document (PRD)
**Product:** Pro Prompt Browser Agent
**Status:** Draft for review — pre-SRS, pre-technical-design
**Date:** 2026-08-30

---

## Document Basis

This PRD is derived from a single primary source:

| Source | Role |
|---|---|
| **`PRO_PROMPT_BROWSER_AGENT_CONCEPT.md`** | **Primary source of truth.** All product behaviour, safety philosophy, capability categories, autonomy model, and scope boundaries in this PRD trace back to it |
| `PRO_PROMPT_TECHNICAL_CAPABILITY_AUDIT.md` (2026-08-27) | Reference for what currently exists, partially exists, or does not exist in Pro Prompt |
| `CEREBRO_TECHNICAL_CAPABILITY_AUDIT.md` (2026-08-27) | Reference for deliberate non-overlap boundaries only |

Where this PRD makes a scope decision that the concept document did not settle, it is marked as a **decision** and the alternative is recorded in §17 Open Questions. Nothing in this document is intended to introduce a feature the concept did not establish.

This PRD defines **what the product must do and how it must behave**. It deliberately contains no architecture, no technology selection, no interface or data definitions, and no delivery schedule.

### Status legend

Every requirement and feature in this document carries a status tag describing its position **today**, not its position after this PRD is delivered.

| Tag | Meaning |
|---|---|
| **[E]** | **Exists** — implemented and working end-to-end in Pro Prompt today |
| **[E–]** | **Exists with known defects** — implemented, but the audit records correctness or security problems that must be resolved |
| **[P]** | **Partial** — written but not wired, documented but not built, or implemented in a form too limited for this product |
| **[N]** | **New** — does not exist in any form; introduced by this PRD |

Pro Prompt is **an in-development project, not a finished product.** No requirement in this document may be treated as already satisfied on the basis of existing code unless it is tagged **[E]**.

### Scope tags

| Tag | Meaning |
|---|---|
| **MVP** | Required for the first releasable version of the Browser Agent |
| **FUTURE** | Explicitly deferred; recorded here so it is not re-invented later |
| **OUT** | Explicitly excluded from the product |

---

## 1. Executive Summary

Pro Prompt is an existing, in-development Manifest V3 browser extension that improves text in place inside other websites' input fields. Its interaction model is one-shot: the user selects an operation, one or more model calls run, improved text is returned. The extension has no awareness of the page beyond article-text extraction, and takes no action other than writing text into a field.

This PRD defines the **Pro Prompt Browser Agent**: an evolution in which the user states a *goal* in natural language and the product plans, acts, observes, verifies, recovers, and reports — inside the browser, on the user's behalf, with the user retaining the ability to inspect, interrupt, correct, and stop the work at any moment.

The defining change is that **the product's actions now alter state outside itself.** Writing text into a field is private and reversible. Clicking Submit, Send, Delete, or Buy is neither. Every requirement in this document concerning approval, verification, permission scoping, and honest reporting exists because of that single change.

The product is positioned deliberately against Pro Prompt's sibling project, Cerebro. Cerebro is a server-side retrieval and measurement system. The Browser Agent is a client-side autonomy and safety system: acting in an untrusted environment, on a constrained platform, with on-device inference available for privacy-sensitive work. Retrieval, vector search, backend services, and pipeline observability dashboards are out of scope by design, not by omission.

This PRD does not claim the problems in this space are solved. Prompt injection from webpage content is unsolved industry-wide; reliable element identification on changing pages is a standing difficulty; the small on-device models Pro Prompt runs today are not reliably capable of multi-step planning. These are carried forward as constraints and open questions rather than being written away.

---

## 2. Product Vision

**Pro Prompt becomes the tool that does browser work for you, and can be trusted with it because it never hides what it did.**

The long-term intent is a browser agent that a user can hand a multi-step task to, watch with a hand on the brake, interrupt at any point, and receive an honest report from — including an honest report of what it failed to do or could not confirm.

Three properties define the product's identity:

1. **Bounded autonomy.** The agent works independently across many steps and stops at every boundary that matters. Autonomy is a dial the user controls, not a property of the product.
2. **Honest reporting.** An action is reported as done only when the resulting state was checked. Missing information is reported as missing. This is a product-level rule, not a quality aspiration.
3. **Privacy by locality.** Pro Prompt has no server component. On-device inference means page content can, for suitable work, never leave the user's machine — a positioning no cloud-hosted agent can match.

---

## 3. Problem Statement

### 3.1 The user's problem

Browser work that a person knows how to describe but has to perform by hand:

| Problem | Illustration |
|---|---|
| Multi-step drudgery | 20 boring clicks between a known starting point and a known outcome |
| Moving information between sites | Read here, restructure, enter there — slow and error-prone for a human, natural for a program |
| Unknown click paths | The user knows the outcome they want but not where the setting is buried |
| Repetition | The same check across several pages, repeatedly |
| The last mile of AI chat | An AI produces an answer, and then the user still has to do the work themselves |

### 3.2 Why the current product does not solve it

Pro Prompt today improves the *text* in one field. Every scenario above requires understanding the page, choosing a sequence of actions, performing them, and knowing whether they worked. The current product does none of these: it has no element-level perception, no action capability beyond writing text, no planning, and no verification.

### 3.3 The honest counter-problem

For a single simple task, a human is faster than an agent and always will be. Value appears only when the task is long, repetitive, or the interface is unfamiliar. A product built here must be explicit about that boundary or it becomes a slower way to do things the user could already do. This constrains what the product should be marketed and designed for.

---

## 4. Goals and Objectives

### 4.1 Product goals

| ID | Goal |
|---|---|
| G-1 | Let a user accomplish a multi-step browser task by stating a goal instead of performing the steps |
| G-2 | Ensure no irreversible action ever occurs without a specific, informed human approval |
| G-3 | Ensure the product's report of what happened matches what actually happened |
| G-4 | Keep the user able to see, pause, correct, take over from, and stop the agent at any moment |
| G-5 | Recover from ordinary browser failures without abandoning the task or involving the user unnecessarily |
| G-6 | Preserve the privacy advantage of on-device inference for work that warrants it |
| G-7 | Preserve the existing value of Pro Prompt's text-quality features rather than discarding them |

### 4.2 Non-goals

| ID | Non-goal | Reason |
|---|---|---|
| NG-1 | Full autonomy without supervision | Contradicts G-2 and G-4; the concept's entire safety model rests on interruptibility |
| NG-2 | Defeating CAPTCHAs, bot detection, or rate limits | Establishes the product as an abuse tool; the concept explicitly rejects this |
| NG-3 | Handling credentials, payment details, or one-time codes on the user's behalf | Excluded absolutely, not gated behind approval |
| NG-4 | Being faster than a human at short, simple tasks | Not achievable and not the value proposition |
| NG-5 | Becoming a retrieval, search, or knowledge system | Reserved to Cerebro; see §7.2 |
| NG-6 | Guaranteeing immunity to prompt injection | Not achievable today by anyone; the product mitigates in layers and says so |

---

## 5. Target Users and User Needs

### 5.1 Primary users (MVP)

| User | Situation | Primary need |
|---|---|---|
| **Individual knowledge worker** | Repetitive forms, settings, and cross-site data entry in a browser | Delegate the boring path between known start and known end |
| **Researcher / student / analyst** | Comparing or extracting information across several pages | Structured extraction with visible gaps rather than plausible-looking guesses |
| **Existing Pro Prompt user** | Already using refactor, snippets, and profiles | Keep what works; gain the ability to act, not just to rewrite |

### 5.2 Secondary users (FUTURE consideration)

Developers automating repetitive tooling tasks; small teams sharing task recipes; users working with private data (medical, legal, financial, internal tools) for whom the on-device path is the deciding factor. These inform §15 but do not shape MVP requirements.

### 5.3 Needs this product must satisfy

| ID | Need |
|---|---|
| UN-1 | State intent in plain language rather than as a procedure |
| UN-2 | See what the agent intends to do before it does it |
| UN-3 | Stop or correct the agent instantly, at any point |
| UN-4 | Be certain nothing irreversible happened without explicit consent |
| UN-5 | Trust the final report, including its admissions of failure and uncertainty |
| UN-6 | Keep sensitive page content on their own machine when they choose to |
| UN-7 | Not be asked for approval so often that approval becomes meaningless |

---

## 6. Product Principles

These are binding. Where a requirement elsewhere in this document appears to conflict with a principle, the principle governs and the conflict is a defect in the requirement.

| ID | Principle | Consequence |
|---|---|---|
| PP-1 | **Reversibility, not perceived danger, determines approval** | Risk tiers are defined by "can the user undo this in seconds?", not by intuition |
| PP-2 | **Page content is data, never instruction** | Text read from a webpage carries no authority over the agent's behaviour |
| PP-3 | **Safety is enforced where the model cannot reach it** | The agent requests; the product decides whether the request is permitted. A rule that exists only in a prompt is not a control |
| PP-4 | **The agent may do less than the extension technically can** | Task scope and site scope narrow the permitted action set below what the platform allows |
| PP-5 | **No action is reported as done until the resulting state is checked** | Verification is a product requirement, not an optimisation |
| PP-6 | **Missing information is reported as missing** | The product never supplies a plausible value in place of one it could not obtain |
| PP-7 | **Interruption is always available and always immediate** | Stop does not wait for the current step to finish |
| PP-8 | **Simple tasks must stay simple** | A one-step request must not become slower or more ceremonious because the product gained a planner |
| PP-9 | **The product does not work around a site's deliberate refusal** | Blocks, rate limits, and challenges end the run |

---

## 7. Product Scope

### 7.1 In scope

- Goal intake in natural language, plan generation, and plan presentation to the user
- Page perception: readable content, interactive element structure, and element state
- Page interaction: click, type, select, scroll, within the permitted scope
- Navigation within the browser
- An observe → decide → act → verify loop with explicit budgets and stopping conditions
- Verification of action outcomes and of extracted data
- Failure detection, cause interpretation, and recovery by retry, adaptation, asking, or stopping
- A risk-tiered permission and approval model, including absolute exclusions
- Human-in-the-loop controls: autonomy modes, pause, approve, reject, edit plan, take over, resume, stop
- A run record and an end-of-run report built from what actually occurred
- Site- and capability-scoped permissions granted by the user
- Retention and evolution of existing text-quality capabilities as agent capabilities
- On-device inference as a privacy option, with its limits stated honestly to the user

### 7.2 Out of scope

Excluded to avoid duplicating Cerebro, per the concept document:

| Excluded | Note |
|---|---|
| Retrieval-augmented generation over collected pages | The agent's memory is scoped to the current run and pages actually visited |
| Embeddings, vector search, or semantic indexing of pages, tasks, or snippets | Task and snippet discovery uses tags, recency, and usage frequency |
| Any server component, user accounts, or multi-tenancy | Pro Prompt's serverless posture is a differentiator and a safety argument |
| LLM provider abstraction as a product pillar | The existing router is retained as unremarkable plumbing |
| Streaming chat infrastructure and chat-transcript UI | The agent's output is a plan, a step list, and a report — not a conversation transcript |
| Pipeline observability dashboards: latency waterfalls, stage histograms, token-cost analytics | The run record required by this PRD is a user-facing narrative of actions and reasons, aimed at trust, not at performance debugging |
| Document ingestion pipelines and corpus building | Reading a page is reading a page |

Excluded for safety or legitimacy reasons:

| Excluded | Note |
|---|---|
| Any interaction with password, payment, or one-time-code fields | Not approvable; see §12 |
| Circumventing CAPTCHAs, bot detection, or rate limiting | See PP-9 |
| Autonomous purchasing or payment | Cart interactions require approval; completing payment is out of scope entirely for MVP |

---

## 8. Core Product Experience

### 8.1 The interaction shape

The product's fundamental loop, as experienced by the user:

```
State a goal
   → see a plan, edit it if wanted, start
      → watch steps execute, each one verified
         → answer a question, or approve a boundary action
            → see the run finish, or stop it
               → read a report that admits what didn't work
```

### 8.2 What the user sees while the agent runs

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-UX-1 | The user can state a goal in natural language from an in-page surface without leaving the page they are working on | [P] — a floating toolbar exists but launches fixed modals, not goal intake | MVP |
| PR-UX-2 | Before any action runs, the product presents the plan it intends to follow, in plain language | [N] | MVP |
| PR-UX-3 | While running, the product continuously shows: the goal, the plan, the current step, completed steps, and the outcome of each completed step | [N] | MVP |
| PR-UX-4 | Every control in §11 is reachable at all times while a run is active, without navigating away from the page | [N] | MVP |
| PR-UX-5 | A single-step goal completes as a single step, with no plan-presentation ceremony | [E] in effect for existing text operations; [N] as an agent behaviour | MVP |
| PR-UX-6 | At the end of a run, the product presents a report stating what was done, what was verified, what failed, and what could not be confirmed | [N] | MVP |
| PR-UX-7 | The in-page surface remains visually isolated from the host page and does not disturb the page's own layout or styling | [E] — shadow-root isolation is implemented for the toolbar | MVP |

### 8.3 Where the product lives

The in-page surface is the primary experience: the user states goals, supervises runs, and approves actions without leaving the page the work concerns. A separate management surface exists for run history, saved tasks, permissions, and profile/policy editing. The existing dashboard is the natural home for the latter, but its current content is oriented around prompt scores and includes a vestigial analytics view; it is **transformed**, not extended.

---

## 9. Major Features and Capabilities

Each feature below states: what the user wants, what the product must enable, expected behaviour, edge cases and limitations, current status, and scope.

---

### 9.1 Goal intake and planning

**What the user wants:** To describe an outcome rather than a procedure.

**What the product must enable:** Accepting a free-text goal, producing a plan of intended steps, showing that plan before execution, and letting the user change it.

**Expected behaviour**

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-PLAN-1 | The product accepts a natural-language goal and restates its understanding of it before planning | [N] | MVP |
| PR-PLAN-2 | The product states, alongside the plan, what it will *not* or cannot do for this goal | [N] | MVP |
| PR-PLAN-3 | The plan is presented in plain language as an ordered list of intended steps | [N] | MVP |
| PR-PLAN-4 | The user can approve, edit, reorder, remove, or add steps before execution begins | [N] | MVP |
| PR-PLAN-5 | The product revises the plan mid-run when observations make the original plan wrong, and shows the revision | [N] | MVP |
| PR-PLAN-6 | Every proposed action is checked against the original stated goal; off-goal actions are refused and surfaced | [N] | MVP |
| PR-PLAN-7 | A goal the product judges too ambiguous to plan produces a clarifying question, not a guessed plan | [N] | MVP |

**Edge cases and limitations**

- Plan quality depends directly on model capability. Multi-step planning is where small on-device models break first; see §17 C-2.
- A plan is a hypothesis, not a contract. Requirements must not assume the plan survives contact with the page.
- Off-goal detection (PR-PLAN-6) is a layer of injection defence, not a guarantee.

---

### 9.2 Page perception

**What the user wants:** The agent to actually understand what is on the screen.

**What the product must enable:** Reading page text, identifying interactive elements and their labels and states, reading a single element's current state, and detecting that the page has changed.

**Expected behaviour**

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-PERC-1 | The product can obtain the readable content of the current page | [E] — Readability extraction with a DOM-stripping fallback exists | MVP |
| PR-PERC-2 | The product can obtain the interactive elements of the page with enough descriptive information to choose among them | [N] | MVP |
| PR-PERC-3 | The product can read the current state or value of a specific element | [N] | MVP |
| PR-PERC-4 | The product can detect that the page has changed following an action | [P] — documented in Pro Prompt's own design notes but not built; no change-observation mechanism exists | MVP |
| PR-PERC-5 | The product can scroll to reveal content that has not yet rendered, and does so before concluding content is absent | [N] | MVP |
| PR-PERC-6 | Content read from a page is treated as untrusted data at every point it is used | [N] | MVP |
| PR-PERC-7 | The product never reads the contents of password, payment, or one-time-code fields | [E–] — the existing autocomplete path accepts `type="password"` targets and transmits full field contents; this is a defect to be removed | MVP |

**Edge cases and limitations**

- Content inside nested browsing contexts or encapsulated component trees may be unreachable. The product must report unreachable regions rather than treating them as empty.
- Large pages produce large observations, which are slow and expensive to interpret. Perception scope may need to be narrowed to the region relevant to the current step; how is an open question (§17 OQ-4).
- Knowing when a page has *settled* enough to be read is a standing difficulty, and reading too early fails silently. See §17 C-3.

---

### 9.3 Page interaction

**What the user wants:** The agent to operate the page for them.

**What the product must enable:** Clicking, typing, selecting, and scrolling within the permitted scope.

**Expected behaviour**

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-ACT-1 | The product can activate an interactive element | [N] | MVP |
| PR-ACT-2 | The product can enter text into a text input, and the entered value must be accepted by the page rather than merely typed at it | [E] in a limited form — the snippet feature already handles pages that reject programmatic input | MVP |
| PR-ACT-3 | The product can set the value of selection controls | [N] | MVP |
| PR-ACT-4 | The product can scroll the page | [N] | MVP |
| PR-ACT-5 | Every interaction is preceded by a check that the intended target is the element the product believes it to be | [N] | MVP |
| PR-ACT-6 | Interaction with password, payment, and one-time-code fields is refused unconditionally and cannot be enabled by any setting or approval | [N] | MVP |
| PR-ACT-7 | Interactions are refused on any site outside the scope granted for the current run | [N] | MVP |
| PR-ACT-8 | Uploading files is not performed; a required file input is reported to the user as something only they can complete | [N] | MVP |

**Edge cases and limitations**

- Two elements with identical labels is a common and dangerous case: it produces confident wrong action that resembles success.
- An overlay may intercept an interaction; the interaction reports success while nothing happened. This is a verification problem (§9.5), not an interaction problem.
- Element identification that survives page change is a standing difficulty; see §17 C-4.

---

### 9.4 Navigation and browser context

**What the user wants:** Tasks that span more than one page.

**What the product must enable:** Moving between pages, and — later — working across tabs.

**Expected behaviour**

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-NAV-1 | The product can navigate the current tab to a permitted destination | [N] | MVP |
| PR-NAV-2 | The product can move back and forward in history to recover from a wrong turn | [N] | MVP |
| PR-NAV-3 | Navigating away from a page containing unsaved user input requires approval | [N] | MVP |
| PR-NAV-4 | The product can open a new tab and read from it | [E–] — tab operations are used today without the corresponding declared permission; this must be made explicit | FUTURE |
| PR-NAV-5 | The product can act across multiple tabs within one run | [N] | FUTURE |
| PR-NAV-6 | The product never closes a tab it did not itself open | [N] | MVP |

**Edge cases and limitations**

- Closing a user's tab destroys work irreversibly and has no undo; PR-NAV-6 is therefore a prohibition rather than an approval gate.
- Multi-tab runs multiply the state the user must supervise. Deferring them to FUTURE is a deliberate scope decision (§17 OQ-2).

---

### 9.5 Verification

**What the user wants:** To believe the report.

**What the product must enable:** Checking, after every action, that the world matches the intent — and marking data as unconfirmed when it cannot.

**Expected behaviour**

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-VER-1 | No action is recorded or reported as successful until the resulting page state has been checked | [N] | MVP |
| PR-VER-2 | The product verifies that a value it entered is present in the target after entry | [N] | MVP |
| PR-VER-3 | The product checks for error indications after actions that can fail visibly | [N] | MVP |
| PR-VER-4 | The product verifies that navigation reached the expected destination | [N] | MVP |
| PR-VER-5 | Where a quantity is knowable, the product compares what it obtained against what it expected to obtain, and investigates a shortfall rather than reporting a partial result as complete | [N] | MVP |
| PR-VER-6 | Every extracted value is traceable to content on a page actually visited in this run; values that are not are excluded | [N] | MVP |
| PR-VER-7 | Where verification is impossible, the outcome is recorded as unconfirmed — never as success and never as failure | [N] | MVP |
| PR-VER-8 | Human confirmation is a fallback for verification, not the default mechanism | [N] | MVP |

**Edge cases and limitations**

- Absence of a confirmation signal does not imply failure; many successful actions produce no visible acknowledgement.
- A visible success message can appear while the underlying request failed. Verification reduces false reporting; it does not eliminate it.
- Verification has a cost. If every action requires a full page read and a model interpretation, runs become slow and expensive. The balance between cheap deterministic checks and model-interpreted checks is unresolved (§17 OQ-5).

---

### 9.6 Failure detection and recovery

**What the user wants:** The agent not to collapse the moment a page behaves unexpectedly.

**What the product must enable:** Detecting failure, interpreting its cause, and choosing between retrying, adapting, asking, and stopping.

**Expected behaviour**

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-REC-1 | The product detects that an action did not produce its intended effect, including when the action itself reported no error | [N] | MVP |
| PR-REC-2 | The product distinguishes among failure causes and selects a response appropriate to the cause, rather than applying a uniform retry | [N] | MVP |
| PR-REC-3 | Transient failures are retried, within a bounded retry count | [N] | MVP |
| PR-REC-4 | Structural changes prompt an alternative approach to the same step | [N] | MVP |
| PR-REC-5 | An obstructing overlay is dismissed and the original action retried, without involving the user | [N] | MVP |
| PR-REC-6 | An authentication requirement pauses the run and hands control to the user; the product never supplies credentials | [N] | MVP |
| PR-REC-7 | A failure that has already partially taken effect is never silently retried; retry requires approval | [N] | MVP |
| PR-REC-8 | A site's deliberate refusal — block, rate limit, or challenge — ends the run with an honest report and no attempt to circumvent it | [N] | MVP |
| PR-REC-9 | Repeating an action with an unchanged result is detected as *stuck*, treated distinctly from *failed*, and ends or escalates the run | [N] | MVP |
| PR-REC-10 | Every run is bounded by limits on total actions, retries per step, and elapsed time; exceeding a limit ends the run and reports why | [P] — the existing refactor loop has a hard iteration cap, establishing the pattern but not the mechanism | MVP |

**Edge cases and limitations**

- Cause interpretation is itself a model judgement and can be wrong. A misdiagnosed cause produces a confidently wrong recovery.
- PR-REC-7 is the hardest of these to satisfy, because "did this partially take effect?" is frequently unknowable from the page.

---

### 9.7 Reporting and the run record

**What the user wants:** To know what happened without having watched.

**What the product must enable:** A durable record of the run and a readable report at the end.

**Expected behaviour**

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-RUN-1 | Every run produces a record of the goal, the plan, each action attempted, each verification outcome, each approval, and the final result | [N] | MVP |
| PR-RUN-2 | The record is built from observed outcomes only; intended actions that were not verified are recorded as such | [N] | MVP |
| PR-RUN-3 | The end-of-run report explicitly lists what failed, what was skipped, and what could not be confirmed | [N] | MVP |
| PR-RUN-4 | The run record is presented as a narrative of actions and reasons for a user deciding whether to trust the result — not as performance instrumentation | [N] | MVP |
| PR-RUN-5 | Past runs are reviewable by the user | [N] | MVP |
| PR-RUN-6 | The user can delete individual runs and clear all run history | [N] — no retention or purge control exists today for stored prompt history either | MVP |

**Edge cases and limitations**

- The run record must not drift toward latency and cost instrumentation; that is Cerebro's territory (§7.2) and a different audience.
- Records may contain sensitive page content; §12 governs their storage and retention.

---

### 9.8 Text capabilities (evolution of the current product)

**What the user wants:** The existing value — good prompts, good rewrites — without regression.

**What the product must enable:** The current text operations, available both directly and as steps within an agent run.

**Expected behaviour**

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-TXT-1 | The user can refactor, generate, condense, and score text directly, as they can today | [E] | MVP |
| PR-TXT-2 | These operations are available to the agent as steps within a run | [N] | MVP |
| PR-TXT-3 | Text operations change no page state and therefore require no approval | [E] in effect | MVP |
| PR-TXT-4 | Replacing text the user wrote themselves is presented before it is applied | [P] — a diff view is described in Pro Prompt's own documentation but was never built; results are written straight into the field today | MVP |
| PR-TXT-5 | Profile-specific guidelines continue to steer generation and scoring | [E] | MVP |

**Edge cases and limitations**

- The refactor loop's scorer is an LLM-as-judge with no golden set, no calibration, and no regression check. Its outputs must not be presented to users as an objective measure. This is unresolved and carried forward (§17 C-6).

---

### 9.9 Profiles as agent policy

**What the user wants:** The agent to know who they are and what it may do for them.

**What the product must enable:** A profile that carries both personal facts used to complete tasks and the policy governing agent behaviour.

**Expected behaviour**

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-POL-1 | A profile carries user-supplied facts the agent may use to complete tasks | [P] — profiles exist and carry free-text context, but as one flat token-capped document with blind append and oldest-first truncation, which is unsuitable for factual recall | MVP |
| PR-POL-2 | A profile carries the agent policy: default autonomy mode, permitted sites, and permitted capabilities | [N] | MVP |
| PR-POL-3 | The user can view and edit everything the agent knows about them | [E] for profile documents; [N] for policy | MVP |
| PR-POL-4 | Facts used to complete a task are attributed in the run record to the profile entry they came from | [N] | MVP |
| PR-POL-5 | The active profile is reliably available whenever a run starts | [E–] — the audit records that the active-profile lookup fails on a cold start, silently running with no profile context; this must be corrected before it governs agent permissions | MVP |
| PR-POL-6 | Profile facts are updated by merge rather than blind append, so newer information supersedes older | [P] — an intelligent context-update capability exists in the codebase but is not wired to anything | FUTURE |

**Edge cases and limitations**

- PR-POL-5 is currently a correctness defect. When profile content becomes the source of *permissions*, the same defect becomes a security failure.
- Profile facts are user-supplied and may be wrong or stale; the agent must be able to report which fact it used so the user can catch this.

---

### 9.10 Saved tasks

**What the user wants:** To not restate a recurring goal every time.

**What the product must enable:** Saving a goal for reuse, evolving the existing snippet concept.

**Expected behaviour**

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-TASK-1 | A goal can be saved, named, and re-run later | [P] — snippets provide a prefix-triggered saved-text mechanism whose interaction model transfers, but they store text for insertion, not goals for execution | MVP |
| PR-TASK-2 | Re-running a saved task re-plans against the current page rather than replaying recorded steps | [N] | MVP |
| PR-TASK-3 | Saved tasks are findable by name, tag, recency, and usage frequency | [N] | MVP |
| PR-TASK-4 | Saved tasks can be exported and imported by the user | [N] — no export or backup exists for any Pro Prompt data today | FUTURE |
| PR-TASK-5 | Saved tasks run on a schedule without the user present | [N] | FUTURE |

**Edge cases and limitations**

- PR-TASK-2 matters: a saved task is a goal, not a macro. Recorded step replay is brittle by nature and would contradict the recovery model.
- PR-TASK-5 removes the user from the loop, which contradicts PP-7 as currently written. It is listed as FUTURE with that conflict explicitly unresolved (§17 OQ-6).

---

### 9.11 On-device inference

**What the user wants:** Sensitive page content not to leave their machine.

**What the product must enable:** Running suitable work locally, with an honest account of what local models can and cannot do.

**Expected behaviour**

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-LOC-1 | The user can select on-device inference, and the product runs suitable work locally | [E] — local inference with model download, load, and error classification is implemented | MVP |
| PR-LOC-2 | The product states clearly which parts of a run are processed locally and which, if any, leave the machine | [N] | MVP |
| PR-LOC-3 | When a step cannot be performed adequately by the selected local model, the product says so rather than degrading silently | [N] | MVP |
| PR-LOC-4 | A run configured as fully local never transmits page content off the machine, and fails the step rather than falling back | [N] — the current provider router cascades to remote providers on failure | MVP |
| PR-LOC-5 | Content sent to a remote provider is scrubbed of detectable sensitive patterns | [E–] — a scrubber exists on the remote path, but produces false positives on ordinary numeric content and covers patterns rather than free text | MVP |

**Edge cases and limitations**

- The on-device models Pro Prompt runs today are small instruct models. They are suited to narrow classification, extraction, and short rewriting; they are **not** reliably capable of multi-step planning, choosing correctly among many page elements, or resisting adversarial text. See §17 C-2, which is the largest unresolved question in the product.
- PR-LOC-4 exists specifically to prevent the failure mode where a local-first promise is quietly satisfied by remote calls.

---

## 10. Key User Journeys

These journeys are drawn directly from the concept document's scenarios. They define expected behaviour, not a feature list, and each is annotated with the scope it requires.

### J-1 — Fill a long form and stop before submitting *(MVP)*

Goal stated on the form page. Plan: read fields, match to profile facts, fill, flag unmatched, compose the free-text answer. Agent fills the fields it is confident about, verifies each value landed, leaves two fields blank and marked, does not touch Submit. Report names the field it guessed at and the file upload only the user can complete.

**Behaviour this pins down:** verification of entered values (PR-VER-2), honest gap reporting (PP-6), Submit as an always-approve boundary (§12), file input exclusion (PR-ACT-8).

### J-2 — Extract structured data from an unstructured page *(MVP)*

Goal states the fields wanted. Agent reads, scrolls to load deferred content, identifies the repeating structure, extracts. It counts what it found against what it detected, investigates the shortfall, and reports the rows it could not complete along with where it looked.

**Behaviour this pins down:** scroll-before-concluding-absent (PR-PERC-5), count verification (PR-VER-5), traceability (PR-VER-6).

### J-3 — Change a buried setting *(MVP)*

Goal names the outcome, not the path. Agent navigates the menu tree one step at a time, re-reading after each step because the next screen is not knowable in advance, toggles the control, verifies the new state, saves, and checks for both a confirmation and the absence of an error.

**Behaviour this pins down:** iterative planning under uncertainty (PR-PLAN-5), state and negative verification (PR-VER-2, PR-VER-3).

### J-4 — Compare several pages and recommend *(MVP for same-tab sequential; FUTURE for multi-tab)*

The full worked example in the concept document. Plan presented and edited by the user; three pages read; one page's content collapsed behind a control, detected by an anomalously low field count and recovered without user involvement; three of twenty-four values unavailable and reported as unknown; recommendation given with reasoning attached.

**Behaviour this pins down:** plan editing (PR-PLAN-4), anomaly-triggered recovery (PR-REC-1, PR-REC-4), unknown-not-guessed (PP-6).

### J-5 — Draft and stop at the send boundary *(MVP)*

Several unremarkable steps — reading a thread, reading adjacent context, drafting with existing text capabilities, placing the draft — followed by one loud checkpoint before an irreversible, externally-visible action, with the specific reason it matters stated in the approval request.

**Behaviour this pins down:** the intended approval ratio (§11.4), approval requests that state consequence rather than asking a generic question (PR-APR-3).

### J-6 — Single-step rewrite in place *(MVP)*

The existing product's behaviour, unchanged in feel. One step, no plan ceremony, no approval, no slowdown.

**Behaviour this pins down:** PP-8.

### J-7 — Repeat one action across a list *(FUTURE)*

Iterating the same action shape over many items, verifying each before starting the next, and stopping at the first failure rather than continuing blindly. Deferred because it multiplies both blast radius and approval load, and needs the approval-fatigue design in §11.4 settled first.

### J-8 — Hand a prepared prompt to an AI site *(FUTURE)*

Extract, condense, compose, place in the AI site's composer, stop before sending. Deferred on durability grounds: third-party AI interfaces change without notice, response completion is difficult to detect, and site terms may prohibit automation. Retained as a feature candidate, explicitly not a foundation.

---

## 11. Human-in-the-Loop and Autonomy Model

### 11.1 Autonomy is a user-controlled dial

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-AUT-1 | The product offers distinct autonomy modes and the user selects among them | [N] | MVP |
| PR-AUT-2 | **Suggest** mode: the product plans and shows the plan, and performs no action until told to proceed | [N] | MVP |
| PR-AUT-3 | **Step** mode: every action requires approval before it runs | [N] | MVP |
| PR-AUT-4 | **Supervised** mode (default): the product acts freely on low-risk actions and stops at every always-approve boundary | [N] | MVP |
| PR-AUT-5 | **Watch** mode: the product runs to completion without stopping, except at always-approve boundaries, which remain non-negotiable in every mode | [N] | FUTURE |
| PR-AUT-6 | The autonomy mode can be set per run, and a default can be set per site | [N] | MVP for per-run; FUTURE for per-site |

**Limitation:** Watch mode is deferred because it is only responsible once recovery and verification have been demonstrated to work on real sites. Always-approve boundaries are not weakened by any mode; the modes govern low-risk and medium-risk actions only.

### 11.2 Controls available during a run

| ID | Control | Required behaviour | Status | Scope |
|---|---|---|---|---|
| PR-CTL-1 | **See** | The plan, current step, completed steps, and each step's verified outcome are visible throughout | [N] | MVP |
| PR-CTL-2 | **Pause** | The run halts and takes no further action until resumed | [N] | MVP |
| PR-CTL-3 | **Approve / Reject** | A specific proposed action is permitted or refused | [N] | MVP |
| PR-CTL-4 | **Reject with reason** | The user's correction is taken into account in the next decision | [N] | MVP |
| PR-CTL-5 | **Edit plan** | Steps can be changed, reordered, added, or removed before they execute | [N] | MVP |
| PR-CTL-6 | **Take over** | The user operates the browser directly while the run is suspended | [N] | MVP |
| PR-CTL-7 | **Resume** | The run continues, re-reading the page first because the user may have changed it | [N] | MVP |
| PR-CTL-8 | **Stop** | The run ends immediately, without completing the action in flight, and the record shows exactly where it stopped | [N] | MVP |

**PR-CTL-8 is absolute.** Stop that waits for the current step is not stop. This is a product requirement precisely because it is inconvenient to implement.

### 11.3 Take-over as the universal escape hatch

Take-over resolves several situations the agent must not attempt itself: authentication, challenges intended to exclude automation, and judgement calls the user has not delegated. The product's correct response to these is to notice and hand over, never to attempt or circumvent.

### 11.4 Approval design and approval fatigue

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-APR-1 | Approval is requested at task boundaries rather than per equivalent action where the actions are equivalent and low-risk | [N] | MVP |
| PR-APR-2 | An always-approve action is never batched, never bundled with other approvals, and never remembered | [N] | MVP |
| PR-APR-3 | An approval request states the specific action, the specific target, the site, and the consequence, in plain language | [N] | MVP |
| PR-APR-4 | Approval requests do not use generic phrasing that could describe any action | [N] | MVP |
| PR-APR-5 | Rejecting an action does not end the run by default; the product re-decides | [N] | MVP |

**Limitation carried forward:** approval fatigue is a real and documented failure mode. A product that asks too often produces consent that has stopped meaning anything. The requirements above reduce frequency and increase specificity, but the correct approval frequency for real tasks is not yet known and cannot be settled on paper (§17 OQ-3).

---

## 12. Trust, Safety, Security, and Privacy Requirements

### 12.1 Risk tiers

Tiering is by reversibility (PP-1), not by intuition.

| Tier | Test | Examples | Approval |
|---|---|---|---|
| **Low** | Changes nothing, or is trivially undone | Reading, scrolling, extracting, summarising, typing into a field the user is already working in | None |
| **Medium** | Reversible but consequential, or leaves the current context | Navigating away from unsaved input, clicking a menu or filter, toggling a setting, replacing user-written text, sending content to a remote provider | Contextual — governed by autonomy mode and site policy |
| **Always** | Irreversible, externally visible, or costly | Submit, send, post, publish, buy, pay, delete; anything that messages another person; any action on banking, payment, health, or government sites | Every time, without exception |
| **Never** | Not approvable at any tier | Reading or entering passwords, payment details, or one-time codes; circumventing blocks or challenges; completing a payment | Prohibited |

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-SEC-1 | Every action is classified into a tier before it executes, and the classification governs whether it may run | [N] | MVP |
| PR-SEC-2 | Always-tier actions require an explicit per-instance approval that cannot be disabled, batched, or persisted | [N] | MVP |
| PR-SEC-3 | Never-tier actions are refused by the product regardless of what the agent requests, what the user approves, or what any setting says | [N] | MVP |
| PR-SEC-4 | Tier classification is enforced outside the model's reach; the model's opinion of an action's risk does not determine whether it runs | [N] | MVP |

### 12.2 Permission scoping

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-SEC-5 | The agent operates only on sites the user has permitted, and the permitted set for a run is visible to the user before it starts | [N] | MVP |
| PR-SEC-6 | The permitted action set for a run may be narrower than what the product is technically capable of, and never wider | [N] | MVP |
| PR-SEC-7 | The user can revoke site or capability permissions at any time, including mid-run | [N] | MVP |
| PR-SEC-8 | The product's declared browser permissions match what it actually uses | [E–] — tab operations are currently performed without a corresponding declared permission | MVP |
| PR-SEC-9 | Permissions requested from the browser are the narrowest that support the granted scope | [E] in current posture — host access is currently limited to two specific origins; broadening it is a deliberate, reviewable decision | MVP |

### 12.3 Defence against instructions embedded in page content

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-SEC-10 | The user's goal and page-derived content are handled as structurally distinct inputs and are never combined into a single undifferentiated input | [N] | MVP |
| PR-SEC-11 | Page-derived content is explicitly framed as untrusted and possibly hostile wherever it is used | [N] — Cerebro applies the equivalent rule to document content; the technique transfers, the stakes do not | MVP |
| PR-SEC-12 | An action inconsistent with the user's original stated goal is refused and surfaced to the user | [N] | MVP |
| PR-SEC-13 | Capability and site limits are enforced independently of the model's decisions, so an instruction embedded in a page cannot widen the agent's reach | [N] | MVP |
| PR-SEC-14 | Escalation to an always-tier action always requires a human; no page-derived content can approve anything | [N] | MVP |
| PR-SEC-15 | Defined suspicion signals — including content hidden from view, instruction-shaped page text, unexpected origin changes, and requests for credentials — halt the run and inform the user of the specific reason | [N] | MVP |
| PR-SEC-16 | Product messaging never claims immunity to embedded-instruction attacks | [N] | MVP |

**Limitation carried forward, in the strongest terms available:** this class of attack is unsolved industry-wide. PR-SEC-10 to PR-SEC-15 are layered mitigations that reduce risk. The product's design, its documentation, and its user-facing copy must all assume the model will eventually be fooled, and must ensure that when it is, the blast radius is bounded by controls the model does not participate in.

### 12.4 Sensitive data handling

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-PRV-1 | Password, payment, and one-time-code field contents are never read, transmitted, stored, or included in any record | [E–] — the existing autocomplete path violates this today | MVP |
| PR-PRV-2 | The existing autocomplete behaviour — enabled by default across all sites, accepting password-type targets, transmitting entire field contents — is corrected or removed before any agent capability ships | [E–] | MVP, precondition |
| PR-PRV-3 | Content displayed from model output or page content is rendered so that it cannot execute or alter the host page | [E–] — ghost-text overlay and snippet popover construction are both unsafe today, and the snippet popover is injected into the host page rather than an isolated root | MVP, precondition |
| PR-PRV-4 | Stored run records and prompt history have a user-visible retention policy and a purge control | [E–] — prompt history is stored indefinitely in the clear with no purge or export | MVP |
| PR-PRV-5 | Credentials the user supplies to the product are stored in a way that does not replicate them beyond the device without the user's knowledge | [E–] — the remote provider key is currently stored in a synchronised store, replicating it to every browser signed into the same account | MVP |
| PR-PRV-6 | The user is told, before a run starts, whether that run will send page content off the device | [N] | MVP |

**PR-PRV-2 and PR-PRV-3 are preconditions, not features.** They are defects in a text-improvement product. In a product that can act on the user's behalf, they are disqualifying. No agent capability should ship while they stand.

### 12.5 Honest reporting as a safety property

| ID | Requirement | Status | Scope |
|---|---|---|---|
| PR-TRU-1 | The product never presents an unverified action as completed | [N] | MVP |
| PR-TRU-2 | The product never supplies a value it did not obtain, however plausible | [N] | MVP |
| PR-TRU-3 | Uncertainty is stated in the report rather than smoothed over | [N] | MVP |
| PR-TRU-4 | Where the product is unable to determine whether an action took effect, it says exactly that | [N] | MVP |

---

## 13. Existing Pro Prompt → Browser Agent Evolution

This section states what happens to each existing capability. It is a scope contract: features listed as removed or transformed must not be silently carried forward in their present form.

| Existing capability | Current status | Disposition | Rationale |
|---|---|---|---|
| Profiles / personas | [E] with a cold-start lookup defect | **Transformed, elevated** | Becomes the carrier of both user facts and agent policy (§9.9). Defect PR-POL-5 must be fixed before it governs permissions |
| Profile context document | [P] — flat, token-capped, blind-append, oldest-first truncation | **Transformed** | Adequate for prompt flavouring, inadequate as factual memory for task completion |
| Intelligent context merge | [P] — implemented in the codebase, not wired to anything | **Deferred** | Points at the right problem; not required for MVP |
| Prompt refactoring | [E] | **Retained, demoted** | Becomes one capability among many (PR-TXT-1, PR-TXT-2) |
| Prompt generation | [E] | **Retained, demoted** | As above |
| Score / critique loop | [E], unvalidated | **Retained internally, not surfaced as a measure** | The scorer has no golden set or calibration; presenting its output as objective would breach PP-6 |
| Snippets | [E] | **Transformed** | The prefix-triggered interaction survives; the payload becomes a saved goal (§9.10) |
| Inline autocomplete | [E–], the product's largest security liability | **Removed or severely restricted** | Off-mission for an agent product and disqualifying in its present form (PR-PRV-2). Retaining it in any form requires it to be off by default, scoped to permitted sites, and incapable of targeting sensitive fields |
| Page extraction | [E] | **Transformed into core infrastructure** | Must grow from article text to element structure and change detection (§9.2) |
| AI website integration | [E] | **Retained, deferred, not a foundation** | Durability and terms-of-service concerns; J-8 is FUTURE |
| On-device inference | [E] | **Retained as the differentiator, with stated limits** | §9.11 and §17 C-2 |
| Provider fallback routing | [E] | **Retained as plumbing** | Must not become a product pillar (§7.2); PR-LOC-4 constrains its cascade behaviour |
| Floating toolbar | [E] | **Transformed into the primary product surface** | From a launcher for fixed modals to the run cockpit (§8.2) |
| Dashboard | [E], with a vestigial analytics view | **Transformed** | Becomes run history, saved tasks, permissions, and profile/policy editing. The current analytics view records one event type and reads from a different store than it records into; it is not a foundation |
| Sensitive-pattern scrubbing | [E–] | **Retained, strengthened** | False-positive behaviour on ordinary numeric content is a known weakness; an agent reads far more of a page than a text improver does |
| Service-worker keep-alive machinery | [E] | **Retained, insufficient** | Sustaining short inference is a solved problem here; sustaining coherent multi-step run state is not |
| Testing, continuous integration, release process | None | **Precondition** | An agent capable of acting on a user's behalf that has never been tested is not shippable. This is not a feature; it is a gate |

---

## 14. MVP / Initial Product Scope

### 14.1 What the MVP is

**A single-tab, permission-scoped, supervised browser agent that completes multi-step tasks on sites the user has explicitly allowed, verifies every action, stops at every irreversible boundary, and reports honestly.**

### 14.2 MVP inclusions

| Area | Included |
|---|---|
| Goal and plan | Natural-language goal, plan presented before execution, plan editable, plan revised on new observations |
| Perception | Page content, interactive element structure, element state, change detection, scroll-to-reveal |
| Action | Click, type, select, scroll — within the permitted site and capability scope |
| Navigation | Within the current tab, including back and forward |
| Verification | State, appearance, negative, location, count, and traceability checks; unconfirmed as a first-class outcome |
| Recovery | Cause-differentiated response; bounded retries; overlay dismissal; stuck detection; run budgets |
| Autonomy | Suggest, Step, and Supervised modes, selectable per run |
| Controls | See, pause, approve, reject, reject-with-reason, edit plan, take over, resume, stop |
| Safety | Full tier model, never-tier prohibitions, permission scoping, untrusted-content handling, suspicion halts |
| Reporting | Run record, end-of-run report, run history, deletion controls |
| Text capabilities | All existing operations, available directly and as agent steps |
| Profiles | Facts plus policy; permitted sites and capabilities; cold-start defect resolved |
| Saved tasks | Save, name, re-run by re-planning |
| On-device | Local inference selectable, with honest disclosure of what is local and what is not |

### 14.3 MVP preconditions

These are not features, and no agent capability ships while any of them stands open:

| ID | Precondition |
|---|---|
| PRE-1 | Autocomplete's all-sites, password-field-accepting, whole-field-transmitting behaviour is corrected or removed (PR-PRV-2) |
| PRE-2 | Unsafe rendering of model output and page content into the host page is corrected (PR-PRV-3) |
| PRE-3 | The active-profile cold-start defect is corrected (PR-POL-5) |
| PRE-4 | Declared browser permissions match actual usage (PR-SEC-8) |
| PRE-5 | Stored credential replication behaviour is corrected (PR-PRV-5) |
| PRE-6 | A test and continuous-integration practice exists, covering at minimum the tier classification, the never-tier prohibitions, and the verification behaviour |

### 14.4 Explicit MVP exclusions

| Excluded from MVP | Where it goes |
|---|---|
| Multi-tab runs | FUTURE (PR-NAV-4, PR-NAV-5) |
| Watch mode | FUTURE (PR-AUT-5) |
| Repeating an action across a list | FUTURE (J-7) |
| Driving third-party AI site interfaces | FUTURE (J-8) |
| Scheduled or unattended runs | FUTURE (PR-TASK-5) |
| Task export, import, and sharing | FUTURE (PR-TASK-4) |
| Per-site autonomy defaults | FUTURE (PR-AUT-6) |
| Intelligent profile-fact merging | FUTURE (PR-POL-6) |
| Any payment completion | OUT |
| Any credential or one-time-code handling | OUT |

### 14.5 MVP scope decisions

These were not settled by the concept document and are decided here, with alternatives recorded in §17:

| Decision | Alternative not taken |
|---|---|
| Single-tab only for MVP | Multi-tab from the start — rejected because it multiplies both supervision load and blast radius before verification is proven |
| Supervised as the default mode | Suggest as the default — rejected because it makes the product feel like the current one; recorded as OQ-1 |
| Explicit user site allow-listing rather than run-anywhere | Broad host access from the start — rejected on both safety and store-review grounds |
| Saved tasks re-plan rather than replay | Recorded step replay — rejected as brittle and contradictory to the recovery model |

---

## 15. Future Scope

Recorded so that it is neither forgotten nor smuggled into MVP. Nothing here is committed.

| Area | Description | Preconditions |
|---|---|---|
| Multi-tab and cross-site runs | Working across several sources in one run | Verification and supervision proven on single-tab runs |
| Watch mode | Unattended execution between always-tier boundaries | Demonstrated recovery reliability on real sites |
| List iteration | The same action shape across many items | Approval-fatigue design settled (OQ-3) |
| AI site integration | Prompt handoff and response retrieval | Accepted as inherently fragile; never a foundation |
| Scheduled runs | Recurring tasks without the user present | Resolution of the conflict with PP-7 (OQ-6) |
| Task sharing and portability | Export, import, and shared task recipes | A trust model for imported tasks, which are executable instructions from a third party |
| User-defined capabilities | Users extending what the agent can do | Substantially larger safety surface; effectively a separate product decision |
| Domain specialisations | Research, study, analysis, or developer workflows | Narrower and more reliable than a general agent, because success is definable |
| Fully-local agent positioning | Complete runs with no off-device transmission | Depends entirely on C-2 |

---

## 16. Product Success Criteria

Success criteria are stated as product outcomes. Some are hard gates; others are directional and currently unmeasurable with confidence, which is stated rather than hidden.

### 16.1 Hard gates — the product is not acceptable if any fails

| ID | Criterion |
|---|---|
| SC-1 | Zero always-tier actions occur without a specific per-instance human approval |
| SC-2 | Zero interactions occur with password, payment, or one-time-code fields |
| SC-3 | Zero actions occur on sites outside the run's permitted scope |
| SC-4 | Zero reported successes correspond to actions whose outcome was not checked |
| SC-5 | Zero values appear in a report that were not obtained from a page visited in that run |
| SC-6 | Stop halts the run without completing the action in flight, in every tested case |

### 16.2 Directional criteria

| ID | Criterion | Measurement note |
|---|---|---|
| SC-7 | A defined set of representative tasks completes without user intervention beyond expected approvals | Requires a fixed task set; results are not stable over time because the sites change |
| SC-8 | Ordinary recoverable failures are recovered without involving the user | Depends on which failures are classified as ordinary; classification is itself a judgement |
| SC-9 | Approval frequency is low enough that users read approval requests rather than dismissing them | Behavioural, and not measurable from within the product alone |
| SC-10 | Users report that the end-of-run report matched what actually happened | Qualitative; the honest counterpart to SC-4 |
| SC-11 | Single-step text operations are no slower and no more ceremonious than in the current product | Directly measurable; guards PP-8 |

### 16.3 The measurement problem

Evaluating an agent is genuinely hard and largely unsolved. Runs are non-deterministic, the environment changes underneath the test, and defining "did it work" is itself difficult. The criteria above should be treated as a starting position, not a finished evaluation design. This uncertainty is carried forward deliberately (§17 OQ-7).

---

## 17. Risks, Constraints, Assumptions, and Open Questions

### 17.1 Risks

| ID | Risk | Severity | Note |
|---|---|---|---|
| R-1 | Instructions embedded in page content subvert the agent | **High, unsolved** | Mitigated in layers; never claimed as solved (§12.3) |
| R-2 | Confidently wrong action that resembles success | **High** | Two identically-labelled controls is the ordinary case; verification reduces but does not remove this |
| R-3 | Approval fatigue converts consent into a reflex | **Medium–high** | A design problem, easy to get wrong, and it hollows out the entire safety model |
| R-4 | Store review of the broader host access an agent requires | **Medium–high** | An agent needs access that an agent looks alarming asking for |
| R-5 | Third-party interface changes break capabilities without warning | **Medium** | Why J-8 is FUTURE and never a foundation |
| R-6 | Existing security defects carried into an acting product | **Medium, fully controllable** | Addressed as MVP preconditions (§14.3) |
| R-7 | Scope: this is a substantially larger product than the current one | **Medium** | A page-aware, single-action copilot is a complete and defensible product on its own if the full agent proves too large |
| R-8 | Users over-trust the agent because it usually works | **Medium** | Honest reporting is the primary counterweight |

### 17.2 Constraints

| ID | Constraint |
|---|---|
| C-1 | The product has no server component, by design. All capability is client-side |
| C-2 | The on-device models available today are small instruct models, suited to narrow classification, extraction, and short rewriting. They are not reliably capable of multi-step planning, choosing among many page elements, or resisting adversarial text. **This is the largest unresolved constraint in the product** and it directly determines whether a fully-local agent is achievable |
| C-3 | Determining when a page has settled enough to be read reliably is a standing difficulty; reading too early fails silently |
| C-4 | Element identification that survives page change is the perennial weakness of browser automation |
| C-5 | The extension platform terminates background work aggressively; sustaining coherent state across a multi-minute run is materially harder than sustaining a single inference call |
| C-6 | The existing scorer is an LLM-as-judge with no golden set, no calibration, and no regression check. Its output must not be presented as an objective measure |
| C-7 | Sites may prohibit automation in their terms; the product does not override a site's stated position or its technical refusal |

### 17.3 Assumptions

| ID | Assumption | If false |
|---|---|---|
| A-1 | Users will accept plan review and approval checkpoints in exchange for delegating multi-step work | The product's value proposition collapses toward the existing single-step product |
| A-2 | A capable planning model is available to the product, whether local or remote | The product must narrow to scripted, well-known tasks |
| A-3 | Users will grant site-scoped access to sites they trust | Adoption is limited to a small set of low-sensitivity sites |
| A-4 | The tasks users want are long, repetitive, or unfamiliar enough to be worth delegating | The agent is slower than doing it manually and the product has no audience |
| A-5 | Existing text capabilities retain their value inside the new product | The evolution argument in §13 weakens and MVP scope should shrink accordingly |

### 17.4 Open questions

| ID | Question | Why it is open |
|---|---|---|
| OQ-1 | Should Supervised or Suggest be the default autonomy mode? | Supervised is decided for MVP (§14.5), but the trust cost of acting before the user has learned to trust the agent is unmeasured |
| OQ-2 | When do multi-tab runs become appropriate? | Deferred, but several valuable journeys (J-4 in full, J-8) depend on them |
| OQ-3 | What approval frequency keeps consent meaningful? | Cannot be settled on paper; requires observation of real use |
| OQ-4 | How should perception scope be narrowed on large pages? | Full-page observation is slow and expensive; narrowing risks missing the relevant element |
| OQ-5 | What is the right balance between cheap deterministic verification and model-interpreted verification? | Affects cost, speed, and reliability simultaneously; identified in the concept as the most technically interesting problem in the direction |
| OQ-6 | Can scheduled or unattended runs be reconciled with always-available interruption? | PR-TASK-5 conflicts with PP-7 as currently written; unresolved |
| OQ-7 | How is agent quality evaluated over time against a changing web? | §16.3; largely unsolved in the industry |
| OQ-8 | Should inline autocomplete be removed entirely or retained in a restricted form? | §13 permits either; the restricted form carries ongoing risk for a feature that is off-mission |
| OQ-9 | If planning requires a remote model, how is that presented to a user who chose the product for its local-only posture? | Directly follows from C-2; a product-positioning question as much as a technical one |

---

## Appendix A — Requirement Index by Area

| Prefix | Area | Section |
|---|---|---|
| PP- | Product principles | §6 |
| PR-UX- | Core experience | §8 |
| PR-PLAN- | Goal intake and planning | §9.1 |
| PR-PERC- | Page perception | §9.2 |
| PR-ACT- | Page interaction | §9.3 |
| PR-NAV- | Navigation and browser context | §9.4 |
| PR-VER- | Verification | §9.5 |
| PR-REC- | Failure detection and recovery | §9.6 |
| PR-RUN- | Reporting and run record | §9.7 |
| PR-TXT- | Text capabilities | §9.8 |
| PR-POL- | Profiles as agent policy | §9.9 |
| PR-TASK- | Saved tasks | §9.10 |
| PR-LOC- | On-device inference | §9.11 |
| PR-AUT- | Autonomy modes | §11.1 |
| PR-CTL- | Run controls | §11.2 |
| PR-APR- | Approval design | §11.4 |
| PR-SEC- | Safety and permissions | §12.1–12.3 |
| PR-PRV- | Privacy and sensitive data | §12.4 |
| PR-TRU- | Honest reporting | §12.5 |
| PRE- | MVP preconditions | §14.3 |
| SC- | Success criteria | §16 |
| R- / C- / A- / OQ- | Risks, constraints, assumptions, open questions | §17 |

---

## Appendix B — Traceability to the Concept Document

| PRD section | Concept section |
|---|---|
| §2, §3 | §1 The big picture |
| §9, §10 | §2 Ten realistic scenarios, §4 Capability categories |
| §8, §11 | §3 What agentic behaviour actually is, §6 Human in the loop |
| §12 | §5 Permissions and safety |
| §9.6 | §7 Failure and recovery |
| §9.5, §12.5 | §8 Verification |
| §10 J-4 | §9 A full multi-step task |
| §13 | §10 What happens to the existing Pro Prompt |
| §7.2 | §12 What not to build |
| §14, §15 | §13 A conceptual evolution, §14 The ceiling |
| §17 | §11.1 The genuinely hard parts, and the closing risk register |
