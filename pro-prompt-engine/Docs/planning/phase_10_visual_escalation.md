# Phase 10 — Visual Escalation

**Document type:** Phase 10 execution document
**Architecture basis:** `architecture.md` §3.5.1 (screenshot-primary rejected), §3.5.2 (adopted, optional), §3.7.13 (three gate-enforced triggers), §3.8 (payload discipline)
**PRD basis:** PR-PERC-2, PR-VER-3, PR-VER-7, PP-6, R-2, OQ-4
**Depends on:** Phases 1–9. Background-tab capture depends specifically on Phase 9

> **Depth note.** Lower initial depth per §3.10. The three triggers, the payload discipline, the local/remote split and the journal rule are **binding**; file-level detail grows at implementation.

---

## 1. Objective

At the end of this phase the agent can **look at the page** — and only in three situations it can prove it is in. `look_at` becomes callable, `lib/vision/` exists, and the gate refuses the verb unless the run's journal shows one of exactly three trigger conditions for the current step. Captures are cropped, downscaled and not written to the journal by default. On a Local-only run the local engine is used and low confidence is reported as *unknown*; on a Hybrid run a remote vision model is used where §3.7.13 says it is the better choice.

**By the end of this phase:** a canvas-rendered control is acted on after DOM perception reports it unreachable. Two identically-labelled buttons resolve by cropped image instead of stopping to ask.

**Vision is an escalation capability, never a perception layer.** Structured perception is always first.

---

## 2. Why not screenshot-primary

Distinct from what is built here, and rejected outright (§3.5.1). Every MVP journey — form fill, structured extraction, buried settings, page comparison, draft-and-stop, in-place rewrite — is DOM-legible. A viewport image costs roughly two orders of magnitude more payload per step than 120 element descriptors while discarding exactly the thing the gate needs: **stable, addressable handles**. Grounding a click in pixel coordinates also reintroduces the forged-target problem that opaque handles eliminate.

So `look_at` returns *information about* elements the registry already holds. **It never returns coordinates, and there is no verb that acts on a coordinate.** A vision call can tell the agent which of three known handles is the primary submit control; it cannot tell it to click at (412, 908).

---

## 3. The three triggers — binding

The gate permits `look_at` only when the run's journal shows one of these for the **current step**. Everything else is refused, journaled as `look_at.refused`, and the planner is told why.

| # | Trigger | Why vision is worth its cost here |
|---|---|---|
| 1 | **`TARGET_AMBIGUOUS`** — descriptor re-resolution matched more than one node | A cropped image of each candidate plus *"which of these is the primary submit control"* is precisely the narrow visual classification a small model handles well, and it converts an ask-the-user interruption into a resolved step |
| 2 | **A canvas-only `unreachableRegion`** — the step's target region has interactive pixels and no interactive DOM | Without vision the honest report is *"I cannot see this"*; with it there is a chance of proceeding |
| 3 | **An `unconfirmed` verification on an Always-tier step** — the DOM produced no signal either way about something irreversible | A visual check is worth its cost precisely here |

**Without this rule a screenshot becomes the lazy default perception and the payload budget collapses.** `tests/unit/vision-trigger.spec.ts` asserts each trigger permits and that **nothing else does** — including a planner that simply asks for a look because it would like one.

The gate's check reads the journal, not an assertion from the requester. A trigger the requester claims but the journal does not show is a refusal.

---

## 4. Payload discipline — binding

| Rule | Value | Why |
|---|---|---|
| Crop | Target bounding box + **24 px** padding | Enough context to see the control's neighbours without capturing the page |
| Downscale | Long edge ≤ **768 px** | Legible for a cropped control; ~1/100th of a full-page native capture |
| Payload | ≤ **200 KB** per capture | §3.8 |
| Rate | ≤ 1 per step, ≤ 3 per run, ≤ 10 % of steps across the evaluation set | Above 10 % the structured perception layer has failed and the fix belongs in `perception.ts`, not in more screenshots |
| Full-viewport capture | Reserved for trigger 2 only | It is the only trigger where the target's own box is not known |
| Journal | **Screenshots are not written to the journal by default.** The journal records that a look occurred, its trigger, and its verdict | An image can contain anything that was on screen, and the run record already has a retention policy to answer for |

Capture path: `captureVisibleTab` + `OffscreenCanvas` crop on the DOM backend; `Page.captureScreenshot` with `clip` on the CDP backend. **A background roster tab can only be captured on the CDP backend** — `captureVisibleTab` captures only the active tab of a window. On the DOM backend, a `look_at` in a background tab either focuses the tab first (if Phase 7's Q15 already forced focusing) or returns `ask_user`.

---

## 5. The local / remote split — said plainly

For the canvas case and for Always-tier disambiguation, **a remote vision model is the better choice on a Hybrid run.** A 3–4B on-device model's OCR and spatial grounding on dense application UI is not reliable enough to base an irreversible decision on, and pretending otherwise would breach PP-6 at the exact moment it counts most.

On a Local-only run the honest behaviour is the opposite: use the local engine, and **where it returns low confidence, report *unknown* and ask.** There is no third option in which a low-confidence local answer is used anyway.

```ts
// lib/vision/look.ts
const CONFIDENCE_FLOOR = { local: 0.85, remote: 0.75 };
// Local is held to a HIGHER bar than remote, deliberately: the weaker engine
// must clear more before its answer is acted on.
```

Screenshots on a Hybrid run **count as remote transmission** for the pre-run disclosure (PR-PRV-6), and the disclosure sentence says so. Screenshots are never sent off-device on a Local-only run.

If Phase 1's Q11 probe P5 (image input) failed, local vision does not exist, `CHAINS.vision['local-only']` is empty, and a `look_at` on a Local-only run returns `ask_user` — which is the declared fallback and is implemented as such rather than discovered here.

---

## 6. Tasks & Acceptance Criteria

| # | Task | Acceptance Criteria |
|---|---|---|
| 10.1 | Implement `lib/vision/triggers.ts` reading the journal | `vision-trigger.spec.ts`: each of the three triggers permits; a planner request with no trigger is refused and journaled `look_at.refused`; a claimed-but-unjournaled trigger is refused |
| 10.2 | Move `look_at` out of `NOT_YET_IMPLEMENTED` at the gate | The verb is permitted only through `triggers.ts`; its tier is Low; it changes no page state |
| 10.3 | Implement `lib/vision/capture.ts` for both backends | DOM: `captureVisibleTab` + `OffscreenCanvas` crop; CDP: `Page.captureScreenshot` with `clip`; both produce ≤ 200 KB with long edge ≤ 768 px |
| 10.4 | Implement background-tab capture on CDP only | A `look_at` in a background tab succeeds on CDP; on DOM it focuses first or returns `ask_user` — never silently captures the wrong tab |
| 10.5 | Implement `lib/vision/look.ts` with the local/remote split and confidence floors | Local below 0.85 returns *unknown* and escalates to `ask_user`; remote below 0.75 does the same; a Local-only run makes zero remote calls |
| 10.6 | Wire trigger 1 into `TARGET_AMBIGUOUS` recovery | Two identically-labelled buttons resolve by cropped image without asking; a third indistinguishable candidate still asks |
| 10.7 | Wire trigger 2 into canvas-region handling | A canvas-rendered control that DOM perception reported unreachable is acted on; the action still goes through the gate with a registry handle, never a coordinate |
| 10.8 | Wire trigger 3 into Always-tier `unconfirmed` verification | An unconfirmed submit gets one visual check; a low-confidence result leaves the verdict `unconfirmed`, never upgrades it to `confirmed` |
| 10.9 | Enforce the rate budget and journal rule | ≤ 1 per step and ≤ 3 per run enforced at the gate; the journal contains the trigger and verdict and **no image data** |
| 10.10 | Extend the pre-run disclosure | A Hybrid run states that screenshots may be sent and to which host; a Local-only run states they never leave the device |
| 10.11 | Performance validation | `look_at` round trip ≤ 4 s p95 local, ≤ 3 s p95 remote; escalation rate ≤ 10 % of steps across the eval set |

---

## 7. Milestone Definition

Phase 10 is **complete** when:

> A user runs a task on an application whose date picker is drawn on a `<canvas>` — no DOM at all. The agent reads the page, reports the region as unreachable, and instead of stopping, the panel shows *"I can't read that control from the page's structure. Taking one look at it."* A single 640×220 cropped image is captured, and the agent identifies and clicks the right date cell — through a registry handle for the canvas element, not a pixel coordinate. On a second run, two buttons both named **Continue** appear; where the previous phase would have stopped and asked, the agent captures both, picks the one that is the primary submit control at 0.91 confidence, and proceeds — one line in the report reads *"resolved by looking at the page (2 identical labels)"*. On a third, an Always-tier submit produces no readable page change; the agent takes one look, cannot tell either, and the report says **unconfirmed** — it does not upgrade the verdict. The user opens the journal for all three runs: three `look_at` events, each with its trigger and verdict, and **no images**. They then set Local-only on a machine where the built-in model's image input is unavailable; the agent does not attempt a look at all — it asks.

---

## 8. Files to Create

```
lib/vision/{triggers.ts, capture.ts, look.ts}   # [new]
lib/schemas/action.schema.ts                    # [modify] look_at leaves NOT_YET_IMPLEMENTED
lib/policy/gate.ts                              # [modify] look_at branch calls triggers.ts
lib/agent/recovery.ts                           # [modify] TARGET_AMBIGUOUS may escalate
lib/model/router.ts                             # [modify] vision chain gains a caller
tests/unit/{vision-trigger,capture,look-confidence}.spec.ts
tests/e2e/{canvas-control,ambiguous-visual,always-unconfirmed}.spec.ts
tests/e2e/fixtures/{canvas-datepicker.html, twin-continue.html, silent-submit.html}
```

**Estimated complexity:** ~1,400 new LOC across ~14 files. New runtime dependencies: **0**.

---

## 9. Forward Dependencies Declared Here

- The `look_at` escalation rate is a gauge with no consumer yet. **[Phase 12's eval harness reports it across the three evaluation layers, and >10 % is a signal to fix `perception.ts`, not to raise the budget.]**
- Screenshots are excluded from the journal by default. **[Phase 14's disclosure copy must state that captures are transient and not retained.]**
