# Phase 9 — CDP Backend & Accessibility-Tree Perception

**Document type:** Phase 9 execution document
**Architecture basis:** `architecture.md` §3.5.2 (adopted but optional), §3.7.12 (backend is mechanism, gate is authority), §3.8 (parity and attach budgets), §3.9 (the `debugger` permission, CDP input bypass), §3.11 Q3/Q12
**PRD basis:** PR-ACT-2, PR-ACT-5, PR-ACT-6, PR-PERC-2, PR-PERC-7, PR-REC-4, PR-SEC-9, R-2, SC-2
**Depends on:** Phases 1–8 in full

> **Depth note.** Per architecture §3.10, Phases 9–14 are written at lower initial depth than 1–8 and deepened when reached. **What is fixed now, and is not open to redesign at implementation time, are the interfaces this phase consumes and the safety rules it must not weaken.** Everything in §3, §4 and §5 below is binding; the file-level detail is expected to grow when the phase begins.

---

## 1. Objective

At the end of this phase the user can **opt into a second actuation backend** that gives the agent genuinely trusted input and a browser-computed accessibility tree. `cdp-backend.ts` implements the Phase 3 `ActuationBackend` interface behind `optional_permissions: ["debugger"]`, requested at enable time and never at install. Perception on this backend comes from `Accessibility.getFullAXTree`; input comes from `Input.dispatchMouseEvent` / `dispatchKeyEvent`; capture comes from `Page.captureScreenshot` with a clip. Any detach, for any reason, halts the run.

**The gate does not change.** Not one check, not one line. That is the assertion this phase exists to prove, and `backend-parity.spec.ts` is how it is proven.

**By the end of this phase:** a React input that silently rejects programmatic writes fills first try with CDP enabled, and reports `WRITE_REJECTED` with it off. Opening DevTools on the agent's tab halts the run with a named reason rather than degrading. The same fixture run on both backends produces identical gate decisions and identical journal event shapes.

**No vision, no unattended execution, no MCP.** `Page.captureScreenshot` is implemented here as a `capture()` method because the interface declares it, and **nothing calls it** — `look_at` is Phase 10.

---

## 2. Why this is opt-in and not default

| | `dom-backend` (default) | `cdp-backend` (opt-in) |
|---|---|---|
| Permission | none beyond the origin grant | `optional_permissions: ["debugger"]`, requested at enable time |
| Perception | our DOM walk, computed accessible names, open shadow roots | `Accessibility.getFullAXTree` — browser-computed roles, names and states, piercing shadow DOM and frames |
| Input | native value setters + dispatched `input`/`change`; `isTrusted === false` | `Input.dispatchMouseEvent` / `dispatchKeyEvent`; genuinely trusted input |
| Capture | `captureVisibleTab`, viewport only, active tab only | `Page.captureScreenshot` with `clip`, including outside the viewport and in background tabs |
| Visible to the user | the in-page overlay only | the overlay **plus** Chrome's own attached-debugger banner |

**What it buys:** trusted input retires the `WRITE_REJECTED` failure class outright, and a browser-computed AX tree sharply reduces `TARGET_AMBIGUOUS` by giving better names. Phase 6 instrumented the `WRITE_REJECTED` recovery rate precisely so this phase can be justified with a number rather than an intuition.

**What it costs, and why it stays off by default:** the `debugger` permission is heavy for a user who wants two forms filled on two sites, and store review scrutinises it. Only one CDP client may attach to a target, so DevTools on the agent's tab is a conflict. And it is Chromium-only — though `chrome.offscreen` already made that true.

**The banner is an asset, not a cost.** For a product whose proposition is that you can always see what it is doing and stop it, an un-spoofable, browser-rendered, extension-attributed indicator that appears exactly while the agent is acting is aligned with the trust story. It cannot be hidden, and it should not be.

---

## 3. The rule this phase must not break

**The backend is a mechanism; the gate is the authority.**

Every check in the gate's eight (Phase 3 §4.2) is expressed over verbs, handles, tiers, tabs and origins. **None of them names a transport.** Switching backends therefore changes how a permitted action is performed and how richly the page is read; it cannot change what is permitted. This is what makes CDP safe to adopt at all — the alternative framing, *"CDP gives the agent more power"*, is only true of an architecture with no gate.

Three things follow, and all three are binding:

1. `lib/policy/**` gains **zero** imports from `lib/actuation/cdp-backend.ts`. The existing CI import check (Phase 3 task 3.5) is extended to assert it.
2. `ActionRequest` and `ActionOutcome` are unchanged. A journal written on the CDP backend is diffable against one written on the DOM backend.
3. `run.backend` is chosen at admission and **immutable for the run's life**.

---

## 4. The new hazard, and its mitigation

`Input.dispatchKeyEvent` types at whatever is focused. It does not consult our element registry the way a DOM write does. **The never-tier exclusion would be bypassable by a focus that lands on a password field.**

This is the one place where enabling the optional backend creates a *new* class of risk rather than reducing one, and it is mitigated with an explicit three-step sequence in `cdp-backend.ts`:

```ts
async function cdpType(tabId: number, handle: string, text: string): Promise<Result<ActEffect, FailureCause>> {
  // 1. Resolve the handle to a backendNodeId through OUR registry, not through
  //    a selector. The model still cannot name an element the snapshot excluded.
  const backendNodeId = await resolveToBackendNode(tabId, handle);
  if (!backendNodeId) return Err('TARGET_MISSING');

  // 2. Focus it explicitly.
  await send(tabId, 'DOM.focus', { backendNodeId });

  // 3. ASSERT the focused element is the intended, non-excluded node — before a
  //    single key is dispatched. If focus moved (a page script stole it, a modal
  //    opened, an autofocus fired), the dispatch is refused.
  const check = await send(tabId, 'Runtime.evaluate', {
    expression: `(() => { const a = document.activeElement;
      return JSON.stringify({ tag: a?.tagName, type: a?.getAttribute('type'),
        ac: a?.getAttribute('autocomplete'), name: a?.getAttribute('name') }); })()`,
    returnByValue: true,
  });
  if (!isIntendedNonExcluded(check, handle)) return Err('FOCUS_ASSERTION_FAILED');

  for (const ch of text) await send(tabId, 'Input.dispatchKeyEvent', keyEventFor(ch));
  return Ok({ dispatched: true, … });
}
```

`tests/e2e/cdp-sensitive.spec.ts` exists for exactly this: a fixture whose script moves focus to a password field between `DOM.focus` and the first keystroke must produce `FOCUS_ASSERTION_FAILED` and zero keystrokes.

---

## 5. Detach handling (Q12)

**The design is already fixed and does not wait for measurement.** `chrome.debugger.onDetach` fires with a reason. **Any detach, for any reason, halts the run, journals `BACKEND_DETACHED` with the reason, and surfaces it to the user. There is never a silent fall back to the DOM backend.**

A run that was granted trusted input must never quietly finish on synthetic events: the user consented to a mode of operation, the gate's decisions were recorded against it, and a silent downgrade would make the journal a misleading record of what actually happened. Restarting on the DOM backend is a **fresh run the user starts**.

What Phase 9 *determines* is the observed behaviour and the message for each of five conflict sources — because assuming them would be inventing facts about a platform:

| # | Conflict | To determine |
|---|---|---|
| 1 | The user opens DevTools on the agent's tab | The observed `reason` string, whether our attach or theirs wins, the user-facing message |
| 2 | Another extension attaches to the same tab | Same, plus which direction the conflict goes |
| 3 | The tab is duplicated | Whether the duplicate inherits an attachment |
| 4 | The tab is moved to another window | Whether the target survives |
| 5 | The tab crashes or is discarded | The reason string and whether re-attach is even meaningful |

Each produces a row in `Docs/planning/cdp_findings_phase9.md` with the raw reason string and the shipped copy. A conflict whose behaviour could not be reproduced is recorded as **not observed**, never as handled.

---

## 6. AX-tree perception

`Accessibility.getFullAXTree` returns browser-computed roles, names and states, piercing shadow DOM and frames. It replaces `accname.ts` and `roles.ts` **on this backend only** — both remain the DOM backend's implementation and are not deleted.

**One correction, carried from §3.7.21 and repeated because it is the thing most likely to be got wrong:** the AX tree does **not** make the token budget more generous. `getFullAXTree` on a large application returns thousands of nodes and needs the same structure-aware pruning. What it provides is better *names*, which should reduce `TARGET_AMBIGUOUS`; it does not reduce payload.

The AX node → `ElementDescriptor` mapping must produce **the same handle namespace and the same descriptor shape** as the DOM walk, because the ownership ledger, the tier classifier and the verifier all read descriptors and none of them knows which backend produced one. Region derivation, ordering and pruning (Phase 2 §7.3–7.5) are reused unchanged, fed from AX nodes instead of DOM elements.

**Sensitive-field exclusion runs on this path too**, and this is where the redundancy designed in Phase 3 §4.6 earns itself: the AX tree is a different data structure, so `classifySensitive` gains an AX-node overload rather than being bypassed. A password field must be excluded on both backends by independently-derived means, and `never-tier.spec.ts` runs against both.

**Q3 revisited here** (pruning on large pages): the study is re-run on the AX tree with the Phase 2 corpus. The expected finding is fewer `TARGET_AMBIGUOUS` outcomes at the same payload — if payload drops materially, that is a surprise worth recording rather than a target being met.

---

## 7. Enable flow and lifecycle

- **Enable** is an explicit dashboard flow that names what the permission grants, in the user's terms, before `chrome.permissions.request({permissions:['debugger']})` — including that Chrome will show a banner on tabs the agent works in, and that DevTools cannot be open on the same tab.
- **Attach** happens at run admission for each roster tab, not at enable time. Budget: **≤ 600 ms p95 to first AX tree** (§3.8) — paid once per run, and longer reads as a hang because the banner appears first.
- **Detach** happens on run completion, stop, halt, and tab close. A leaked attachment leaves a banner on a tab with no run behind it, which is the worst possible trust signal.
- **`optional_permissions: ["debugger"]`** is added to the manifest in this phase and **only** in this phase (§3.9).

---

## 8. Tasks & Acceptance Criteria

| # | Task | Acceptance Criteria |
|---|---|---|
| 9.1 | Add `optional_permissions: ["debugger"]`; build the enable flow | The permission is absent until the user completes the flow; the flow names the banner and the DevTools conflict before requesting; declining leaves everything working on the DOM backend |
| 9.2 | Implement `cdp-backend.ts` against the Phase 3 interface | It compiles against `ActuationBackend` with no interface change; `run.backend = 'cdp'` is accepted at admission and immutable thereafter |
| 9.3 | Implement attach/detach lifecycle | Attach on admission per roster tab; detach on every terminal path including crash; `chrome.debugger.getTargets()` shows zero of our attachments after any run ends |
| 9.4 | Implement AX-tree perception producing identical descriptor shapes | The same fixture yields the same handle count and the same `regions[]` structure on both backends; names differ (better) and the schema does not |
| 9.5 | Port sensitive classification to AX nodes | `never-tier.spec.ts` passes on **both** backends over the full corpus; the AX path uses an AX-node overload, not a DOM fallback |
| 9.6 | Implement trusted input with the three-step focus assertion | `cdp-sensitive.spec.ts`: a fixture that steals focus to a password field produces `FOCUS_ASSERTION_FAILED` and **zero** keystrokes |
| 9.7 | Implement `Page.captureScreenshot` behind `capture()` | It returns a clipped PNG; **nothing in the extension calls it** — asserted by a caller check |
| 9.8 | Implement detach handling: halt, journal, surface | Every detach reason halts the run; a silent fall back to `dom-backend` is unreachable — asserted by a test that forces a detach mid-action and observes the run state |
| 9.9 | Determine the five conflict behaviours (Q12) | `cdp_findings_phase9.md` records the raw reason string, the direction, and the shipped copy for each; unreproducible cases are marked *not observed* |
| 9.10 | `backend-parity.spec.ts` | The same fixture run on both backends produces **identical gate decisions** and **identical journal event shapes** (kinds, order, and field sets — values may differ) |
| 9.11 | Assert the gate is untouched | `git diff` over `lib/policy/` for this phase is empty except for the extended import assertion; `lib/policy/**` imports nothing from `cdp-backend.ts` |
| 9.12 | Re-run the Q3 pruning study on the AX tree | `cdp_findings_phase9.md` §Q3 compares `TARGET_AMBIGUOUS` rates and token counts against Phase 2's corpus baseline |
| 9.13 | Quantify the win | `WRITE_REJECTED` rate on both backends over Phase 6's 20-fixture corpus, tabulated. This is the number that justifies the permission |
| 9.14 | Performance validation | Attach → first AX tree ≤ 600 ms p95; per-action latency on CDP within 1.5× the DOM backend's |

---

## 9. Milestone Definition

Phase 9 is **complete** when:

> A user with a form that has never worked — a React app whose inputs silently discard programmatic writes — runs the agent and watches it report *"Phone — failed: the field still reads empty after typing (the page may be rejecting typed input)"* three times before asking for help. They open the dashboard, find **Advanced actuation**, and read: *"Pro Prompt can drive the page the way your keyboard and mouse do, instead of simulating events. This needs Chrome's debugging permission. While it's working, Chrome will show its own banner saying Pro Prompt is debugging the tab — that banner is deliberate and cannot be hidden. You will not be able to open DevTools on a tab the agent is working in."* They enable it, Chrome asks, they accept. They re-run the same task. A yellow bar appears at the top of the tab reading *"Pro Prompt is debugging this browser."* Every field fills first try, including the phone number. The report shows fourteen confirmed and zero recoveries. Mid-way through a second run they open DevTools on that tab to look at something: the run **halts immediately** with *"Something else attached to this tab's debugger, so I stopped. I don't fall back to a weaker way of typing without telling you — start a new run when you're ready."* It does not quietly finish on synthetic events. A developer then runs `npm run test:e2e -- backend-parity`: the same fixture run twice, once per backend, produces two journals whose event kinds, order and field sets are identical — and a `git diff` of `lib/policy/` across the whole phase shows one changed line, in a test assertion.

---

## 10. Files to Create

```
lib/actuation/cdp-backend.ts       # [fill] the Phase 3 stub
lib/page/ax-perception.ts          # [new] AX tree → ElementDescriptor[]
lib/page/sensitive.ts              # [modify] AX-node overload
lib/model/…                        # untouched
lib/policy/…                       # UNTOUCHED except one test assertion
entrypoints/options/App.tsx        # [modify] Advanced actuation enable flow
entrypoints/background.ts          # [modify] attach/detach lifecycle, onDetach
wxt.config.ts                      # [modify] optional_permissions: ["debugger"]
tests/e2e/{backend-parity,cdp-sensitive,cdp-detach}.spec.ts
tests/unit/{ax-perception,cdp-focus-assert}.spec.ts
Docs/planning/cdp_findings_phase9.md   # [new] Q12 + Q3-revisited + the win metric
```

**Estimated complexity:** ~1,900 new LOC across ~12 files. New runtime dependencies: **0**. New optional permission: **1**.

---

## 11. Forward Dependencies Declared Here

- `capture()` is implemented and uncalled. **[Phase 10 calls it, and is the only reason it exists.]**
- Background-tab capture becomes possible for the first time — `captureVisibleTab` cannot reach a background tab. **[Phase 10 §visual escalation in a background roster tab depends on this and on nothing else.]**
- If Phase 7's Q15 forced `focusBeforeWrite`, the CDP backend's focused-tab requirement costs nothing extra.
- `run.backend` is user-chosen per run. **[Phase 14's disclosure copy must describe both backends accurately, including the banner.]**
