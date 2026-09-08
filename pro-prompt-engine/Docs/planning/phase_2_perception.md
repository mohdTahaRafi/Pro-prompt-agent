# Phase 2 — Perception

**Document type:** Phase 2 execution document
**Architecture basis:** `architecture.md` §3.3.2b (`PerceptionSnapshot`), §3.7.2 (opaque handles), §3.7.3 (settling), §3.7.6 (typed observation), §3.7.21 (structure-aware pruning), §3.8, §3.11 Q1/Q3/Q10
**PRD basis:** PR-PERC-1…7, PR-ACT-5, PR-SEC-10/11, C-3, C-4, OQ-4
**Depends on:** Phase 1 only — per-origin grants, `lib/page/sensitive.ts`, Zod 4, Vitest, Playwright, the capture harness

---

## 1. Objective

At the end of this phase the extension can **look at a granted page and describe it in a form a model can reason about and a gate can enforce over**. `agent.content.ts` exists, is registered per grant, and answers three perception requests: `read_structure`, `read_element` and `wait_for_settle`. It builds a `PerceptionSnapshot` — an epoch-stamped list of `ElementDescriptor`s with opaque handles, accessible names computed the way a screen reader computes them, open shadow roots traversed, per-region completeness reported, and every password / payment / OTP field excluded before its value is ever read. A settle detector reports when the page has stopped changing, and says so honestly when it never does. Pruning is enforced by a real BPE token budget and is structure-aware: it never truncates inside the form under work and never half-lists a repeating block.

The phase closes with the **planner bake-off** (Q1): candidate planner models scored on target selection and plan quality against the fixture and capture snapshots this phase produces. That decides Phase 4's default planner and its runner-up.

**By the end of this phase:** a user grants a site, opens the debug panel, presses *Read this page*, and sees a table of handles — `e0 button "Search"`, `e12 textbox "Full name" (empty)`, `e30 button "Submit application"` — alongside `settled: true after 412 ms`, a per-region completeness list showing the main form complete at 24 of 24 fields and a sidebar pruned at 6 of 41, and `excludedCount: 2`. The page's password field appears nowhere: not as a handle, not as a name, not as a value.

**No gate, no actuation, no verification, no planner, no runs, no model calls of any kind.** This phase reads and describes. Nothing in it can click, type, navigate, or decide. The bake-off at §10 calls models, but it is an offline harness run by a developer against saved snapshots — not a code path in the extension.

---

## 2. What this phase inherits and what it replaces

| Thing | State after Phase 1 | This phase |
|---|---|---|
| `entrypoints/content.ts` | Deleted | — |
| `entrypoints/agent.content.ts` | Does not exist | **Created.** The only content script the agent uses |
| `lib/page/sensitive.ts` | Built, tested against a fixture corpus | **Consumed unchanged.** Perception calls it before reading any value |
| `lib/schemas/snapshot.schema.ts` | Stub | **Filled** |
| `lib/policy/scope.ts` `DEFAULT_CAPABILITIES` | `[]` | Widened to the four perception verbs |
| `@mozilla/readability` | Present, used by the deleted `content.ts` | Rewired to the `read_page` verb only. It is the wrong tool for `read_structure` — it deliberately discards interactive chrome |
| `lib/ui/snippet-manager.ts` | Runs in a per-origin dynamic script | Moves inside `agent.content.ts`, sharing its shadow-root host and its `sensitive.ts` import |
| The debug panel | Does not exist | Created in the **options page**, not the side panel — the side panel arrives in Phase 5 and this phase must be demonstrable without it |

**Nothing in the current repository does any of this.** There is no `MutationObserver` anywhere in the source tree, no element model, no handle concept, and no accessible-name computation. `content.ts`'s `extractPageContent()` — Readability with a `textContent` fallback, capped at 15,000 characters — is the entire page model today, and it is exactly the model that cannot say "there is a button here and here is how to refer to it."

---

## 3. The content script

### 3.1 Registration and lifecycle

`agent.content.ts` is never in the manifest. It is registered by `scope.grantOrigin()` (Phase 1 §4.2) and unregistered on revoke. WXT builds it as an entrypoint with `registration: 'runtime'` so it is bundled and copied to `content-scripts/agent.js` without producing a `content_scripts` manifest entry.

```ts
// entrypoints/agent.content.ts
export default defineContentScript({
  registration: 'runtime',      // registered by chrome.scripting, never by the manifest
  matches: [],                  // required by the type; ignored for runtime registration
  runAt: 'document_idle',
  allFrames: false,             // §3.4
  main(ctx) {
    const registry  = new ElementRegistry();
    const settle    = new SettleDetector();
    const snippets  = new SnippetHost(ctx);   // the Phase 1 popover, rehomed

    chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
      const parsed = PerceptionRequest.safeParse(raw);
      if (!parsed.success) return false;      // not ours; let another listener answer
      handle(parsed.data, registry, settle).then(sendResponse);
      return true;
    });

    // Invalidate everything when the document itself changes underneath us.
    ctx.addEventListener(window, 'pagehide', () => registry.invalidateAll('PAGEHIDE'));
    ctx.onInvalidated(() => { settle.stop(); registry.invalidateAll('CTX_INVALIDATED'); });
  },
});
```

`ctx.onInvalidated` matters: when the extension is updated or reloaded, the old content script's `chrome.runtime` handle is dead but its listeners are still attached. Without the teardown, a stale script keeps a `MutationObserver` running on the page forever. WXT's `ctx` wrapper is the mechanism; using it is not optional.

### 3.2 `allFrames: false`, and what that costs

The script runs in the top frame only. A cross-origin iframe is unreachable by construction — the isolated world does not cross origins, and injecting into subframes would require the user to have granted each frame's origin separately.

The consequence is reported, never hidden: any `<iframe>` whose content document is inaccessible contributes an entry to `snapshot.unreachableRegions` as `iframe:<src-origin>` (or `iframe:opaque` for `srcdoc` and sandboxed frames). PR-PERC-2's "enough descriptive information to choose among them" is satisfied for what we can see; PRD §9.2's requirement that unreachable content be *reported* rather than treated as empty is satisfied by the array being non-empty and by the report reading "a payment section rendered in an embedded frame from `checkout.example.net` was not readable."

**Same-origin iframes are traversed**, because their `contentDocument` is reachable and they are common in ordinary applications (a settings pane, a rich-text editor). They share the top document's handle namespace, and each descriptor records its frame path so re-resolution knows where to look.

### 3.3 Message contract

```ts
// lib/schemas/snapshot.schema.ts   (excerpt — the request half)
export const PerceptionRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PERCEIVE_STRUCTURE'),
             runId: z.string(), region: z.string().optional(),
             tokenBudget: z.number().int().min(500).max(12_000).default(6_000) }),
  z.object({ type: z.literal('PERCEIVE_ELEMENT'), runId: z.string(), handle: HandleSchema }),
  z.object({ type: z.literal('PERCEIVE_PAGE'),    runId: z.string() }),
  z.object({ type: z.literal('WAIT_FOR_SETTLE'),  runId: z.string(),
             maxMs: z.number().int().min(100).max(15_000).optional() }),
]);

export const HandleSchema = z.string().regex(/^e[0-9]+$/);
```

`runId` is carried from the first request even though nothing uses it until Phase 3. It costs nothing now and means the gate's later checks do not require a message-shape change.

---

## 4. The Element Registry

### 4.1 What a handle is

An opaque string, `e<n>`, allocated by *this* content script, meaningful only inside *this* snapshot epoch, resolvable only through the registry that allocated it. The model never sees a selector, an XPath, or a DOM node id, and cannot construct a reference to an element the snapshot did not offer (§3.7.2).

```ts
// lib/page/registry.ts   [new] — content script only
interface RegistryEntry {
  handle: string;
  node: WeakRef<Element>;        // WeakRef: a detached node must not be kept alive by us
  descriptor: ResolutionDescriptor;
  epoch: number;
  frame: string;                 // '' for top, else 'f0>f2' — the same-origin frame path
}

/** Everything needed to find this element again after the DOM has changed. */
interface ResolutionDescriptor {
  role: string;                  // computed role, not the raw tag
  name: string;                  // accessible name, normalised
  tag: string;
  inputType?: string;
  formSignature?: string;        // hash of the enclosing form's id/name/action
  ordinalWithinName: number;     // 3rd element with role=button and name="Continue"
  domPath: string;               // structural path, used ONLY as a tie-break, never alone
  textFingerprint?: string;      // first 40 chars of own text, for links and buttons
}
```

`WeakRef` rather than a direct reference is deliberate: a snapshot of a large page holds a few hundred entries, and a page that replaces its content every few seconds would otherwise leak every version of every node into the registry until the run ended. `deref()` returning `undefined` is a normal, expected outcome and is exactly the `TARGET_MISSING` signal (§3.3.2d) the recovery table wants.

### 4.2 Epochs

```ts
class ElementRegistry {
  private epoch = 0;
  private entries = new Map<string, RegistryEntry>();
  private nextIndex = 0;

  /** Called at the start of every structure read. Old handles become stale, not invalid. */
  beginEpoch(): number {
    this.epoch += 1;
    this.nextIndex = 0;
    // Entries from the previous epoch are RETAINED, not cleared. A stale handle
    // must produce descriptor re-resolution (§4.3), not an unknown-handle error —
    // those are different failures and the report must distinguish them.
    return this.epoch;
  }

  allocate(node: Element, descriptor: ResolutionDescriptor, frame: string): string {
    const handle = `e${this.nextIndex++}`;
    this.entries.set(`${this.epoch}:${handle}`, {
      handle, node: new WeakRef(node), descriptor, epoch: this.epoch, frame,
    });
    return handle;
  }
}
```

Retention is bounded at **three epochs**. On `beginEpoch`, entries older than `epoch - 2` are dropped. Three because a recovery sequence can legitimately reach two epochs back (act → fail → re-snapshot → re-resolve against the pre-failure epoch), and anything older is a bug rather than a recovery.

### 4.3 Resolution and re-resolution

```ts
type Resolution =
  | { kind: 'exact';      node: Element }                    // same epoch, node still connected
  | { kind: 'reresolved'; node: Element; confidence: number }// found by descriptor
  | { kind: 'ambiguous';  candidates: Element[] }            // >1 match — STOP AND ASK
  | { kind: 'missing' };                                     // nothing matched

resolve(handle: string, epoch: number): Resolution {
  const entry = this.entries.get(`${epoch}:${handle}`);
  if (!entry) return { kind: 'missing' };

  const live = entry.node.deref();
  if (live && live.isConnected) return { kind: 'exact', node: live };

  return this.reresolve(entry.descriptor, entry.frame);
}

/**
 * Descriptor re-resolution. Deliberately ordered from most to least trustworthy,
 * and deliberately refuses to guess when more than one candidate survives.
 */
private reresolve(d: ResolutionDescriptor, frame: string): Resolution {
  const doc = this.documentForFrame(frame);
  if (!doc) return { kind: 'missing' };

  // 1. Every element whose computed role matches. Role is the most stable
  //    property across a re-render; class names and ids are the least.
  let pool = Array.from(doc.querySelectorAll<Element>('*'))
    .filter(el => computeRole(el) === d.role);

  // 2. Exact accessible name. Normalised the same way it was when captured.
  const byName = pool.filter(el => accessibleName(el) === d.name);
  if (byName.length === 1) return { kind: 'reresolved', node: byName[0], confidence: 1.0 };
  if (byName.length > 1) pool = byName; else if (byName.length === 0 && d.name) {
    // 2b. The name changed. Fall back to the text fingerprint for links/buttons,
    //     which survives an aria-label edit that a name match would not.
    const byText = pool.filter(el =>
      d.textFingerprint && ownText(el).slice(0, 40) === d.textFingerprint);
    if (byText.length === 1) return { kind: 'reresolved', node: byText[0], confidence: 0.7 };
    if (byText.length === 0) return { kind: 'missing' };
    pool = byText;
  }

  // 3. Same enclosing form. Two "Continue" buttons in different forms are
  //    different buttons, and the form is usually the stable one.
  if (d.formSignature) {
    const sameForm = pool.filter(el => formSignature(el.closest('form')) === d.formSignature);
    if (sameForm.length === 1) return { kind: 'reresolved', node: sameForm[0], confidence: 0.9 };
    if (sameForm.length > 0) pool = sameForm;
  }

  // 4. Ordinal among identically-named siblings. This is the LAST discriminator
  //    and it is only trusted when the pool size matches what we saw before —
  //    if the page now has four "Continue" buttons where it had two, position
  //    means nothing.
  if (pool.length > d.ordinalWithinName && pool.length === d.poolSizeWhenCaptured) {
    return { kind: 'reresolved', node: pool[d.ordinalWithinName], confidence: 0.6 };
  }

  if (pool.length === 0) return { kind: 'missing' };
  if (pool.length === 1) return { kind: 'reresolved', node: pool[0], confidence: 0.5 };
  return { kind: 'ambiguous', candidates: pool.slice(0, 4) };   // 4: enough for a
                                                                // Phase 10 look_at grid
}
```

**`domPath` is not used as a discriminator.** It is recorded because it is useful in the journal for a human debugging a failure, but a structural path is the first thing a re-render breaks, and trusting it would produce confident wrong resolutions — the exact R-2 failure. It is stored, never matched on.

**`ambiguous` is a first-class outcome, not an error.** §3.7.2 is explicit that the two-identical-buttons case is *converted* from a silent wrong action into an explicit question, not solved. The registry returns `ambiguous` and the caller — the Tab Agent, from Phase 5 — maps it to `TARGET_AMBIGUOUS`, which the recovery table (§3.3.2d) answers with **stop the step and ask**. Phase 10 adds one alternative: a cropped image of each candidate. Neither is available in this phase; here the registry simply reports the shape honestly.

**Q10 — SPA route changes.** A route change that swaps content without a URL change is precisely where a stale handle could re-resolve onto a *different* element with an identical descriptor. Two mitigations ship in this phase and the question stays open into the bake-off:

1. The settle detector counts mutations. A burst above `EPOCH_INVALIDATION_MUTATIONS = 400` **within one settle window** marks the current epoch `suspect`. A `resolve()` against a suspect epoch never returns `exact` — it always re-resolves, so a `WeakRef` that happens to still be connected does not shortcut the check.
2. Every re-resolution below `confidence: 0.9` is journaled with its confidence and the descriptor that produced it, so the Phase 6 report can say *"this step's target was re-identified with medium confidence."*

If measurement in this phase shows re-resolution landing on wrong elements after route changes, the declared fallback is to invalidate all handles on any burst above the threshold and pay for an extra snapshot — costing ~120 ms, which the budget can absorb (§3.8).

---

## 5. Accessible names and roles

The single highest-leverage thing perception does is produce a name a human would recognise. `name: "Submit application"` is what makes the plan readable, the approval request specific (PR-APR-3/4), and the report honest. Getting it wrong produces `button "e30"` or `button ""`, which makes everything downstream worse.

### 5.1 Name computation

A pragmatic subset of the ACCNAME specification, in precedence order. Implemented in `lib/page/accname.ts`, ~200 lines, no dependency.

| # | Source | Notes |
|---|---|---|
| 1 | `aria-labelledby` | Resolve every id, concatenate their *rendered* text with single spaces, skipping ids that do not exist. Recursion depth capped at 1 — an `aria-labelledby` chain deeper than that is malformed and the cap prevents a cycle hanging the page |
| 2 | `aria-label` | Trimmed. Empty after trim falls through rather than winning |
| 3 | Native host-language label | `<label for>`, then an ancestor `<label>`; for `<input type=button\|submit\|reset>` the `value`; for `<img>` the `alt`; for `<fieldset>` the `<legend>`; for `<table>` the `<caption>` |
| 4 | Subtree text | For elements whose role permits name-from-content (button, link, heading, cell, menuitem, option, tab, and the rest of the ARIA "name from author and content" set). Traverses open shadow roots and `::before`/`::after` content, skips `aria-hidden="true"` subtrees and `display:none` |
| 5 | `title` | The last resort ARIA specifies |
| 6 | `placeholder` | **Not in ACCNAME's list for most roles, and included anyway** — a placeholder-only field with no label is extremely common and defensible markup is not the world we perceive. Recorded in the descriptor as `nameSource: 'placeholder'` so the planner can weigh it lower |

Then, always: collapse whitespace runs to one space, trim, and truncate to **120 characters** with an ellipsis. 120 because it is comfortably longer than any real control label and short enough that 150 descriptors cannot blow the token budget on names alone.

**Failure mode:** an element with no name from any source gets `name: ''` and `nameSource: 'none'`. It is *kept* in the snapshot rather than dropped — an unnamed interactive element is exactly the thing a user might need the agent to act on, and dropping it would make it inexpressible. The planner sees `{role:'button', name:'', ordinal:3}` and will usually have to ask. That is the correct outcome.

### 5.2 Role computation

`lib/page/roles.ts` maps element to computed role: explicit `role` attribute first (validated against the known ARIA role set — an invalid role is ignored, not passed through), then the implicit mapping (`button`, `a[href]→link`, `input[type]→textbox|checkbox|radio|button|searchbox|spinbutton|slider`, `select→combobox|listbox`, `textarea→textbox`, `summary→button`, and the landmark set), then `generic`.

An element with `role="generic"` or no role is included only if it is **behaviourally interactive**: it has a `click` handler attribute, a non-negative `tabindex`, `contenteditable`, or `cursor: pointer` in its computed style *and* it is a leaf-ish node (≤3 element children). The `cursor: pointer` heuristic catches the very common `<div onclick>` pattern that carries no ARIA at all; the leaf constraint keeps it from matching a whole card wrapper whose child is the real button.

---

## 6. The Settle Detector

### 6.1 Mechanism

```ts
// lib/page/settle.ts   [new]
const VISIBLE_QUIET_MS   = 400;    // §3.7.3
const VISIBLE_CAP_MS     = 8_000;
const HIDDEN_QUIET_MS    = 1_000;  // Chrome clamps hidden-tab timers; 400 ms is not
const HIDDEN_CAP_MS      = 15_000; //   measurable there. [Phase 7 calibrates — Q15]
const EPOCH_INVALIDATION_MUTATIONS = 400;

interface SettleResult {
  settled: boolean;
  waitedMs: number;
  calibration: 'visible' | 'hidden';   // recorded so the report can distinguish them
  mutations: number;
  resourceEntries: number;
  suspect: boolean;                    // mutations > EPOCH_INVALIDATION_MUTATIONS
}

class SettleDetector {
  async wait(maxMs?: number): Promise<SettleResult> {
    const hidden = document.visibilityState === 'hidden';
    const quiet = hidden ? HIDDEN_QUIET_MS : VISIBLE_QUIET_MS;
    const cap   = maxMs ?? (hidden ? HIDDEN_CAP_MS : VISIBLE_CAP_MS);
    const start = performance.now();

    let mutations = 0, resources = 0;
    let lastActivity = start;

    const mo = new MutationObserver((records) => {
      // Ignore mutations inside our own shadow host — the overlay's own
      // rendering must never count as page activity, or the page never settles.
      for (const r of records) {
        if (isOurs(r.target)) continue;
        mutations += 1;
        lastActivity = performance.now();
      }
    });
    mo.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true,
      // attributeFilter is deliberately NOT set: a disabled→enabled flip on a
      // submit button is an attribute change on an attribute we cannot enumerate
      // in advance, and it is exactly the change that matters.
    });

    const po = new PerformanceObserver((list) => {
      // Long-lived streams (SSE, websockets upgraded over HTTP) would otherwise
      // hold the page 'unsettled' forever. Only completed entries count.
      for (const e of list.getEntries()) {
        if ((e as PerformanceResourceTiming).responseEnd > 0) {
          resources += 1; lastActivity = performance.now();
        }
      }
    });
    po.observe({ type: 'resource', buffered: false });

    try {
      while (true) {
        const now = performance.now();
        if (now - lastActivity >= quiet) {
          return { settled: true, waitedMs: Math.round(now - start),
                   calibration: hidden ? 'hidden' : 'visible', mutations,
                   resourceEntries: resources,
                   suspect: mutations > EPOCH_INVALIDATION_MUTATIONS };
        }
        if (now - start >= cap) {
          return { settled: false, waitedMs: Math.round(now - start),
                   calibration: hidden ? 'hidden' : 'visible', mutations,
                   resourceEntries: resources,
                   suspect: mutations > EPOCH_INVALIDATION_MUTATIONS };
        }
        await sleep(50);          // 50 ms poll: 8 samples inside a 400 ms window,
      }                           // costing ~160 wakeups across an 8 s cap
    } finally { mo.disconnect(); po.disconnect(); }
  }
}
```

### 6.2 Every number, justified

| Constant | Value | Why this value |
|---|---|---|
| `VISIBLE_QUIET_MS` | 400 | Longer than a React commit + paint (16–100 ms) and longer than a same-origin XHR round trip on a fast connection (~150 ms), so a normal interaction's aftermath falls inside one window. Short enough that a 15-action run spends under 6 s total in settle waits |
| `VISIBLE_CAP_MS` | 8 000 | The point past which waiting longer stops being useful. A page still mutating after 8 s is either polling or animating, and neither will ever go quiet |
| `HIDDEN_QUIET_MS` | 1 000 | Chrome clamps hidden-tab timers: sub-100 ms becomes 500 ms, sub-1 s becomes 2 s. A 400 ms window is not *measurable* in a hidden tab. **Starting value only — Phase 7 calibrates (Q15)** |
| `HIDDEN_CAP_MS` | 15 000 | Proportionate to the wider quiet window; also survives the first tier of Chrome's intensive throttling |
| Poll interval | 50 ms | Fine enough that `waitedMs` is accurate to ±50 ms; coarse enough that the loop is ~160 wakeups at the cap rather than 8,000 |
| `EPOCH_INVALIDATION_MUTATIONS` | 400 | A settling form typically produces 5–50 mutations. 400 in one window is a route change or a full re-render, not an update. Chosen an order of magnitude above the normal case so it does not fire on ordinary activity |

### 6.3 Declared failure modes

- **A page that polls faster than the quiet window never settles.** The snapshot is returned anyway with `settled: false`, which the planner sees and the journal records. Any verification performed against such a snapshot is downgraded from `confirmed` to `unconfirmed` (Phase 3 §7). This is C-3 contained, not solved.
- **A page with a permanent animation** (a spinner, a marquee, a live clock) mutates continuously. Same handling. `mutations` in the result lets the report say *"the page was still changing when I read it (1,842 changes in 8 s), so I could not confirm this."*
- **A background tab under intensive throttling** — hidden more than five minutes — gets roughly one timer check per minute. The 15 s cap will be exceeded in wall-clock terms; the detector returns on the first check past the cap and reports the real `waitedMs`, which may be 60 s. Reporting the truth is the requirement; hitting the cap precisely is not.
- **`MutationObserver` and `PerformanceObserver` callbacks are not timer-throttled** and still fire on real events in a hidden tab. Only the quiet-window *measurement* stretches. This is what makes hidden-tab settling degraded rather than broken.

---

## 7. Building the snapshot

### 7.1 The walk

```ts
// lib/page/perception.ts   [new]
async function buildSnapshot(
  registry: ElementRegistry, settle: SettleDetector,
  opts: { runId: string; region?: string; tokenBudget: number },
): Promise<PerceptionSnapshot> {
  const settleResult = await settle.wait();
  const epoch = registry.beginEpoch();
  const t0 = performance.now();

  const candidates: Candidate[] = [];
  const unreachable: string[] = [];

  walk(document.documentElement, '', candidates, unreachable);

  // …classify, order, prune (§7.3–7.5), then serialise.
}

function walk(root: Element, frame: string, out: Candidate[], unreachable: string[]) {
  const it = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = it.currentNode as Element | null;
  while (node) {
    // 1. Open shadow roots are traversed. Closed ones are unreachable, by design.
    if (node.shadowRoot) walk(node.shadowRoot as unknown as Element, frame, out, unreachable);
    else if (isCustomElementWithClosedShadow(node)) {
      unreachable.push(`shadow:${node.localName}`);
    }

    // 2. Same-origin iframes share the namespace; cross-origin ones are reported.
    if (node instanceof HTMLIFrameElement) {
      const doc = sameOriginContentDocument(node);
      if (doc) walk(doc.documentElement, nextFramePath(frame), out, unreachable);
      else unreachable.push(`iframe:${originOf(node.src) ?? 'opaque'}`);
    }

    // 3. THE EXCLUSION, at the earliest possible point.
    //    classifySensitive() is called BEFORE any value is read. A sensitive
    //    field increments a counter and is never given a handle, never named,
    //    and its value never enters a variable (§3.9, PR-PRV-1, SC-2).
    const sensitive = classifySensitive(node);
    if (sensitive && sensitive !== 'file') { out.excludedCount++; node = it.nextNode() as Element; continue; }

    if (isInteractive(node) || isStructural(node)) out.push(makeCandidate(node, frame, sensitive));
    node = it.nextNode() as Element | null;
  }
}
```

**Why `file` is the one sensitive kind that stays.** A file input must be *visible* to the planner so the agent can report "this form needs a document you have to attach" (PR-ACT-8, J-1). It gets a descriptor with `inputType: 'file'` and `actionable: false`. The vocabulary has no `upload` verb (§3.3.2a), so the only thing the planner can do with it is name it in an `ask_user` with reason `MISSING_CAPABILITY`. It is described, never touched.

**Ordering of the exclusion check matters and is worth stating.** It runs before `isInteractive`, before name computation, and before any property read that could pull the value. A password field's `value` is never assigned to a local, never serialised, never journaled, and never crosses a message boundary — because the code path that would read it is never reached. That is what makes SC-2 a *structural* zero rather than a behavioural one.

### 7.2 Visibility and viewport

```ts
function visibilityOf(el: Element): { visible: boolean; inViewport: boolean } {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' ||
      style.visibility === 'collapse' || parseFloat(style.opacity) === 0) {
    return { visible: false, inViewport: false };
  }
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') {
    return { visible: false, inViewport: false };
  }
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { visible: false, inViewport: false };
  const inViewport = r.bottom > 0 && r.right > 0 &&
                     r.top < innerHeight && r.left < innerWidth;
  return { visible: true, inViewport };
}
```

`checkVisibility({checkOpacity: true, checkVisibilityCSS: true})` would be shorter, and is used where available with the manual path as fallback — Chrome 125+ has it, and the extension's floor is Chrome 114 for `sidePanel`.

**Hidden elements are kept, with `visible: false`.** Collapsed sections, elements behind a "Show more" toggle, and off-screen carousel items are exactly the content J-2 and J-4 need the agent to *notice* so it can scroll or expand rather than concluding absence (PR-PERC-5). Dropping them is how an agent silently reports a shortfall as a complete answer.

### 7.3 Regions

A region is the unit of completeness reporting, and it is derived from the page's own structure rather than invented:

| Priority | Region source | `regionId` |
|---|---|---|
| 1 | Each `<form>` | `form:<id or ordinal>` |
| 2 | Each ARIA landmark — `main`, `navigation`, `search`, `complementary`, `contentinfo`, `banner`, `region[aria-label]` | `landmark:<role>:<ordinal>` |
| 3 | Each repeating block: ≥3 sibling elements with the same tag and a structurally similar subtree (same child tag sequence to depth 2) | `repeat:<parent-path-hash>` |
| 4 | Everything else | `region:root` |

The repeating-block detector is what makes `count` verification possible in Phase 3 and what J-2 depends on. Its similarity test is deliberately structural rather than class-based: a product grid where every card has a slightly different class set still matches on `<article><img><h3><span><span>`.

```ts
interface RegionCompleteness {
  regionId: string;
  label: string;          // "Application form", "Search results", "Site navigation"
  complete: boolean;
  shown: number; total: number;
}
```

`label` is human-readable and goes straight into the cockpit and the report. It comes from the form's accessible name, the landmark's `aria-label`, or a generated description of the repeat (`"a list of 24 similar items"`).

### 7.4 Ordering

Before pruning, candidates are ordered so that pruning drops the least useful things first:

1. Every element inside the **target region**, if `opts.region` was given, or inside the form containing the currently focused element if not.
2. Interactive elements **in the viewport**, in document order.
3. Interactive elements **outside the viewport**, in document order.
4. Non-interactive structural elements (headings, landmarks, table headers) that give the planner orientation.
5. Elements marked `visible: false`.

Viewport-first with form-scoped expansion is the starting strategy and needs no study to justify — it matches where a human's attention is and where the current step is working. **What needs evidence is its behaviour on genuinely large and dynamic pages, and that is this phase's exit criterion (Q3, §10.2).**

### 7.5 Structure-aware pruning

The enforced limit is the **6,000-token observation budget**, measured with real BPE counts via the existing `gpt-tokenizer` (§3.7.21). The ~120-element figure from earlier drafts is advisory ordering guidance, not a cap.

```ts
function prune(ordered: Candidate[], budget: number): {
  kept: Candidate[]; regions: RegionCompleteness[];
} {
  const targetRegion = ordered[0]?.regionId;
  const kept: Candidate[] = [];
  let used = SNAPSHOT_ENVELOPE_TOKENS;      // 180: runId, url, title, settle fields

  for (const c of ordered) {
    const cost = countTokens(serialiseDescriptor(c));
    if (used + cost <= budget) { kept.push(c); used += cost; continue; }

    // RULE 1: never truncate inside the region the current step targets.
    // Dropping the second half of a long form is how the agent silently
    // fails to find the field it needs.
    if (c.regionId === targetRegion) { kept.push(c); used += cost; continue; }

    // RULE 2: never partially truncate a repeating block. A half-listed table
    // corrupts the `count` verification kind, turning a pruning decision into a
    // false verification result. Drop the WHOLE block or keep the whole block.
    if (c.regionId.startsWith('repeat:')) {
      const block = ordered.filter(x => x.regionId === c.regionId);
      const blockCost = block.reduce((s, x) => s + countTokens(serialiseDescriptor(x)), 0);
      if (used + blockCost <= budget) { kept.push(...block); used += blockCost; }
      markRegionDropped(c.regionId);        // whole block, or none of it
      continue;
    }
    markRegionPartial(c.regionId);
  }
  // RULE 3: report completeness PER REGION, never as one global boolean.
  return { kept, regions: buildRegionReport(ordered, kept) };
}
```

Rule 1 can push the snapshot over budget. That is intentional and bounded: a single form larger than 6,000 tokens is pathological, and the honest response is a snapshot that is 20 % over budget with the working form intact rather than one that is exactly on budget with half the form missing. The overshoot is recorded in the journal (`snapshot.overBudget: {by: 1240}`) so it is visible rather than silent, and a snapshot exceeding **12,000** tokens is refused outright with `PERCEPTION_TOO_LARGE`, which the planner receives as a reason to narrow with `read_structure {region}`.

`regions[]` replaces the single `truncated: boolean` of the first draft, and the change is not cosmetic. A global flag tells the planner *that* something was dropped but not *what* — precisely the pruning that can silently hide the element a task needs. Per-region completeness makes the gap addressable.

### 7.6 The output shape

```ts
// lib/schemas/snapshot.schema.ts — the response half, matching architecture §3.3.2b
export const ElementDescriptorSchema = z.object({
  handle: HandleSchema,
  role: z.string(),
  name: z.string().max(120),
  nameSource: z.enum(['labelledby','label','native','content','title','placeholder','none']),
  tag: z.string(),
  inputType: z.string().optional(),
  valueShape: z.union([z.literal('empty'), z.literal('filled'), z.string()]).optional(),
  enabled: z.boolean(), visible: z.boolean(), inViewport: z.boolean(),
  actionable: z.boolean(),          // false for file inputs and disabled controls
  href: z.string().optional(),      // links only; the gate's cross-origin link check
  sensitiveKind: z.enum(['file']).nullable(),  // the ONLY kind that survives the walk;
                                    // password/payment/otp are excluded and have no
                                    // descriptor at all. Carried so the gate can
                                    // re-check independently (Phase 3 §4.6)
  autocomplete: z.string().optional(),  // the raw attribute; Phase 8 matches facts on it
  formId: z.string().optional(),
  regionId: z.string(),
  ordinal: z.number().int(),
});

export const PerceptionSnapshotSchema = z.object({
  runId: z.string(), tabId: z.number(), epoch: z.number().int().positive(),
  url: z.string().url(), origin: OriginSchema, title: z.string().max(200),
  settled: z.boolean(), settleWaitedMs: z.number().int(),
  settleCalibration: z.enum(['visible','hidden']),
  epochSuspect: z.boolean(),
  elements: z.array(ElementDescriptorSchema),
  excludedCount: z.number().int().nonnegative(),
  regions: z.array(RegionCompletenessSchema),
  unreachableRegions: z.array(z.string()),
  buildMs: z.number().int(),
});
```

**`valueShape` and the literal-value rule.** For a field the classifier cleared, `valueShape` is the literal current value truncated to 60 characters — the planner genuinely needs to know that the "Full name" field already reads "Mohd Taha" to decide whether to overwrite it (a Medium-tier decision, §3.3.2a). For anything the classifier flagged, there is no descriptor at all, so the question does not arise. For a `<textarea>` over 60 characters, `valueShape` is `'filled'` plus the length: `filled:1284`. Sending 1,284 characters of a user's draft to a remote planner would be a Class B disclosure inside what was declared as Class A (§3.7.23), and that is not allowed.

---

## 8. `read_page` and Readability

`read_page` returns readable text and is a **disclosure class B** operation (§3.7.23). It keeps the existing Readability path from the deleted `content.ts`, with three changes:

1. The 15,000-character cap becomes a token cap measured the same way as the snapshot budget, defaulting to 4,000 tokens.
2. The result is tagged `{ class: 'B', origin, url, capturedAt }` so the Phase 4 router can refuse to send it remotely without local condensation.
3. The DOM-stripping fallback also removes our own shadow host, `[role=alert]` toasts, and cookie banners matched by a small selector list — not for cleanliness, but because a cookie banner's text at the top of every extraction wastes budget on every page.

Readability is deliberately **not** used for `read_structure`. It discards interactive chrome by design; that is what it is for. Using it for structure would produce a page model with no buttons in it.

---

## 9. The debug panel

The demonstrable artifact of this phase. A new **Perception** tab in `options/App.tsx` — not the side panel, which does not exist until Phase 5.

It offers: a granted-origin dropdown, buttons for *Read structure* / *Read element* / *Wait for settle* / *Read page*, and a rendering of the returned snapshot as (a) a sortable table of descriptors, (b) a region completeness list with `shown/total` bars, (c) the settle result with its calibration, (d) `excludedCount` and `unreachableRegions`, and (e) raw JSON with a copy button and a *Save as fixture* button that writes the snapshot into `tests/fixtures/snapshots/` for the bake-off.

That last button is why the panel is worth building rather than logging to the console: the bake-off needs a corpus of real snapshots, and hand-collecting them is the slow part.

---

## 10. Phase exit criteria

Two questions the architecture assigns to this phase's exit. Neither is a task with an acceptance criterion; both are studies that produce a written answer.

### 10.1 Q1 — the planner bake-off

**The question:** *which* planner-capable models are good enough at browser task planning, and how far apart are they? (Not *whether* a small in-browser model can plan — that is closed, in the negative, at §3.7.9.)

A bake-off needs a planner prompt and fixture snapshots. Both exist at the end of this phase — the snapshots from §9, and a first-draft planner prompt written here in `lib/agent/prompts.ts` for this purpose. It is a draft; Phase 4 owns the final one.

**Corpus:** 40 snapshots — 15 from hand-built fixtures, 15 from frozen captures (Phase 1's harness), 10 from live pages saved through the panel. Each carries a hand-written goal and a hand-labelled **gold answer**: for target selection, the correct handle; for plan quality, the ordered set of steps a competent person would list.

**Candidates:** Ollama `qwen2.5:7b-instruct`, `qwen2.5:14b-instruct`, `llama3.1:8b-instruct`, `mistral-nemo:12b`; remote `llama-3.3-70b-versatile` via Groq and one frontier model on a user key. Plus **one deliberate control**: a 1.5B in-browser model, included not as a candidate but to put a number on §3.7.9's rejection so it is evidenced rather than asserted.

**Metrics:**

| Metric | Definition |
|---|---|
| Target selection accuracy | Exact-handle match against gold, over 40 single-step tasks |
| Plan step precision / recall | Against the gold step set, judged by string-normalised step matching plus one human pass over disagreements |
| Schema validity, first attempt | Parses against `plan.schema.ts` with no repair |
| Hallucinated handles | Rate of handles not present in the snapshot. **Any non-zero rate is disqualifying for a default** |
| `willNotDo` quality | Does the model correctly state what it cannot do for this goal (PR-PLAN-2)? Scored by human review, 0–2 per task |
| Latency | p50/p95 per call |
| Cost | Tokens in/out; for remote, currency per plan |

**Output:** a table in `Docs/planning/bakeoff_phase2.md` naming **a default planner and a runner-up**, with the raw per-task results committed alongside. Not a permanent answer — a decision Phase 4 implements and later phases may revisit.

### 10.2 Q3 — pruning behaviour on large and dynamic pages

**The question:** does structure-aware pruning ever still hide a needed element?

**Method:** for each of the 40 corpus snapshots, the hand-labelled gold target handle is checked for presence in the pruned snapshot. A gold target that was pruned away is a **hard finding** — the pruning strategy failed at the only job that matters. The study also records, per snapshot: element count before and after, token count before and after, which regions were partially pruned, and whether the target region was ever truncated (Rule 1 says never; a violation is a bug, not a finding).

**Threshold for changing the design:** if any gold target is pruned, or if more than 10 % of snapshots exceed the 6,000-token budget through Rule 1 overshoot, the ordering strategy is revised in this phase before Phase 3 begins. Below that, the strategy stands and is revisited in Phase 9 with the AX tree — which gives **better names, not fewer nodes**, and should reduce `TARGET_AMBIGUOUS` rather than payload.

---

## 11. Tasks & Acceptance Criteria

| # | Task | Acceptance Criteria |
|---|---|---|
| 2.1 | Create `entrypoints/agent.content.ts` with runtime registration, Zod-validated message handling, and `ctx.onInvalidated` teardown | Granting an origin registers it; `PERCEIVE_STRUCTURE` returns a schema-valid response within 2 s; reloading the extension leaves zero live `MutationObserver`s on the page (asserted by a fixture that counts them) |
| 2.2 | Implement `lib/page/accname.ts` | `accname.spec.ts` passes 30 cases covering all six sources in §5.1 precedence order, an `aria-labelledby` cycle, and a name over 120 chars |
| 2.3 | Implement `lib/page/roles.ts` | `roles.spec.ts`: every native mapping in §5.2, an invalid explicit role ignored, `<div onclick>` with `cursor:pointer` classified interactive, a card wrapper with 8 children not |
| 2.4 | Implement `lib/page/registry.ts` — allocation, epochs, three-epoch retention | `registry.spec.ts`: handles are `e<n>` and unique per epoch; an entry from epoch N-3 is gone; `beginEpoch` does not clear epoch N-1 |
| 2.5 | Implement descriptor re-resolution with the five-step ladder | `registry.spec.ts`: a node replaced by an identical one re-resolves at confidence ≥ 0.9; two identical siblings return `ambiguous` with both candidates; a removed node returns `missing`; `domPath` never appears in a matching decision |
| 2.6 | Implement `lib/page/settle.ts` with both calibrations | `settle.spec.ts` under synthetic mutation streams: a 200 ms burst then quiet returns `settled:true` at ~600 ms; a 100 ms-interval poll returns `settled:false` at the 8 s cap; `document.visibilityState='hidden'` selects the 1,000/15,000 constants; 500 mutations set `suspect:true`; our own shadow-host mutations do not count |
| 2.7 | Implement `lib/page/perception.ts` — walk, shadow roots, same-origin iframes, unreachable reporting | On `fixtures/nested.html` (open shadow root, closed shadow root, same-origin iframe, cross-origin iframe): elements from the open root and the same-origin frame appear with handles; `unreachableRegions` contains exactly `shadow:x-closed` and `iframe:https://other.example` |
| 2.8 | Wire `sensitive.ts` into the walk, before any value read | `perception.spec.ts` on `fixtures/sensitive-corpus.html`: `elements` contains no descriptor for any classified field; `excludedCount === 9`; a source-level assertion that no `.value` read occurs on a path reachable from a classified node |
| 2.9 | Implement region derivation including the repeating-block detector | `regions.spec.ts`: a page with 2 forms, 4 landmarks and a 24-item product grid yields 7 regions; the grid's `total` is 24; a 2-item list is *not* a repeat region |
| 2.10 | Implement ordering and structure-aware pruning | `pruning.spec.ts`: the target region is never partially pruned; a repeat block is dropped whole or kept whole, never split; `regions[]` reports `shown/total` for every pruned region; a 5,000-descriptor page returns under 6,000 tokens or records `overBudget` |
| 2.11 | Fill `lib/schemas/snapshot.schema.ts`; validate every snapshot before it crosses the boundary | An intentionally malformed snapshot is rejected at the content-script boundary with `INVALID_SNAPSHOT`, never partially delivered |
| 2.12 | Implement `read_page` with the class-B tag and the token cap | Returns `{class:'B', text, origin, url}`; text is ≤ 4,000 tokens; the extension's own shadow host contributes no text |
| 2.13 | Move `SnippetManager` inside `agent.content.ts`, sharing the shadow host | Typing `/dev` on a granted page still expands; `grep -rn 'snippet' entrypoints/agent.content.ts` shows one host element for both features |
| 2.14 | Build the Perception debug panel with *Save as fixture* | Reading a granted page renders the descriptor table, region bars, settle line, and exclusion count; *Save as fixture* writes a schema-valid JSON file |
| 2.15 | Widen `DEFAULT_CAPABILITIES` to the four perception verbs | `scope.spec.ts`: a fresh grant yields `['read_page','read_structure','read_element','wait_for_settle']` |
| 2.16 | Collect the 40-snapshot corpus with gold labels | `tests/fixtures/snapshots/` holds 40 files; `corpus.json` holds a goal and a gold answer for each; a schema check passes over all 40 |
| 2.17 | Run the planner bake-off | `Docs/planning/bakeoff_phase2.md` names a default and a runner-up with all seven metrics tabulated, the 1.5B control included, and the raw results committed |
| 2.18 | Run the pruning study | `bakeoff_phase2.md` §Q3 records gold-target survival per snapshot, states whether any was pruned, and records the decision taken |
| 2.19 | Performance validation | `perception.bench.ts` on a 2,000-node / 150-interactive-element page: snapshot build p95 ≤ 120 ms; serialised size p95 ≤ 96 KB; content-script bundle ≤ 80 KB gzipped, asserted in CI |

---

## 12. Milestone Definition

Phase 2 is **complete** when:

> A developer grants `https://www.gov.uk` in the popup, opens the dashboard's **Perception** tab, and presses *Read structure*. Within about 300 milliseconds a table fills with 87 rows: `e0 link "Skip to main content"`, `e14 combobox "Country of residence" (empty)`, `e31 button "Continue"`. Beside it, three region bars read *Application form — complete, 24 of 24*, *Site navigation — complete, 11 of 11*, and *Related content — pruned, 6 of 41*. A line reads *settled after 412 ms (visible calibration), 37 mutations, 4 resources*. Another reads *2 fields excluded as sensitive*. They open the page's own DevTools and confirm the two excluded fields are a password and a CVV — and then search the entire snapshot JSON for the string "password" and find nothing but the count. They scroll the page and press *Read structure* again: the epoch increments to 2, and the elements that were `inViewport: false` are now `true`. They collapse a section on the page, press *Read element* on a handle inside it, and get `visible: false` rather than an error — the element is still there, still addressable, and honestly described as hidden. They open `bakeoff_phase2.md` and read a table of six planner candidates scored on target-selection accuracy against 40 real snapshots, with `qwen2.5:14b-instruct` named as the default, a remote model as the runner-up, and the 1.5B control at 31 % accuracy with a 12 % hallucinated-handle rate — the number that turns §3.7.9's rejection from an argument into a measurement. Nothing on the page has been clicked, typed into, or changed. The extension can see, and only see.

---

## 13. Files to Create

```
pro-prompt-engine/
├── entrypoints/
│   ├── agent.content.ts            # [new] the only agent content script
│   └── options/App.tsx             # [modify] Perception debug tab
├── lib/
│   ├── page/
│   │   ├── registry.ts             # [new] handles, epochs, re-resolution
│   │   ├── perception.ts           # [new] the walk, regions, ordering, pruning
│   │   ├── settle.ts               # [new] quiet-window detector, both calibrations
│   │   ├── accname.ts              # [new] accessible name computation
│   │   ├── roles.ts                # [new] computed role mapping
│   │   ├── readable.ts             # [new] read_page over Readability, class-B tagged
│   │   ├── sensitive.ts            # [Phase 1, consumed unchanged]
│   │   └── overlay/mount.ts        # [new] shadow host shared by snippets and, later, the run badge
│   ├── schemas/snapshot.schema.ts  # [fill]
│   ├── types/agent.types.ts        # [modify] Verb union gains the four perception verbs
│   ├── policy/scope.ts             # [modify] DEFAULT_CAPABILITIES widened
│   ├── ui/snippet-manager.ts       # [modify] hosted by overlay/mount.ts
│   └── agent/prompts.ts            # [new, draft] planner prompt for the bake-off only
├── tests/
│   ├── unit/{accname,roles,registry,settle,perception,regions,pruning}.spec.ts
│   ├── bench/perception.bench.ts
│   ├── fixtures/snapshots/         # 40 corpus snapshots + corpus.json
│   └── e2e/fixtures/{nested.html, long-form.html, product-grid.html, polling.html}
├── Docs/planning/bakeoff_phase2.md # [new] Q1 + Q3 answers
└── tools/bakeoff.ts                # [new] offline harness; not shipped in the extension
```

---

## 14. Performance Validation

| Metric | How to Measure | Target |
|---|---|---|
| Snapshot build | `perception.bench.ts`, 2,000 nodes / 150 interactive, 50 runs | ≤ 120 ms p95 (§3.8) |
| Serialised snapshot size | `JSON.stringify(...).length` over the corpus | ≤ 96 KB p95 |
| Observation token budget | `countTokens` over the corpus | ≤ 6,000, except Rule-1 overshoot which must be < 10 % of snapshots |
| Content-script bundle | `gzip -c .output/chrome-mv3/content-scripts/agent.js \| wc -c` in CI | ≤ 80 KB gzipped — a hard CI check, because this is injected into every granted page |
| Settle accuracy | `settle.spec.ts` synthetic streams | `waitedMs` within ±60 ms of the expected quiet-window crossing |
| Region completeness reporting | Corpus check | 100 % of pruned regions appear in `regions[]` with `shown`/`total` |

---

## 15. Estimated Complexity

| Component | New LOC | Files |
|---|---|---|
| `agent.content.ts` | ~130 | 1 |
| `registry.ts` (allocation + the re-resolution ladder) | ~280 | 1 |
| `perception.ts` (walk, regions, ordering, pruning) | ~420 | 1 |
| `accname.ts` | ~200 | 1 |
| `roles.ts` | ~150 | 1 |
| `settle.ts` | ~130 | 1 |
| `readable.ts`, `overlay/mount.ts` | ~140 | 2 |
| `snapshot.schema.ts` | ~110 | 1 |
| Debug panel | ~260 | 1 |
| Unit suites | ~780 | 7 |
| Fixtures + bench | ~340 | 6 |
| Bake-off harness (offline) | ~300 | 1 |
| **Total** | **~3,240** | **24** |

New runtime dependencies: **0**. `MutationObserver`, `PerformanceObserver` and `TreeWalker` are platform APIs; `gpt-tokenizer` and `@mozilla/readability` are already present.

---

## 16. Forward Dependencies Declared Here

- `PerceptionSnapshot.runId` is carried and unused. **[Phase 3: the gate validates it.]**
- `ElementDescriptor.actionable` is computed and unread. **[Phase 3: the actuator refuses a non-actionable target.]**
- The registry's `ambiguous` resolution has no consumer. **[Phase 3 maps it to `TARGET_AMBIGUOUS`; Phase 6 gives it the ask-the-user response; Phase 10 adds the cropped-image alternative.]**
- `epochSuspect` is computed and unread. **[Phase 5: the Tab Agent forces a re-snapshot rather than trusting a suspect epoch.]**
- Hidden-tab settle constants are starting values. **[Phase 7 calibrates them — Q15.]**
- `unreachableRegions` entries of kind `iframe:*` and `shadow:*` are reported. **[Phase 9: the CDP backend's `Accessibility.getFullAXTree` pierces shadow DOM and frames, which shrinks this array; the array itself does not go away, because cross-origin iframes remain unreadable even over CDP without attaching to each target.]**
- `lib/agent/prompts.ts` exists as a bake-off draft. **[Phase 4 owns the shipped planner prompt and the three-segment untrusted frame of §3.7.6. Nothing in the extension imports this file in Phase 2.]**

---

## 17. Implementation Notes — deviations found and decided during the build

Per CLAUDE.md's execution discipline: where implementation revealed this doc's plan was wrong or in tension with itself, the decision taken is recorded here rather than left to drift silently between spec and code.

1. **§7.5 vs §14 — `gpt-tokenizer` cannot live in the content script.** §7.5's pseudocode calls `countTokens()` from `gpt-tokenizer` directly inside the walk's prune loop; §14 hard-caps the *injected* content-script bundle at 80 KB gzipped specifically because it runs on every granted page. Measured fact: `gpt-tokenizer`'s BPE rank tables alone gzip to several hundred KB–2 MB, and WXT builds content scripts as a single IIFE (`formats: ['iife']`) with no chunk-splitting available even via dynamic `import()` — there is no way to keep the real encoder out of the bundle while still calling it from there. **Decision:** `lib/page/token-budget.ts` implements the content script's live pruning-budget arithmetic as a calibrated, deliberately conservative character-based estimate (3.2 chars/token — smaller than the common ~4 chars/token prose average, so it over-counts rather than under-counts), mirroring the same false-positive-safe/false-negative-unsafe asymmetry `sensitive.ts` already uses. The snapshot schema carries no field asserting an exact BPE-true token total (only `overBudget: {by}` when Rule 1 forces an overshoot), so nothing downstream depends on this being BPE-exact — the real `gpt-tokenizer` (`lib/utils/token-counter.ts`) still does authoritative counting in every context that isn't bundle-size-constrained (the pruning study, `tools/*.ts`), and Phase 4's router remains the actual cost/safety backstop before any token leaves the device. Verified: the built content script is 151 KB raw / **44.8 KB gzipped**, comfortably under budget.

2. **§13's file-tree table lists the `Verb` union widening under `lib/types/agent.types.ts`.** That file is a Phase 3 stub (gate/tier/actuation types) with no `Verb` export in this repository; the real `Verb` type — the one `lib/policy/scope.ts`'s `DEFAULT_CAPABILITIES: Verb[]` already imports — was created in Phase 1 at `lib/schemas/action.schema.ts`. Widened there instead (`PerceptionVerb` union), which keeps every existing import working; `agent.types.ts` is untouched until Phase 3.

3. **A real pruning bug found by the acceptance-criteria tests themselves, fixed:** the original `prune()` re-derived "the target region" by reading `ordered[0]?.regionId` rather than being told explicitly what the actual target was. On a page with no requested `region` and no focused form, this treated whichever region happened to sort first as sacred under Rule 1 — silently disabling pruning entirely on flat pages with no forms/landmarks. Fixed by having `orderCandidates()` return its resolved target (or `undefined` when there genuinely is none) explicitly, rather than letting `prune()` guess. Covered by `pruning.spec.ts`'s "a 5,000-descriptor page returns under 6,000 tokens" case, which caught the bug.

4. **A real region-derivation bug found the same way, fixed:** `role="form"` is *also* a landmark role under ARIA, so the landmark-scanning loop was double-counting every `<form>` on the page as an extra landmark region on top of its dedicated priority-1 form region. §7.3's own landmark-role list (main, navigation, search, complementary, contentinfo, banner, region[aria-label]) implicitly excludes `form` for exactly this reason; the code now says so explicitly and skips it. Caught by `regions.spec.ts`'s task 2.9 acceptance test.

5. **§10.1's corpus composition (15 hand-built / 15 frozen-capture / 10 live-panel) was not achievable in the environment available at the time** — no GUI Chrome to drive the debug panel through, and the repo's capture harness holds exactly one frozen capture, which itself hung indefinitely inside `buildSnapshot()` under the offline harness's happy-dom environment (isolated to something the real page's content triggers, not reproduced further). All 40 corpus entries were hand-built instead as a disclosed interim substitution — see `tools/build-corpus.ts`'s header comment for the full account. Every snapshot was still produced by the real, unmodified `buildSnapshot()` pipeline; nothing was hand-typed JSON. **Superseded by items 8 and 9 below**, once a real dev machine became available: the corpus is now genuinely 15 hand-built / 15 frozen-capture / 10 live-panel, all 40 entries real snapshots from the real pipeline (25 of them from a real browser, not happy-dom).

6. **§10.1's bake-off ran against a reduced candidate set and (by default) a reduced task count**, both disclosed rather than papered over — see `Docs/planning/bakeoff_phase2.md`'s own coverage section for exactly what ran, what didn't, and why (no Groq/frontier API key in this environment; CPU-only local Ollama inference, `size_vram: 0`). `llama3:latest` (8B) was measured to genuinely exceed the harness's 120 s per-call timeout on this hardware — prompt-eval alone took ~18 s for a 729-token prompt at ~40 tok/s prefill, and an 8B model's full-prompt eval for a realistic snapshot exceeds the timeout outright — so it is excluded from the scored run (`BAKEOFF_SKIP`) rather than left to silently fail every task. The report explicitly declines to name a shipped default/runner-up on this evidence — that decision needs the full candidate roster measured on real hardware. **Superseded by item 11 below**, once the corpus items 8 and 9 produced was actually scored.

7. **A real safety gap found by code review, fixed:** `agent.content.ts`'s `PERCEIVE_ELEMENT` handler built its response descriptor without re-applying `classifySensitive()` after re-resolution. The walk (§7.1) excludes a sensitive field before it is ever handed a handle, so the normal path is safe by construction — but the five-step re-resolution ladder (§4.3) can legitimately land on a *different* live node than the one the handle was originally allocated for (a page that swapped a benign field for a password field at the same position since the snapshot). Without the re-check, that node would have been described — name, role, actionable — with the wrong (`null`) `sensitiveKind`, rather than refused. Fixed: `isSafeToDescribe()` is checked immediately after resolution, before `describeElement()` reads anything else, for both the exact/reresolved and the ambiguous-candidates paths; a node that fails it is reported exactly like `TARGET_MISSING`.

8. **A real dev machine became available and produced the 25 real corpus entries §10.1 always specified**, closing the gap item 5 recorded. `tools/collect-real-fixtures.ts` drives Playwright + the real, unmodified extension through 25 real public pages (`tools/corpus-targets.ts`) in real Chromium, saving each one's genuine `PERCEIVE_STRUCTURE` response. Two real product bugs were found and fixed along the way, not merely worked around:
   - **`grantOrigin()` (`lib/policy/scope.ts`) was not idempotent.** Re-granting an already-granted origin (all 15 frozen-capture targets share one localhost origin) threw on duplicate `chrome.scripting.registerContentScripts` id registration, and the catch path rolled back an otherwise-valid permission grant — a real user re-granting a site they'd already granted would hit the identical bug, not just this harness. Fixed by checking `getRegisteredContentScripts({ids:[scriptId]})` before registering and skipping registration (treating it as success) if the script id is already present. Covered by a new regression test in `tests/unit/scope.spec.ts` ("grant is idempotent — re-granting an already-set-up origin succeeds without re-registering").
   - **The collection script itself orphaned its own capture server across both signalled and normal exits**, because `npx tsx` (and even bare `tsx`) spawns its own grandchild node process, so killing only the immediate child left the server (and port 5600) alive after the script exited. Fixed by spawning `tsx` directly with `detached: true` and killing the whole process group (`process.kill(-pid, 'SIGKILL')`) on exit, `SIGTERM`, and `SIGINT`, plus a `fuser -k` pre-cleanup and a real HTTP-reachability poll at startup instead of a blind `sleep`.

   Two of the 30 originally-planned real targets were swapped for confirmed-broken ones rather than left in with a bad result papered over: `Special:CreateAccount` genuinely 302-redirects Wikipedia's SUL3 auth flow to a different origin (`auth.wikimedia.org`) than the one granted, confirmed with `curl -L` before swapping — replaced with the same-origin `forgot_password` form on `the-internet.herokuapp.com`. `nested_frames` was collected successfully (schema-valid, `elements: []`) but is a **correct read of a genuinely empty page**, not a perception bug — confirmed via `curl` that the top-level frameset has no `<title>`, its leaf frames are bare text with no interactive elements, and one of its own frames now 200s to Heroku's own "Application Error" page upstream — so it was swapped for `/iframe`, a real same-origin iframe containing a live TinyMCE rich-text editor, which actually has interactive content to reason about. Both swaps are documented inline in `tools/corpus-targets.ts`.

9. **A real composition-ratio bug: this phase's own corpus build inverted §10.1's split**, and was caught and fixed before Phase 3 rather than shipped. §10.1 (§10.1 above, unchanged) specifies **15 hand-built / 15 frozen-capture / 10 live-panel**; `tools/build-corpus.ts` and `tools/corpus-targets.ts` were instead built to **10 hand-built / 15 frozen-capture / 15 live-panel** — the hand-built and live-panel counts transposed — and every comment describing the split (in `corpus-schema.ts`, `assemble-corpus.ts`, `collect-real-fixtures.ts`, `wxt.config.ts`) repeated the same inverted count, so nothing caught it by cross-checking the code against itself. Caught by re-reading §10.1's actual sentence against the built corpus before treating the corpus as finished. Fixed by restoring 5 of `build-corpus.ts`'s archived hand-built pages back into `KEEP_IDS` (one whole category that had been dropped entirely — `nav-page-1`, landmark-nav-link targeting — plus one more instance each of `product-grid`, `duplicate-buttons`, `sensitive-login` and `two-forms`, exercising those categories' `goldFor()` logic against a second concrete DOM instance) and dropping 5 of `corpus-targets.ts`'s 15 live-panel targets down to 10, keeping the 10 most structurally distinct from what `FROZEN_CAPTURE_TARGETS` already covers (dropping `wikipedia-machine-learning`, `python-docs-glossary`, `hn-newest`, `govuk-browse-benefits`, `python-org-home` — each redundant with a frozen-capture entry on the same site). `tools/assemble-corpus.ts`'s own split check (`counts['hand-built'] !== 15 || ...`) now enforces the corrected numbers mechanically, not just in a comment.

10. **`bakeoff.ts` lost an entire candidate's worth of real inference twice to interruption, because it only checkpointed to disk after a full 40-entry candidate loop returned.** With only one candidate reachable in this environment (qwen2.5:1.5b — no other Ollama model pulled, no Groq/Gemini key), a single candidate's run is the *entire* run, and a 40-entry CPU-only pass takes 30-45+ minutes with no natural earlier save point. The first loss was a deliberate kill (restarting against a corpus that turned out to have the item-9 composition bug); the second was the host process itself dying mid-run with the machine apparently suspended partway through (one logged call latency of 10,045.7 s makes wall-clock suspension, not a hang, the likely cause) — both times, `tests/bench/bakeoff_raw.json` and `Docs/planning/bakeoff_phase2.md` were left completely unchanged from an unrelated, much older run, silently discarding 30+ real API calls' worth of work each time. Fixed for real, not just retried and hoped: `runCandidate()` now takes an `onEntryProgress` callback invoked after every single entry (success or error), and `main()` persists both output files on every call through it — so an interruption now loses at most the one in-flight call, not the whole candidate.

11. **The real bake-off ran clean to completion (40/40, 0 errors) against the corrected corpus** once the item-9 and item-10 fixes were in place. Only one candidate was reachable, exactly as items 6 and 10 anticipated: **qwen2.5:1.5b — the deliberate control** scored 19% target accuracy, 17%/20% step precision/recall, 83% schema-valid on first attempt, **0% hallucinated-handle rate**, 1.00/2 willNotDo quality, p50/p95 22.4 s / 102.7 s, 1884 in / 83 out avg tokens, 0/40 errors. `Docs/planning/bakeoff_phase2.md` and `tests/bench/bakeoff_raw.json` (including `stepMatchDisagreements` for the still-outstanding human review pass) are the real, committed artifacts. No number here is invented or extrapolated.

12. **A real bug in the report generator, caught reading its own output: naming the deliberate control as "the default planner."** §10.1 is explicit that the 1.5B model is "included not as a candidate but to put a number on §3.7.9's rejection" — it must never be eligible to win the default/runner-up ranking, however well it scores or however few real candidates happen to be measured alongside it. `writeReport()`'s `eligible`/`ranked` selection had no such exclusion, so item 11's run — where the control was the *only* measured entry — mechanically produced "qwen2.5:1.5b — the deliberate control (§10.1) is named the default planner," exactly the outcome the control exists to argue against. Fixed by excluding the control (matched the same way the pre-existing `controlRow` lookup already did) from `eligible` before ranking; when no real candidate clears the bar, the decision text now says so plainly and discloses the control's number separately as the §3.7.9 evidence point it is, not as a candidate result. Regenerated the report from the already-saved `bakeoff_raw.json` via a new `tools/regen-bakeoff-report.ts` rather than re-running the real 40-call bake-off a third time for a report-formatting-only fix — `bakeoff.ts`'s `main()` is now guarded (`isDirectRun`) so `writeReport`/`CandidateReport` can be imported without triggering it.
