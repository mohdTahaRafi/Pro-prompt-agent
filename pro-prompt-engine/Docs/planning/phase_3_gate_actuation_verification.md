# Phase 3 — Policy Gate, Actuation & Verification: the Single-Action Copilot

**Document type:** Phase 3 execution document
**Architecture basis:** `architecture.md` §3.3.2a (vocabulary), §3.3.2c (`ActionRequest`/`ActionOutcome`), §3.7.1 (gate/model separation), §3.7.4 (deterministic verification), §3.7.7 (stop at the gate), §3.7.12 (backend abstraction), §3.7.17 (ownership), §3.8, §3.9
**PRD basis:** PR-ACT-1…8, PR-VER-1…8, PR-SEC-1…4, PR-SEC-5…7, PR-CTL-8, PR-APR-3/4, SC-1, SC-2, SC-3, SC-6
**Depends on:** Phase 1 (grants, schemas, tests, run tables), Phase 2 (snapshot, registry, settle)

---

## 1. Objective

At the end of this phase the product can **do one thing to a page, decide whether it was allowed to, and know whether it worked** — with the deciding and the doing in different processes. The Policy Gate exists in the service worker and runs its eight ordered checks on every action. The tier classifier and the never-rules exist and have no override path. `ActuationBackend` exists as an interface with its DOM implementation behind it. Six deterministic verification kinds run as plain code with no model call. Every one of these produces a journal event.

There is no planner. The user names one action in plain terms — *"click the Continue button"*, *"type Mohd Taha into the full name field"* — a deterministic resolver matches it to a handle in the current snapshot, and the gate decides. This is the concept's stage-3 **browser copilot**, and per §3.10 it is a defensible stopping point on its own.

**By the end of this phase:** on a granted page, a user types *"click Continue"* into the debug panel; the extension resolves it to `e17`, the gate permits it as Low tier, the DOM backend clicks it, the settle detector waits, the verifier confirms the URL changed, and the panel shows `permitted → acted → confirmed (location: /step-2)` with four journal rows behind it. The user types *"click Submit application"*; the gate classifies **Always**, refuses to execute, and shows *"Submit application — on gov.uk — this submits your application and cannot be undone. Approve?"* The same request against an origin the user has not granted returns `OUT_OF_SCOPE` with nothing having touched the page.

**No planner, no plan, no multi-step run, no recovery, no model calls, no side panel, no multi-tab.** One action at a time, named by the user. The `runs` row exists because the gate re-derives its context from persisted state, but a "run" in this phase is a single action's worth of life. Recovery from failure is *reported*, never *attempted* — that is Phase 6.

---

## 2. What this phase inherits

| From | Consumed how |
|---|---|
| Phase 1 `scope.ts` | `isGranted(origin)` is gate check 3. `sitePolicy.capabilities` is what narrows the permitted verb set below the vocabulary |
| Phase 1 `runs` / `runEvents` tables | The gate reads the run row on every call; `journal.ts` writes events |
| Phase 1 `result.ts` | Every gate and backend function returns `Result`. Nothing throws across a context boundary |
| Phase 2 `registry.ts` | Handle resolution and re-resolution. `ambiguous` becomes `TARGET_AMBIGUOUS` here |
| Phase 2 `perception.ts` | The snapshot the resolver matches against, and the `epoch` the gate validates |
| Phase 2 `settle.ts` | Waited on after every action, before verification |
| Phase 2 `sensitive.ts` | Already ran at snapshot time. The gate re-checks anyway (§4.6) |

**Nothing resembling a gate, a tier, an action, or a verification exists in the repository today.** The closest thing is `snippet-manager.ts`'s `setText()` — `el.value = text` followed by a dispatched `input` event — which is precisely the technique that fails on React-controlled inputs and is the single most common source of silent action failure (§3.2 of the architecture's gap table). This phase replaces it with the native-setter technique (§6.3) and puts a verifier behind it.

---

## 3. The verb vocabulary

Eighteen verbs, closed set — nineteen from Phase 7, when `open_tab` becomes callable — exactly as fixed in architecture §3.3.2a. The table below therefore has nineteen rows, of which `open_tab` is the one not yet in the vocabulary. **This phase implements eleven of them** and declares the rest with a gate refusal of `NOT_YET_IMPLEMENTED`, so the schema is complete from the first commit and Phase 4's constrained decoding has a stable target.

| Verb | Args | Class | Default tier | Phase |
|---|---|---|---|---|
| `read_page` | — | Perception | Low | 2 |
| `read_structure` | `region?` | Perception | Low | 2 |
| `read_element` | `handle` | Perception | Low | 2 |
| `wait_for_settle` | `maxMs?` | Perception | Low | 2 |
| `scroll` | `handle \| direction, amount` | Interaction | Low | **3** |
| `click` | `handle` | Interaction | **classified per target** | **3** |
| `type` | `handle, text, mode` | Interaction | Low, or Medium if replacing user text | **3** |
| `select` | `handle, value` | Interaction | Medium | **3** |
| `navigate` | `url` | Navigation | Medium; Always if unsaved input present | **3** |
| `history_back` | — | Navigation | Medium | **3** |
| `history_forward` | — | Navigation | Medium | **3** |
| `look_at` | `handle \| 'viewport'` | Perception (visual escalation) | Low | 10 |
| `open_tab` | `url` | Navigation | Medium | 7 |
| `summarise` | `textRef, shape?` | Thinking | Low | 8 |
| `transform` | `textRef, shape` | Thinking | Low | 8 |
| `refactor` | `text` | Thinking | Low | 8 |
| `generate` | `description` | Thinking | Low | 8 |
| `ask_user` | `question, reason, options?` | Control | — | 5 |
| `finish` | `outcome, summary` | Control | — | 5 |

`request_approval` is deliberately **not** a verb. Approval is an outcome the gate produces, never something the requester can decide it needs or decide it does not need.

### 3.1 `lib/schemas/action.schema.ts`

The single definition that both validates at the gate and, from Phase 4, constrains decoding (§3.7.14).

```ts
import { z } from 'zod';
export const HandleSchema = z.string().regex(/^e[0-9]+$/);

export const ActionSchema = z.discriminatedUnion('verb', [
  z.object({ verb: z.literal('read_page') }),
  z.object({ verb: z.literal('read_structure'), region: z.string().optional() }),
  z.object({ verb: z.literal('read_element'),   handle: HandleSchema }),
  z.object({ verb: z.literal('wait_for_settle'), maxMs: z.number().int().min(100).max(15_000).optional() }),

  z.object({ verb: z.literal('scroll'),
             target: z.union([HandleSchema, z.enum(['up','down','top','bottom'])]),
             amount: z.number().int().min(1).max(20).optional() }),   // in viewport-heights/10
  z.object({ verb: z.literal('click'), handle: HandleSchema }),
  z.object({ verb: z.literal('type'), handle: HandleSchema,
             text: z.string().max(4_000),
             mode: z.enum(['replace','append']) }),
  z.object({ verb: z.literal('select'), handle: HandleSchema, value: z.string().max(200) }),

  z.object({ verb: z.literal('navigate'), url: z.string().url().max(2_000) }),
  z.object({ verb: z.literal('history_back') }),
  z.object({ verb: z.literal('history_forward') }),

  // Declared now, refused NOT_YET_IMPLEMENTED until their phase.
  z.object({ verb: z.literal('look_at'), target: z.union([HandleSchema, z.literal('viewport')]) }),
  z.object({ verb: z.literal('open_tab'), url: z.string().url().max(2_000) }),
  z.object({ verb: z.literal('summarise'), textRef: z.string(), shape: z.string().optional() }),
  z.object({ verb: z.literal('transform'), textRef: z.string(), shape: z.string() }),
  z.object({ verb: z.literal('refactor'),  text: z.string().max(20_000) }),
  z.object({ verb: z.literal('generate'),  description: z.string().max(4_000) }),
  z.object({ verb: z.literal('ask_user'),  question: z.string().max(500),
             reason: z.enum(['AMBIGUOUS_TARGET','MISSING_CAPABILITY','NEEDS_USER_DATA','SITE_BLOCKED']),
             options: z.array(z.string().max(120)).max(6).optional() }),
  z.object({ verb: z.literal('finish'),
             outcome: z.enum(['completed','completed_with_gaps','failed','stuck']),
             summary: z.string().max(2_000) }),
]);

export const ActionRequestSchema = z.object({
  requestId: z.string().uuid(),
  runId: z.number().int(),
  tabId: z.number().int(),          // mandatory: the gate resolves origin from THIS tab
  epoch: z.number().int().positive(),
  action: ActionSchema,
  reason: z.string().max(300),      // why the requester wants this; journaled verbatim
});
```

**Why `tabId` is mandatory from Phase 3, when the roster is always length one.** The gate's origin check must resolve against the tab named in the request rather than against the run's scope union (§3.7.17). Making the field optional now and mandatory in Phase 7 would mean a Phase 7 migration of the gate's most security-critical check, on a code path that by then has been correct for four phases. It costs one field today.

**`scroll`'s `amount` unit.** Tenths of a viewport height, 1–20, so `amount: 10` is one screen. A pixel count would be meaningless across devices, and an unbounded number would let one action scroll a page 40,000 pixels — a change large enough that the settle detector and the verifier could not sensibly reason about it.

---

## 4. The Policy Gate

### 4.1 Where it runs and why that matters

`lib/policy/gate.ts` runs **in the service worker**. The requester runs in the offscreen document (from Phase 5) or, in this phase, in the options page. They communicate only by serialised `ActionRequest`. The enforcement rules are not in the same memory, the same prompt, or the same call stack as the thing being enforced (§3.7.1).

The gate **never calls a model**. Not for tier classification, not for goal anchoring, not for target selection. Every check is a pure function over persisted state and the request. This is checkable: `tests/unit/gate.spec.ts` asserts that `lib/policy/**` imports nothing from `lib/model/**` or `lib/adapters/**`, and CI fails if that changes.

### 4.2 The eight ordered checks

Order is load-bearing. Each check is cheaper than the one after it, and each refusal is a distinct code so the report can say which boundary was hit.

```ts
export async function gate(req: ActionRequest): Promise<ActionDecision> {
  // 1. RUN IDENTITY — does this run exist, and is the request for the run we think?
  const run = await db.runs.get(req.runId);
  if (!run) return refuse('UNKNOWN_RUN');

  // 2. TAB IDENTITY — is this tab in the run's roster, and does it still exist?
  if (!run.roster.includes(req.tabId)) return refuse('TAB_NOT_IN_ROSTER');
  const tab = await chrome.tabs.get(req.tabId).catch(() => null);
  if (!tab || !tab.url) return refuse('TAB_GONE');

  // 3. ORIGIN SCOPE OF THAT TAB — resolved from THIS tab's CURRENT url,
  //    never from the run's union of grants (§3.7.17).
  const origin = toOrigin(tab.url);
  if (!origin) return refuse('OUT_OF_SCOPE');
  if (!run.scope.includes(origin)) return refuse('OUT_OF_SCOPE');
  if (!(await isGranted(origin))) return refuse('OUT_OF_SCOPE');   // Chrome is the truth

  // 4. HANDLE OWNERSHIP — a handle from another tab's registry, or another epoch,
  //    is refused before any backend is consulted.
  const handle = handleOf(req.action);
  if (handle) {
    const owner = await ownership.lookup(req.runId, handle, req.epoch);
    if (!owner)                        return refuse('UNKNOWN_HANDLE');
    if (owner.tabId !== req.tabId)     return refuse('HANDLE_NOT_OWNED');
    if (owner.epoch !== req.epoch)     return refuse('STALE_EPOCH');
  }

  // 5. ACTION + RISK TIER — the verb must be in the vocabulary, in this run's
  //    permitted set, and its tier determines what happens next.
  const parsed = ActionSchema.safeParse(req.action);
  if (!parsed.success)                          return refuse('MALFORMED_ACTION');
  if (!IMPLEMENTED_VERBS.has(parsed.data.verb)) return refuse('NOT_YET_IMPLEMENTED');
  const policy = await db.sitePolicy.get(origin);
  if (!policy?.capabilities.includes(parsed.data.verb)) return refuse('CAPABILITY_NOT_GRANTED');

  const tier = classifyTier(parsed.data, await ownership.descriptor(req.runId, handle), origin);
  if (tier === 'never') return refuse('NEVER_TIER');

  // 6. RUN STATE — canAct is answered from a persisted string, with no
  //    interpreter to rehydrate on a cold service-worker wake.
  if (!canAct(run.state)) return refuse('RUN_STATE');

  // 7. STOP STATE — read from chrome.storage.session, which survives a cold
  //    wake and never touches disk. Read LAST among the cheap checks so it is
  //    as close as possible in time to the dispatch.
  const { stopped } = await chrome.storage.session.get(`stop:${req.runId}`);
  if (stopped) return refuse('STOPPED');

  // 8. APPROVAL REQUIREMENT — Always tier, or Medium under a mode that requires it.
  if (tier === 'always' || requiresApproval(tier, run.mode)) {
    return { permitted: false, tier, needsApproval: true,
             prompt: buildApprovalPrompt(parsed.data, origin, descriptor) };
  }
  return { permitted: true, tier };
}
```

**Budget and goal-anchor checks are absent from this phase and their positions are reserved.** `goal-anchor.ts` needs a goal, which needs a plan, which is Phase 5. `budget.ts` needs a multi-action run. Both slot in at check 5.5 and 6.5 respectively. **[Phase 5.]**

### 4.3 Refusal codes

| Code | Meaning | Surfaced to the user as |
|---|---|---|
| `UNKNOWN_RUN` | No run row | *"That run no longer exists."* |
| `TAB_NOT_IN_ROSTER` / `TAB_GONE` | Tab is not this run's, or is closed | *"That tab is no longer part of this task."* |
| `OUT_OF_SCOPE` | Origin not granted, or granted then revoked | *"Pro Prompt isn't allowed on `<origin>`. Grant it first."* |
| `UNKNOWN_HANDLE` | No registry entry | Internal; journaled, shown in the run detail |
| `HANDLE_NOT_OWNED` | Handle belongs to a different tab | Internal; a hard-gate violation if it ever happens outside a test |
| `STALE_EPOCH` | Handle is from an older snapshot | *"The page changed; re-reading it."* |
| `MALFORMED_ACTION` | Failed schema validation | Internal |
| `NOT_YET_IMPLEMENTED` | Declared verb, unimplemented phase | Internal |
| `CAPABILITY_NOT_GRANTED` | Verb outside this origin's capability set (PR-SEC-6) | *"This site is allowed to be read but not changed."* |
| `NEVER_TIER` | Sensitive target or prohibited action | *"I will never type into a password, payment, or one-time-code field."* |
| `RUN_STATE` | Run is paused, halted, awaiting something | *"The task is paused."* |
| `STOPPED` | Stop flag set | *"Stopped."* |

Every refusal is journaled as `action.refused {code, verb, tabId, origin}` **before** the response is sent. A refusal that is not recorded is a refusal the report cannot explain.

### 4.4 `lib/policy/ownership.ts`

The gate cannot see the content script's registry — that lives in the page's isolated world. So the gate keeps a **shadow ledger**: when a snapshot crosses into the service worker, `ownership.record()` stores `{runId, tabId, epoch, handle → {role, name, inputType, formId, actionable}}` in `chrome.storage.session`.

```ts
// lib/policy/ownership.ts
const key = (runId: number) => `own:${runId}`;

export async function record(runId: number, tabId: number, snap: PerceptionSnapshot) {
  const store = (await chrome.storage.session.get(key(runId)))[key(runId)] ?? {};
  store[tabId] = {
    epoch: snap.epoch,
    handles: Object.fromEntries(snap.elements.map(e => [e.handle, {
      role: e.role, name: e.name, inputType: e.inputType, ordinal: e.ordinal,
      formId: e.formId, actionable: e.actionable, valueShape: e.valueShape,
      href: e.href, sensitiveKind: e.sensitiveKind ?? null,
    }])),
  };
  await chrome.storage.session.set({ [key(runId)]: store });
}
```

**Why `storage.session` rather than memory.** The service worker is terminated on idle and the gate is routinely cold-started. An in-memory ledger would be empty on the first action after a wake, refusing every handle with `UNKNOWN_HANDLE`. `storage.session` survives the wake, dies with the browser, and never touches disk — the exact lifetime a handle ledger should have.

**Why the ledger duplicates the descriptor.** The tier classifier needs the target's role, name and input type to decide (§5), and it must decide **without asking the content script**, because the content script is on the page the model was influenced by. A gate that phoned the page to ask "what kind of element is this?" would let the page answer.

Size: 150 descriptors × ~120 bytes ≈ 18 KB per tab. `storage.session` has a 10 MB quota; at 8 tabs (Phase 7) that is 144 KB. Comfortable.

### 4.5 `lib/agent/run-state.ts`

```ts
const LEGAL: Record<RunState, RunState[]> = {
  planning:               ['awaiting_plan_approval','running','failed','stopped','halted'],
  awaiting_plan_approval: ['running','stopped','failed'],
  running:                ['awaiting_approval','awaiting_user','paused','taken_over',
                           'running','completed','failed','stopped','halted'],
  awaiting_approval:      ['running','stopped','failed','halted'],
  awaiting_user:          ['running','stopped','failed','halted'],
  paused:                 ['running','stopped','halted'],
  taken_over:             ['running','stopped','halted'],
  halted: [], stopped: [], failed: [], completed: [],
};

/** The gate's hot predicate. One boolean, from a persisted string, no interpreter. */
export function canAct(state: RunState): boolean { return state === 'running'; }

export function transition(from: RunState, to: RunState): Result<RunState, 'ILLEGAL_TRANSITION'> {
  return LEGAL[from].includes(to) ? Ok(to) : Err('ILLEGAL_TRANSITION');
}
```

Eleven states, ~30 flat edges, shared verbatim by the gate and (from Phase 5) the Supervisor. `running → running` is legal and is the normal case: an action completes and the run stays running. The four terminal states have empty transition lists, which is what makes "a completed run cannot be resurrected" a table lookup rather than a convention.

### 4.6 Defence in depth on the sensitive check

`sensitive.ts` already excluded these fields at snapshot construction (Phase 2 §7.1), so a handle for one does not exist and check 4 would refuse it as `UNKNOWN_HANDLE`. The gate checks **again** at check 5 via `never-rules.ts`, against the ledger's stored descriptor.

This is deliberate redundancy, and it is worth the cost for one reason: the two checks fail differently. The Phase 2 exclusion fails if the classifier missed a field. The gate check fails if the ledger was populated from a snapshot built before a classifier fix, or by a future backend that builds descriptors differently — Phase 9's AX-tree perception, for instance, walks a different data structure entirely. One check in the page, one in the gate, on independently-derived data.

---

## 5. Tier classification

### 5.1 The classifier

```ts
// lib/policy/tiers.ts — pure, synchronous, no I/O, no model
export function classifyTier(
  action: Action, target: LedgerDescriptor | null, origin: string,
): Tier {
  // ── NEVER, first and unconditionally. No later branch can lower this. ──
  if (target && NEVER_KINDS.has(target.sensitiveKind)) return 'never';
  if (isSensitiveOrigin(origin) && MUTATING_VERBS.has(action.verb)) return 'never';

  switch (action.verb) {
    case 'read_page': case 'read_structure': case 'read_element':
    case 'wait_for_settle': case 'scroll':
      return 'low';

    case 'click':
      return classifyClick(target, origin);

    case 'type':
      // Medium if it REPLACES text the user wrote; Low if the field is empty.
      if (action.mode === 'replace' && target?.valueShape &&
          target.valueShape !== 'empty') return 'medium';
      return 'low';

    case 'select':      return 'medium';
    case 'navigate':    return 'medium';   // → 'always' if unsaved input, see §5.3
    case 'history_back': case 'history_forward': return 'medium';
    default:            return 'low';
  }
}
```

### 5.2 `classifyClick` — the whole difficulty in one function

A click is the only verb whose tier genuinely depends on what it hits. Reversibility is the test (PP-1), not intuition.

```ts
const ALWAYS_NAME_RE = /\b(submit|send|post|publish|buy|purchase|order|pay|checkout|
  place[\s-]?order|confirm[\s-]?(and|&)?[\s-]?pay|delete|remove[\s-]?account|
  deactivate|close[\s-]?account|cancel[\s-]?(subscription|order|booking)|
  apply[\s-]?now|book[\s-]?now|transfer|withdraw|donate|subscribe|unsubscribe|
  accept[\s-]?(offer|terms)|sign[\s-]?(contract|agreement)|reply|comment|share|
  invite|report|block|unfriend|leave[\s-]?(group|review))\b/i;

function classifyClick(t: LedgerDescriptor | null, origin: string): Tier {
  if (!t) return 'medium';                       // unknown target: never Low

  // 1. A submit control inside a form is Always, whatever it is called.
  //    This is the structural signal and it outranks the name.
  if (t.inputType === 'submit' || t.inputType === 'image') return 'always';
  if (t.role === 'button' && t.inputType === 'submit' && t.formId) return 'always';

  // 2. Name-based classification for controls that are not form submits —
  //    the "Send" button of a JS-driven composer has no <form> at all.
  if (ALWAYS_NAME_RE.test(t.name)) return 'always';

  // 3. Sensitive origins: any click that is not provably a read is Always.
  if (isSensitiveOrigin(origin)) return 'always';

  // 4. Links that leave the origin are Medium — they leave the run's context.
  if (t.role === 'link' && t.href && toOrigin(t.href) !== origin) return 'medium';

  // 5. Everything else — a tab, a disclosure toggle, a filter, a menu item —
  //    is trivially undone and is Low.
  return 'low';
}
```

**The obvious objection, answered.** A regex over an accessible name is a heuristic, and heuristics miss. A button labelled "Continue" that actually posts an order is classified Low and would run without approval. Three things bound that:

1. **The structural check runs first.** In practice, controls that commit something are `type=submit` inside a form far more often than not, and that path does not consult the name at all.
2. **The name comes from `accname.ts`, not from `textContent`.** A page cannot easily hide "Submit" behind a visual label of "Continue" without also lying to screen readers, which most real sites do not.
3. **Misclassification in the *safe* direction is free.** A "Filter" button classified Always costs one approval prompt. A "Buy" button classified Low costs the user money. So every ambiguous case in the table resolves upward, and `ALWAYS_NAME_RE` is deliberately over-broad — `share`, `reply`, `comment` are all in it because they are externally visible even though none is expensive.

**This is stated as a limitation in the product's own copy** (PR-SEC-16 applies to tier classification as much as to injection): the approval prompt says *"I think this submits the form"*, not *"this submits the form"*.

### 5.3 `navigate` and unsaved input

`navigate` is Medium normally and **Always** when the current page holds unsaved user input (PR-NAV-3). "Unsaved input" is determined by the gate from the ledger, not by asking the page: any descriptor in the current epoch whose `inputType` is a text kind and whose `valueShape` is not `'empty'`, where that value **was not written by this run**. The journal is the record of what this run wrote, so the check is a journal query, not a heuristic.

```ts
async function hasUnsavedUserInput(runId: number, tabId: number): Promise<boolean> {
  const ledger = await ownership.forTab(runId, tabId);
  const written = new Set((await journal.query(runId, 'action.observed'))
    .filter(e => e.data.verb === 'type' && e.tabId === tabId)
    .map(e => e.data.handle));
  return Object.entries(ledger.handles).some(([h, d]) =>
    TEXT_INPUT_TYPES.has(d.inputType ?? '') && d.valueShape !== 'empty' && !written.has(h));
}
```

### 5.4 `lib/policy/never-rules.ts`

```ts
const NEVER_KINDS = new Set<SensitiveKind>(['password','payment','otp']);

// Origins where ANY mutating verb is Never for MVP. Not a blocklist of bad sites —
// a list of domains where an agent mistake is not recoverable by the user.
const SENSITIVE_ORIGIN_RE = [
  /\b(bank|banking|creditunion|paypal|stripe|wise|revolut|venmo)\b/i,
  /\.(bank|insurance)$/i,
  /\b(gov|gouv|gob|gc\.ca|gov\.uk|nic\.in|govt\.nz)\b/i,        // government
  /\b(nhs|health|patient|medicare|medicaid|epic|mychart)\b/i,   // health
];

export function isSensitiveOrigin(origin: string): boolean {
  const host = new URL(origin).hostname;
  return SENSITIVE_ORIGIN_RE.some(re => re.test(host));
}
```

**There is no override path, and that is enforced structurally, not by convention.** `classifyTier` returns `'never'` from its first branch; `gate()` returns `refuse('NEVER_TIER')` immediately at check 5. No parameter, mode, setting, site policy, or approval reaches either. `tests/unit/never-rules.spec.ts` asserts this by exhaustion: for every combination of `mode × posture × sitePolicy.capabilities × approval-granted`, a `type` on a `password` descriptor refuses.

Note what this costs: a run on `gov.uk` cannot fill a form without approval on every mutating action, because the origin is in the sensitive list. J-1's own scenario is a government-style application form. That friction is deliberate — it is the difference between "the agent filled my visa application" being a story about convenience and being a story about a mistake nobody could undo.

---

## 6. Actuation

### 6.1 The interface

```ts
// lib/actuation/backend.ts   [new]
export interface ActuationBackend {
  readonly kind: 'dom' | 'cdp';
  attach(tabId: number): Promise<Result<void, BackendError>>;
  detach(tabId: number): Promise<void>;
  perceive(tabId: number, req: PerceiveArgs): Promise<Result<PerceptionSnapshot, BackendError>>;
  act(tabId: number, action: Action, epoch: number): Promise<Result<ActEffect, FailureCause>>;
  capture(tabId: number, clip?: Rect): Promise<Result<Blob, BackendError>>;   // [Phase 10]
}

/** What the backend observed itself doing. NOT a verification — that is separate. */
export interface ActEffect {
  dispatched: true;
  preState?: string;      // the value/URL/state before, for the verifier's `before`
  targetRect?: Rect;      // where it landed, for Phase 10's cropped capture
  elapsedMs: number;
}
```

`ActEffect` records what was dispatched, never whether it worked. Keeping "I clicked" and "it took effect" as separate values in separate modules is the whole of §3.7.4, and merging them is how an agent starts reporting successes it did not observe.

### 6.2 `dom-backend.ts`

Lives in the service worker, beneath the gate, and proxies to `agent.content.ts` over `chrome.tabs.sendMessage`. It holds no policy — a permitted action arrives and is performed.

```ts
// lib/actuation/dom-backend.ts
export const domBackend: ActuationBackend = {
  kind: 'dom',
  async attach() { return Ok(undefined); },     // no-op; the content script is already there
  async detach() {},
  async act(tabId, action, epoch) {
    const res = await chrome.tabs.sendMessage(tabId, {
      type: 'ACTUATE', action, epoch,
    }).catch(() => null);
    if (!res) return Err('TARGET_MISSING');     // no content script = no page we can reach
    return res.ok ? Ok(res.value) : Err(res.error as FailureCause);
  },
  // …perceive proxies PERCEIVE_STRUCTURE; capture is Phase 10
};
```

### 6.3 `lib/page/actuator.ts` — the part that actually touches the DOM

```ts
export async function actuate(
  action: Action, epoch: number, registry: ElementRegistry,
): Promise<Result<ActEffect, FailureCause>> {
  const t0 = performance.now();

  // ── STOP, checked one last time immediately before touching anything (§3.7.7) ──
  if (await isStopped()) return Err('STOPPED');

  const handle = handleOf(action);
  if (handle) {
    const r = registry.resolve(handle, epoch);
    if (r.kind === 'missing')   return Err('TARGET_MISSING');
    if (r.kind === 'ambiguous') return Err('TARGET_AMBIGUOUS');
    const el = r.node;

    // ── Pre-action target re-checks (PR-ACT-5). All five, in order. ──
    if (!el.isConnected)                     return Err('TARGET_MISSING');
    if (classifySensitive(el) !== null && action.verb !== 'read_element')
                                             return Err('NEVER_TIER_AT_ACTUATOR');
    const vis = visibilityOf(el);
    if (!vis.visible)                        return Err('TARGET_MISSING');
    if ((el as HTMLInputElement).disabled)   return Err('TARGET_DISABLED');
    if (isObscured(el))                      return Err('OBSCURED');
  }
  // …dispatch per verb
}

/**
 * Occlusion check: is the element's centre point actually the element (or a
 * descendant of it)? A cookie banner or a modal covering the target is the
 * single most common reason a "successful" click does nothing.
 */
function isObscured(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return true;
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top  + r.height / 2);
  if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return isObscured(el);     // one retry after scrolling; recursion depth is 2
  }
  // elementFromPoint pierces open shadow roots via composedPath in Chrome.
  const top = document.elementFromPoint(cx, cy);
  if (!top) return true;
  return !(top === el || el.contains(top) || top.contains(el));
}
```

**`NEVER_TIER_AT_ACTUATOR` is the third independent sensitive check** — snapshot, gate, actuator. It should be unreachable. It exists because "should be unreachable" is not a property, and if it ever fires the journal records a gate bypass, which is a hard-gate violation to be investigated rather than a runtime condition to be handled.

#### Typing, and the native-value-setter technique

```ts
async function doType(el: HTMLElement, text: string, mode: 'replace'|'append'): Promise<ActEffect> {
  const before = readValue(el);
  el.focus();
  if (document.activeElement !== el && !el.contains(document.activeElement)) {
    return { dispatched: true, preState: before, elapsedMs: 0, focusFailed: true };
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const next = mode === 'append' ? el.value + text : text;

    // THE TECHNIQUE. React (and Vue, and Angular) attach a value setter to the
    // element instance that shadows the prototype's. Assigning el.value = x
    // writes through the framework's own setter, which updates the DOM but
    // NOT the framework's internal state — so the framework's next render
    // overwrites it and the typing silently vanishes. Calling the prototype's
    // native setter directly, then dispatching a bubbling `input` event, makes
    // the framework's own listener observe a real change and update its state.
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
    setter.call(el, next);

    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    // contenteditable has no value property; insertText is the only path that
    // produces the beforeinput/input pair rich editors listen for.
    const sel = window.getSelection();
    if (mode === 'replace') { sel?.selectAllChildren(el); }
    else { sel?.selectAllChildren(el); sel?.collapseToEnd(); }
    document.execCommand('insertText', false, text);
  }
  return { dispatched: true, preState: before, elapsedMs: … };
}
```

`document.execCommand` is deprecated and is used anyway, deliberately: it remains the only API that produces the `beforeinput`/`input` event pair that Quill, ProseMirror, Lexical and TipTap listen for, and no replacement has shipped. `navigator.clipboard.write` plus a paste event is the alternative and requires clipboard permission plus overwriting the user's clipboard, which is worse. **When `execCommand` is removed from Chrome, the fallback is a `beforeinput` + manual `Range` mutation + `input` dispatch, and the code carries that note at the call site.**

`isTrusted === false` on every event we dispatch. A site that checks it will reject our input. That is the `WRITE_REJECTED` failure cause, it is detected by read-back (§7.2), and it is the class of failure Phase 9's CDP backend retires with genuinely trusted input.

#### Clicking

```ts
async function doClick(el: HTMLElement): Promise<ActEffect> {
  const beforeUrl = location.href;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  await raf();                                    // one frame, so layout settles

  // The full pointer sequence, in the order a real click produces it. A bare
  // el.click() skips pointerdown/mousedown, which many custom controls and
  // every drag-aware component listen for instead of `click`.
  const r = el.getBoundingClientRect();
  const init = { bubbles: true, cancelable: true, composed: true,
                 clientX: r.left + r.width/2, clientY: r.top + r.height/2, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  el.dispatchEvent(new PointerEvent('pointerup',   { ...init, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.dispatchEvent(new MouseEvent('click', init));
  return { dispatched: true, preState: beforeUrl, targetRect: r, elapsedMs: … };
}
```

`el.click()` is **not** used, because it dispatches only the `click` event with no preceding pointer sequence.

#### Selecting

`select` sets `el.value` through the same native-setter path, then dispatches `input` and `change`. If no `<option>` matches the requested value by `value` or by trimmed visible text, the actuator returns `Err('TARGET_MISSING')` with the available option labels attached — never a nearest match. Picking the closest option is exactly the confident-wrong-action failure PP-6 forbids.

#### Navigating

`navigate` and the history verbs are performed **from the service worker**, not the content script — `chrome.tabs.update({url})` and `chrome.tabs.goBack/goForward` — because a content-script navigation destroys the script that issued it before it can report. The gate confirms the destination origin is in scope *before* dispatch; a navigate to an ungranted origin is `OUT_OF_SCOPE` at check 3 against the *destination*, in addition to the source-tab check.

---

## 7. Verification

### 7.1 The six deterministic kinds

Every one runs as plain code with no model call (§3.7.4).

| Kind | Question | Implementation | Used after |
|---|---|---|---|
| `state` | Does the target now hold the intended value? | Read the value back and compare, after normalising whitespace and, for numeric inputs, after `Number()` coercion | `type`, `select` |
| `appearance` | Did a node matching an expected description appear? | Re-walk the target's region; look for a descriptor matching `{role, name}` | `click` that should open something |
| `disappearance` | Did an expected node go away? | Same walk; assert absence | `click` on a dismiss/close control |
| `location` | Did the URL or origin change as expected? | Compare `tab.url` before and after | `navigate`, `history_*`, submit-like clicks |
| `count` | Do the extracted rows match the detected repeating block? | Compare `regions['repeat:…'].total` before and after | `scroll`, expand-control clicks |
| `negative` | Did a new error indication appear? | Look for a node with `role=alert`, `[aria-invalid=true]`, or a validation-message element **inside the target's own form** that was not present in the pre-action snapshot | **every** mutating action |

The negative check runs after *every* mutating action, not only after ones expected to fail. A `type` that lands correctly and simultaneously trips "This field must be a valid email" has succeeded at the state check and failed at the task, and only the negative check catches it (PR-VER-3).

### 7.2 The verdict

```ts
export type Verified = 'confirmed' | 'unconfirmed' | 'failed';

export interface VerificationResult {
  verified: Verified;
  check: VerificationKind;
  evidence?: { before?: string; after?: string; detail?: string };
  failureCause?: FailureCause;
}
```

**Three values, by design. There is no fourth for "we assume so"** (PR-VER-7, PP-5).

```ts
export async function verify(
  action: Action, effect: ActEffect, post: PerceptionSnapshot, pre: PerceptionSnapshot,
): Promise<VerificationResult> {
  // A snapshot that never settled cannot support a `confirmed` verdict. The page
  // was still changing when we read it, so what we read may not be what will be.
  const downgrade = !post.settled;

  switch (action.verb) {
    case 'type': {
      const el = post.elements.find(e => e.handle === action.handle);
      if (!el) return { verified: 'unconfirmed', check: 'state',
                        evidence: { detail: 'target no longer present after action' } };
      const got = el.valueShape ?? '';
      const want = action.mode === 'append' ? (effect.preState ?? '') + action.text : action.text;
      if (normalise(got) !== normalise(want)) {
        return { verified: 'failed', check: 'state',
                 failureCause: 'WRITE_REJECTED',
                 evidence: { before: effect.preState, after: got } };
      }
      const neg = negativeCheck(pre, post, el.formId);
      if (neg) return { verified: 'failed', check: 'negative',
                        failureCause: 'PARTIAL_EFFECT', evidence: { detail: neg } };
      return { verified: downgrade ? 'unconfirmed' : 'confirmed', check: 'state',
               evidence: { before: effect.preState, after: got } };
    }
    // …click, select, navigate, scroll
  }
}
```

**`unconfirmed` is not a soft failure and is never smoothed into success.** A `select` on a page that renders its own custom listbox and does not expose the chosen value in the DOM produces `unconfirmed` with `detail: 'no readable post-state'`. The report says so (PR-TRU-4). Phase 5's step resolver treats two consecutive `unconfirmed` verdicts on one step as a re-planning trigger (§3.7.20 trigger 3); it never treats one as a pass.

**The false-confirmation gate.** §3.8 makes exactly one verification property a zero-tolerance CI gate: *a `confirmed` verdict on an Always-tier action that did not take effect must never occur.* `tests/e2e/false-confirm.spec.ts` drives a fixture whose submit button is wired to swallow the click, asserts `verified !== 'confirmed'`, and is the assertion that fails the build. The deterministic-share ratio (≥80 %) is recorded as a **review trigger**, not a gate — optimising it can actively damage the property it stands in for.

### 7.3 What is *not* in this phase

`semantic` and `traceability` verification need the judge tier, which is Phase 4. Until then, a step that would need them returns `unconfirmed` with `check: 'semantic', detail: 'no judge model available'`. That is honest, it is the correct behaviour under §3.7.9's judge failure mode, and it means the Phase 3 copilot never claims a semantic success.

---

## 8. The journal

```ts
// lib/agent/journal.ts   [new] — the ONLY path into runEvents
const seqCache = new Map<number, number>();

export async function append(runId: number, kind: RunEventKind,
                             tabId: number | null, data: unknown): Promise<void> {
  await db.transaction('rw', db.runEvents, async () => {
    const seq = (seqCache.get(runId) ??
      ((await db.runEvents.where('runId').equals(runId).count()))) + 1;
    seqCache.set(runId, seq);
    await db.runEvents.add({ runId, seq, kind, at: Date.now(), tabId, data });
  });
}
```

The `seq` is derived inside the transaction so two concurrent appends cannot collide, and cached so the common case is one `add` rather than a count plus an add. Budget: ≤ 10 ms, never blocking the loop (§3.8) — the caller does not `await` it on the hot path; it awaits it at step boundaries, so a slow write delays the next step rather than the current one.

Phase 3 event kinds: `run.created`, `action.requested`, `action.permitted`, `action.refused`, `action.dispatched`, `action.observed`, `approval.requested`, `approval.granted`, `approval.denied`, `run.completed`.

---

## 9. Approval

Always-tier actions hold at `awaiting_approval`. The request is built by the gate and is required to name four things (PR-APR-3, PR-APR-4):

```ts
function buildApprovalPrompt(a: Action, origin: string, t: LedgerDescriptor): ApprovalPrompt {
  return {
    action: verbPhrase(a, t),          // "Click “Submit application”"
    target: t.name || `${t.role} ${t.ordinal}`,
    site:   new URL(origin).hostname,  // "www.gov.uk"
    consequence: consequenceFor(a, t), // "I think this submits the form. It is likely
                                       //  irreversible and visible to the site's owner."
    tier: 'always',
  };
}
```

`consequenceFor` returns a specific sentence per matched pattern, never a generic one. There is no *"Do you want to allow this action?"* string anywhere in the codebase, and `tests/unit/approval-copy.spec.ts` asserts that every generated prompt contains the target's name and the hostname.

**One approval queue, strictly serial.** `chrome.storage.session` holds at most one pending approval per run. A second Always-tier request while one is pending is refused `RUN_STATE` — the run is in `awaiting_approval` and `canAct` is false. Concurrent approval requests are never issued (§3.7.16), and with a roster of one this is trivially true; Phase 7 keeps it true across a roster.

Approval is **never batched, never remembered, never disabled** (PR-SEC-2, PR-APR-2). The pending record carries a `requestId` and the approval token is checked against exactly that id, so an approval granted for one action cannot be replayed onto another.

---

## 10. Stop

Stop writes `{[`stop:${runId}`]: true}` to `chrome.storage.session` and aborts any in-flight `AbortController`. The gate reads it at check 7 on every action; the actuator reads it once more immediately before touching the DOM (§6.3).

**The physical floor is one in-flight DOM operation.** Stop cannot un-do a click already dispatched to the page. Everything after it is refused. That is what PR-CTL-8 costs and it is why stop is a shared flag rather than a message the loop must choose to honour.

The budget is **≤ 250 ms from press to gate-visible** (§3.8), covering the `storage.session` write and the message round trip. `tests/e2e/stop.spec.ts` drives a fixture with a deliberately slow settle, presses stop mid-action, and asserts: zero further `action.dispatched` events, the run reaches `stopped`, and the journal's last event is within 250 ms of the stop press.

---

## 11. The single-action copilot surface

The demonstrable product. A **Copilot** panel in the options page — the side panel is Phase 5.

The user picks a granted tab, types an instruction, and presses Go. `lib/agent/intent.ts` maps the text to an `ActionRequest` **deterministically, with no model**:

```ts
const PATTERNS: Array<[RegExp, (m: RegExpMatchArray, s: PerceptionSnapshot) => Action | null]> = [
  [/^click (?:the )?["“]?(.+?)["”]?(?: button| link)?$/i,
   (m, s) => byName(s, m[1], ['button','link','menuitem','tab','checkbox'])],
  [/^type ["“](.+?)["”] (?:in|into) (?:the )?["“]?(.+?)["”]?(?: field| box)?$/i,
   (m, s) => { const t = byName(s, m[2], ['textbox','searchbox','combobox']);
               return t ? { verb: 'type', handle: t.handle, text: m[1], mode: 'replace' } : null; }],
  [/^select ["“](.+?)["”] (?:in|from) (?:the )?["“]?(.+?)["”]?$/i, …],
  [/^scroll (down|up|to the (top|bottom))$/i, …],
  [/^go (back|forward)$/i, …],
  [/^(?:go to|open) (https?:\/\/\S+)$/i, …],
  [/^read (?:the )?(page|structure)$/i, …],
];
```

`byName` matches an element by exact accessible name first, then case-insensitive, then a unique substring. **Two matches means it asks** — it renders both with their region labels and makes the user pick, rather than guessing. That is `TARGET_AMBIGUOUS` surfaced at the intake layer, and it is the same product decision the agent will make in Phase 6.

Unmatched text gets *"I understood that as an instruction I don't have a way to perform. I can click, type, select, scroll, navigate, go back and forward, and read."* — no model, no guess.

This resolver is **throwaway code**. Phase 5 replaces it with the planner and the step resolver, and this file is deleted then. It is labelled as such in its own header comment.

---

## 12. Tasks & Acceptance Criteria

| # | Task | Acceptance Criteria |
|---|---|---|
| 3.1 | Fill `lib/schemas/action.schema.ts` with all nineteen declared verbs | `z.toJSONSchema(ActionSchema)` produces valid JSON Schema; `action-schema.spec.ts` accepts one valid instance of each declared verb and rejects a twentieth verb, a malformed handle, and a 5,000-character `type` text |
| 3.2 | Implement `lib/agent/run-state.ts` | `run-state.spec.ts`: all 30 legal edges succeed; all 91 illegal edges return `ILLEGAL_TRANSITION`; the four terminal states accept none; `canAct` is true only for `running` |
| 3.3 | Implement `lib/policy/ownership.ts` over `storage.session` | `ownership.spec.ts`: a recorded snapshot round-trips; a handle from tab 2 looked up under tab 1 returns a mismatch; the ledger survives a simulated SW restart (cleared module state, retained storage) |
| 3.4 | Implement `lib/policy/tiers.ts` and `never-rules.ts` | `tiers.spec.ts` covers every row of §5 **in both directions** — each input yields the stated tier, and no other input yields it accidentally. `never-rules.spec.ts` asserts refusal across every combination of mode × posture × capabilities × approval |
| 3.5 | Implement `lib/policy/gate.ts` with the eight checks in order | `gate.spec.ts`: each check refuses with its own code when it alone is violated; the checks fire in the documented order (asserted by violating two at once and observing the earlier code); `lib/policy/**` imports nothing from `lib/model/**` or `lib/adapters/**` |
| 3.6 | Implement `lib/actuation/backend.ts` + `dom-backend.ts` | The interface compiles with a stub `cdp-backend` that throws `NOT_IMPLEMENTED`; `dom-backend.act` on a tab with no content script returns `Err('TARGET_MISSING')`, never throws |
| 3.7 | Implement `lib/page/actuator.ts` — the five pre-action checks and all six verbs | `actuator.spec.ts`: a disconnected node returns `TARGET_MISSING`; a modal-covered button returns `OBSCURED`; a disabled input returns `TARGET_DISABLED`; a password field returns `NEVER_TIER_AT_ACTUATOR` |
| 3.8 | Implement the native-value-setter type path and the full pointer click sequence | On `fixtures/react-form.html` (a controlled React input), `type` lands and survives a re-render; on `fixtures/custom-button.html` (a `<div>` listening only for `pointerdown`), `click` fires its handler; on `fixtures/quill.html`, `type` into the editor lands |
| 3.9 | Implement navigation verbs from the service worker | `navigate` to an ungranted origin returns `OUT_OF_SCOPE` and the tab does not move; `history_back` returns to the previous URL and verifies `location` |
| 3.10 | Implement `lib/page/verifier.ts` with all six deterministic kinds | `verifier.spec.ts`: each kind confirms on its happy path and fails on its unhappy path; an unsettled snapshot downgrades `confirmed` to `unconfirmed`; the negative check fires on a `role=alert` appearing inside the target's form and does **not** fire on one elsewhere |
| 3.11 | Implement `lib/agent/journal.ts` | `journal.spec.ts`: `seq` is gapless and monotonic under 100 concurrent appends; a write takes ≤ 10 ms p95; `runEvents` is writable through no other module (asserted by an import check) |
| 3.12 | Implement the approval flow with the four-part prompt | `approval-copy.spec.ts`: every generated prompt contains the target name and the hostname; no prompt string in the repository is generic; an approval token for request A is refused for request B |
| 3.13 | Implement stop: session flag, gate check 7, actuator pre-check | `stop.spec.ts`: pressing stop during a slow action produces zero further `action.dispatched`; the flag is gate-visible within 250 ms; the run reaches `stopped` |
| 3.14 | Build the Copilot panel and the deterministic intent resolver | *"click Continue"* on a fixture executes and reports `confirmed`; *"click Submit application"* holds for approval showing the target and hostname; two matching elements render a chooser rather than acting; unmatched text lists the available capabilities |
| 3.15 | Widen `DEFAULT_CAPABILITIES` to the eleven implemented verbs | `scope.spec.ts` asserts the exact set; a `click` on an origin whose policy omits `click` returns `CAPABILITY_NOT_GRANTED` |
| 3.16 | Hard-gate e2e specs | `scope.spec.ts` (SC-3): zero actions on a non-granted origin. `never-tier.spec.ts` (SC-2): zero reads or writes on password/payment/OTP across the corpus. `false-confirm.spec.ts`: a swallowed submit never yields `confirmed` |
| 3.17 | Performance validation | Cold-SW-wake → gate decision ≤ 300 ms p95; action → verified outcome ≤ 1.5 s p95 on the deterministic path; journal write ≤ 10 ms p95 |

---

## 13. Milestone Definition

Phase 3 is **complete** when:

> A user grants `https://practice.example.org`, opens the Copilot panel, and types *"type Mohd Taha into the full name field"*. The panel shows five lines appear in under a second: **requested** `type e12 "Mohd Taha"`, **permitted** *Low tier*, **acted** *dispatched in 8 ms*, **settled** *after 218 ms*, **confirmed** *state check: field now reads "Mohd Taha"*. They look at the page: the field is filled, and it stays filled when the React form re-renders on the next keystroke elsewhere — because the extension wrote through the native value setter, not through the framework's. They type *"click Submit application"*. Nothing happens to the page. Instead the panel shows: **Click "Submit application" — on practice.example.org — I think this submits the form. It is likely irreversible and visible to the site's owner.** with Approve and Reject. They press Reject; the journal records `approval.denied` and the page is untouched. They type *"type hunter2 into the password field"*. The panel answers **I don't have a way to perform that** — because the password field has no handle, was never in the snapshot, and the resolver could not name it even if it wanted to. They open a second tab on a site they have *not* granted, select it, and type *"click Continue"*: **OUT_OF_SCOPE — Pro Prompt isn't allowed on shop.example.net.** They start a slow action on a deliberately laggy fixture and press **Stop** mid-flight: the panel freezes at *acted*, the run shows `stopped`, and no further event is ever written. They open the run's journal in the dashboard and read eleven rows in sequence, each with a timestamp, and every one of the outcomes above accounted for. There is still no planner and no plan — the user named every action themselves. But every one of them was classified, permitted or refused, performed, observed, and recorded.

---

## 14. Files to Create

```
lib/
├── policy/
│   ├── gate.ts              # [new] the eight ordered checks
│   ├── ownership.ts         # [new] the session-backed handle ledger
│   ├── tiers.ts             # [new] verb × target × origin → tier
│   ├── never-rules.ts       # [new] sensitive kinds and origins; no override path
│   ├── scope.ts             # [modify] capability set widened
│   ├── goal-anchor.ts       # [new, stub]      — Phase 5
│   └── suspicion.ts         # [new, stub]      — Phase 6
├── actuation/
│   ├── backend.ts           # [new] ActuationBackend, ActEffect
│   ├── dom-backend.ts       # [new] default backend
│   └── cdp-backend.ts       # [new, stub throwing NOT_IMPLEMENTED] — Phase 9
├── page/
│   ├── actuator.ts          # [new] pre-checks + six verbs
│   └── verifier.ts          # [new] six deterministic kinds
├── agent/
│   ├── run-state.ts         # [new] transition table + canAct
│   ├── journal.ts           # [new] the only writer of runEvents
│   └── intent.ts            # [new, THROWAWAY — deleted in Phase 5]
├── schemas/action.schema.ts # [fill]
└── types/agent.types.ts     # [fill] Verb, Tier, RefusalCode, FailureCause, ActionOutcome
entrypoints/
├── background.ts            # [modify] gate hosting, actuation dispatch, approval queue
├── agent.content.ts         # [modify] ACTUATE handler
└── options/App.tsx          # [modify] Copilot panel + run journal view
tests/
├── unit/{action-schema,run-state,ownership,tiers,never-rules,gate,actuator,
│         verifier,journal,approval-copy}.spec.ts
└── e2e/{scope,never-tier,stop,false-confirm}.spec.ts
    fixtures/{react-form.html, custom-button.html, quill.html, modal-cover.html,
              swallowed-submit.html, slow-settle.html}
```

---

## 15. Performance Validation

| Metric | How to Measure | Target |
|---|---|---|
| Cold SW wake → gate decision | Terminate the worker, then time a gate call, 30 samples | ≤ 300 ms p95 (§3.8) |
| Action → verified outcome, deterministic path | `copilot.bench.ts` over 40 fixture actions | ≤ 1.5 s p95 |
| Journal write | 100 appends, timed | ≤ 10 ms p95 |
| Stop flag visible to the gate | `stop.spec.ts`, press to first refusal | ≤ 250 ms |
| Actions after stop | `stop.spec.ts` | **0** — hard gate |
| Never-tier field access | `never-tier.spec.ts` over the corpus | **0** reads, **0** writes, **0** message appearances — hard gate |
| Actions on a non-granted origin | `scope.spec.ts` | **0** — hard gate |
| False confirmation on Always-tier | `false-confirm.spec.ts` | **0** — hard gate |
| Content-script bundle | CI gzip check | ≤ 80 KB (actuator + verifier added to Phase 2's ~52 KB) |

---

## 16. Estimated Complexity

| Component | New LOC | Files |
|---|---|---|
| `gate.ts` + `ownership.ts` | ~340 | 2 |
| `tiers.ts` + `never-rules.ts` | ~230 | 2 |
| `run-state.ts` | ~90 | 1 |
| `backend.ts` + `dom-backend.ts` + cdp stub | ~180 | 3 |
| `actuator.ts` | ~380 | 1 |
| `verifier.ts` | ~340 | 1 |
| `journal.ts` | ~80 | 1 |
| `action.schema.ts` + `agent.types.ts` | ~230 | 2 |
| `intent.ts` (throwaway) | ~160 | 1 |
| Copilot panel + journal view | ~420 | 1 |
| Unit suites | ~1,150 | 10 |
| e2e specs + fixtures | ~560 | 10 |
| **Total** | **~4,160** | **35** |

New runtime dependencies: **0**.

---

## 17. Forward Dependencies Declared Here

- Gate check positions **5.5 (goal anchor)** and **6.5 (budget)** are reserved with comments. **[Phase 5 fills both.]**
- `goal-anchor.ts` and `suspicion.ts` are stubs returning `allow`. **[Phase 5 and Phase 6 respectively.]**
- `cdp-backend.ts` throws `NOT_IMPLEMENTED`. **[Phase 9.]** `RunRecord.backend` accepts only `'dom'` until then.
- Seven verbs are schema-declared and gate-refused `NOT_YET_IMPLEMENTED`. **[`look_at` Phase 10; `open_tab` Phase 7; `summarise`/`transform`/`refactor`/`generate` Phase 8; `ask_user`/`finish` Phase 5.]**
- `semantic` and `traceability` verification return `unconfirmed`. **[Phase 4 supplies the judge tier.]**
- `FailureCause` values are *produced* and journaled; **nothing responds to them**. Recovery is Phase 6. In this phase a failed action reports and stops.
- `lib/agent/intent.ts` is throwaway. **[Phase 5 deletes it and replaces it with `planner.ts` + `step-resolver.ts`.]**
- `ownership.record()` is called with `tabId` from a roster of one. **[Phase 7 exercises the cross-tab refusal path; `ownership.spec.ts` already tests it against a synthetic two-tab ledger so the code is correct before it is used.]**
