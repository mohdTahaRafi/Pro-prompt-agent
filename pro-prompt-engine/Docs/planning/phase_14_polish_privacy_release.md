# Phase 14 — Polish, Privacy Disclosure & Store Release

**Document type:** Phase 14 execution document
**Architecture basis:** `architecture.md` §3.7.23 (two disclosure classes, and what is no longer claimed), §3.8 (bundle budgets), §3.9 (what the product may and may not claim), §3.10
**PRD basis:** PR-UX-1…7, PR-PRV-2…6, PR-SEC-9, PR-SEC-16, PR-LOC-2, R-4, R-8, SC-9, SC-10, SC-11
**Depends on:** Phases 1–12 in full. Phase 13 only if it ran

> **Depth note.** Lower initial depth per §3.10. The disclosure rules in §3 and the claim prohibitions in §4 are **binding**; UI detail grows at implementation.

---

## 1. Objective

At the end of this phase the product is **submittable**. Accessibility and keyboard control are real rather than incidental. Bundle budgets are enforced in CI rather than measured occasionally. Permission-rationale copy explains, in the user's terms, why an agent needs the access it asks for. And the data-handling disclosure distinguishes **disclosure class A from class B** and **Local-only from Hybrid** rather than blurring them — which is the difference between a listing that is accurate and one that is a liability.

**By the end of this phase:** a submitted, reviewable Chrome Web Store listing whose privacy description matches what the code actually does.

---

## 2. Accessibility and keyboard control

The cockpit is a control surface for something acting on the user's behalf. A control surface that cannot be operated without a mouse is not a control surface for everyone.

| Requirement | Standard |
|---|---|
| Every control in §11 of the PRD reachable by keyboard | Tab order follows visual order; **Stop is reachable in one keystroke from anywhere in the panel**, and has a global command shortcut |
| Screen-reader operability | The side panel is a landmark-structured document; run state changes announce via a polite live region; approval prompts announce via an **assertive** one, because an approval that is not heard is an approval that is not given |
| Focus management | Opening an approval moves focus to it; resolving it returns focus to where it was; the in-page overlay never steals focus from the page the user is typing in |
| Contrast and motion | WCAG AA contrast on every state badge, including the amber `unconfirmed`; `prefers-reduced-motion` respected on every transition |
| The in-page overlay | Reachable by keyboard, dismissible by Escape, and **never a tab trap** — it lives on a page the user is also using |

`chrome.commands` gains one global shortcut for Stop. A user who needs to stop the agent should not have to find a panel first.

---

## 3. The privacy disclosure — binding

### 3.1 The two classes, stated separately

The store listing, the in-product privacy page and the permission-rationale copy all use the same two-class structure. Collapsing them into one sentence about "data" is the failure mode this section exists to prevent.

| Class | What crosses the wire | When | User-facing sentence |
|---|---|---|---|
| **A** | A description of the page's controls — their roles, labels and whether they are filled. **Not page text, not your values.** | Only on a **Hybrid** run, to the provider whose key you supplied | *"Planning for this run is sent to `<host>` using your key. It receives a description of the page's controls — their roles, labels and whether they're filled — not the page's text or your values."* |
| **B** | Raw page text | Only when a task reads page text **and** you are on Hybrid — and it is condensed on your machine first | *"This task reads the page's text. On a Hybrid run, a shortened version is sent to `<host>`. The full text never leaves your machine. If the on-device model that shortens it isn't available, the task stops rather than sending the full text."* |

### 3.2 The postures, stated separately

- **Local-only** — *"Nothing leaves your machine. Planning runs on Ollama; verification, text completion and page reading run in your browser. If no planning model is available, a multi-step task won't start — we'd rather tell you than run it on something that isn't up to it."*
- **Hybrid** — the class A and B sentences above, naming the actual destination host.

### 3.3 What is stored, and for how long

Plainly, on one page: run records include the text of pages the agent read — *that is how the report can tell you where a value came from* — retained for 30 days by default and configurable to 7 / 30 / 90 / forever, with per-run delete and clear-all. Prompt history the same. Screenshots are **transient and never written to the run record**. API keys are stored on this device only and are never synced.

One correction of an implied behaviour, carried from Phase 8: `purgeOnUninstall` is a stored setting with no active mechanism. The honest sentence is *"Uninstalling the extension removes everything it stored, because Chrome deletes an extension's storage when you remove it"* — which is true — rather than implying an active purge routine that does not exist.

---

## 4. What the product may and may not claim — binding

PR-SEC-16 prohibits claiming immunity to embedded-instruction attacks, and §3.9 extends it to privacy exactly as it applies to injection.

| Prohibited | Required instead |
|---|---|
| *"Your page content never leaves your machine."* | True of Local-only, **false of Hybrid**. The listing must not blur them |
| *"Resistant to prompt injection."* / *"Immune to…"* / *"Protected against…"* | *"Pro Prompt treats page content as data, not instructions, and stops on several kinds of suspicious content. This reduces the risk; it does not remove it."* |
| *"Verified"* as a blanket claim | *"Every action is checked afterwards, and when it can't be checked, the report says so."* |
| A success-rate percentage | Nothing. A number here teaches over-trust (R-8), and §16.3 of the PRD says the criteria are a starting position, not a finished evaluation |
| *"Secure"* / *"Safe"* unqualified | Describe the mechanism: the enforcement layer the model cannot reach, per-site permissions, the never-tier prohibitions |

**The claim that survives both postures, and that no cloud agent can copy:** *"Pro Prompt operates no server. On a Hybrid run your own key talks to a provider you chose — we never see the traffic, never hold the key, and are never a party that could be compelled to retain your page content."*

`tests/unit/copy.spec.ts` greps every user-facing string in the built bundle and the listing draft against a prohibited-phrase list. A banned phrase fails CI. This is unusual and it is the right mechanism: marketing copy drifts, and the prohibition is a product requirement, not a preference.

---

## 5. Permission-rationale copy (R-4)

An agent needs access that an agent looks alarming asking for. The mitigation is that it asks **per origin, at the moment it is needed, with a reason** — which the architecture built in Phase 1 — and this phase writes the words.

| Ask | Copy |
|---|---|
| Host access to one origin | *"Pro Prompt needs access to `<origin>` to read this page and act on it. It won't have access to any other site, and you can take this back at any time from the popup or from Chrome's own extensions page."* |
| `debugger` (Phase 9, optional) | *"This lets Pro Prompt drive the page the way your keyboard and mouse do, instead of simulating events — which makes some forms work that otherwise silently reject typed input. While it's working, Chrome shows its own banner saying Pro Prompt is debugging the tab. That banner is deliberate: it's how you can always tell. You won't be able to open DevTools on a tab the agent is working in."* |
| `alarms` (Phase 11) | *"This lets scheduled tasks run at the time you set. Scheduled tasks can only read and report — they never type, click or submit, because you're not there to stop them."* |
| A remote provider's host | *"This lets Pro Prompt send planning requests to `<host>` using the key you entered. It's only used on runs you've set to Hybrid."* |

The store listing's own permission justifications use the same words. A listing that explains permissions differently from the product is a listing that will be questioned.

---

## 6. Bundle budgets in CI

Measured occasionally through Phases 2–13; enforced here.

| Artifact | Budget | Why |
|---|---|---|
| Content script | **≤ 80 KB gzipped** | Injected into every granted page. Above this the extension is a measurable page-load tax and users revoke grants |
| Offscreen document | **≤ 250 KB gzipped**, excluding lazily-loaded WebLLM | It also serves judge-tier text scoring, so its parse cost sits in front of SC-11 |
| Side panel + dashboard | **≤ 400 KB gzipped**, excluding WebLLM | |

Each is a CI step that fails the build, with the delta from the previous commit reported on every PR so a regression is attributed when it happens rather than discovered at release.

---

## 7. Tasks & Acceptance Criteria

| # | Task | Acceptance Criteria |
|---|---|---|
| 14.1 | Keyboard operability across the cockpit, overlay and dashboard | Every PRD §11 control is reachable by keyboard; Stop is one keystroke from anywhere in the panel and has a global `chrome.commands` shortcut; the overlay is never a tab trap |
| 14.2 | Screen-reader operability | An automated axe pass reports zero violations on the panel and dashboard; run-state changes announce politely; approval prompts announce assertively; a manual NVDA/VoiceOver pass over one full J-1 run is recorded |
| 14.3 | Focus management and reduced motion | Opening and resolving an approval moves and restores focus; the overlay never steals focus from a field the user is typing in; `prefers-reduced-motion` removes every transition |
| 14.4 | Contrast on every state | WCAG AA on all badges including amber `unconfirmed`, in both light and dark |
| 14.5 | Write the disclosure page using the two-class, two-posture structure | The in-product page and the listing draft use the §3 sentences verbatim; a reviewer can map each sentence to a code path |
| 14.6 | Implement `copy.spec.ts` prohibited-phrase enforcement | Every banned phrase in §4 fails CI when present in any built user-facing string or in the listing draft |
| 14.7 | Write the permission-rationale copy and wire it into every request point | Each of the four asks shows its §5 copy **before** the Chrome prompt appears |
| 14.8 | Correct the `purgeOnUninstall` implication | The disclosure states what is true about uninstall; the unused setting is removed rather than left implying behaviour |
| 14.9 | Enforce the three bundle budgets in CI with per-PR deltas | Each budget is a failing check; a PR that adds 12 KB to the content script reports the delta |
| 14.10 | Rewrite `README.md` | The audit records that it overstates current behaviour. The rewrite describes what the product does, its two postures, and its limits |
| 14.11 | Mark `Docs/ARCHITECTURE.md` superseded | A header pointing to `Docs/planning/architecture.md` |
| 14.12 | Assemble the store listing | Screenshots, description, permission justifications, and a privacy policy that matches §3 and §4; every permission justified in the same words the product uses |
| 14.13 | Final full-suite pass | `npm run ci && npm run eval && npm run eval -- --redteam` all green; every hard gate at zero |
| 14.14 | Submit | A submitted, reviewable listing |

---

## 8. Milestone Definition

Phase 14 is **complete** when:

> A reviewer opens the Chrome Web Store listing. Under permissions they find five: storage, scripting, offscreen, side panel, active tab — and no host permissions at all. The justification reads *"Pro Prompt asks for access to one site at a time, at the moment you point it at that site, and you can take it back from the popup."* The privacy section does not say that data never leaves the device. It says there are two ways to run the product, describes what each one sends and to whom, and states that the extension has no server of its own. It does not claim resistance to prompt injection; it says page content is treated as data rather than instructions, that the product stops on several kinds of suspicious content, and that this reduces the risk without removing it. There is no success-rate percentage anywhere. A user installs it, opens the panel with a keyboard shortcut, tabs through every control, presses Stop from the keyboard mid-run and watches it halt, and hears a screen reader announce *"Approval needed: click Submit application on careers.example.com"* the moment the prompt appears. A developer runs the full suite: typecheck, 40 unit suites, a build with three bundle-size checks reporting 71 KB / 218 KB / 356 KB gzipped, 24 Playwright specs, the three-layer evaluation, and 53 red-team pages — every hard gate at zero. They open `redteam_phase12.md` and `spike_report_phase1.md` side by side and can trace every number in the listing back to a measurement in one of them.

---

## 9. Files to Create

```
entrypoints/sidepanel/Cockpit.tsx     # [modify] a11y, focus, live regions
entrypoints/options/App.tsx           # [modify] disclosure page, a11y
lib/page/overlay/*                    # [modify] keyboard, escape, no focus theft
wxt.config.ts                         # [modify] chrome.commands for Stop
.github/workflows/ci.yml              # [modify] bundle budgets with deltas, axe
tests/unit/copy.spec.ts               # [new] prohibited-phrase enforcement
tests/a11y/{panel,dashboard,overlay}.spec.ts   # [new] axe passes
README.md                             # [rewrite]
Docs/ARCHITECTURE.md                  # [modify] superseded header
Docs/planning/store_listing.md        # [new] the listing draft, CI-checked
Docs/planning/privacy_disclosure.md   # [new] the source of truth for §3 copy
```

**Estimated complexity:** ~1,500 new/modified LOC across ~16 files, plus listing assets. New runtime dependencies: **0** (`@axe-core/playwright` is test-only).

---

## 10. Future Considerations (Post-Launch) — explicitly **NOT in scope**

Recorded so they are neither forgotten nor smuggled in.

| Item | Where it stands |
|---|---|
| MCP write-capable tools and the full OAuth 2.1 flow | Phase 13 shipped read-only on unauthenticated/bearer servers. The OAuth surface is a phase of work on its own |
| Pro Prompt as an MCP **server** | Rejected on a platform fact (§3.5.1): an extension cannot listen on a socket, so it would need a companion daemon — and *no server at all* is both the differentiator and a safety argument |
| AI-site integration (J-8) | FUTURE. Third-party AI interfaces change without notice; retained as a feature candidate, never a foundation |
| Per-site autonomy defaults (PR-AUT-6, the FUTURE half) | Per-run modes ship; per-site defaults do not |
| Intelligent profile-fact merging (PR-POL-6) | FUTURE. Phase 8 deleted the dead implementation and recorded why |
| User-defined capabilities | A substantially larger safety surface; effectively a separate product decision |
| Domain specialisations | Narrower and more reliable than a general agent, because success is definable |
| Vector store / embeddings for run memory | Explicitly Cerebro's territory (PRD §7.2) |
| A backend orchestrator | Rejected: Pro Prompt operates no server, and that is the claim that survives both postures |
