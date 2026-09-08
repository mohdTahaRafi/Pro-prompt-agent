# Phase 1 Spike Report — Q8 (offscreen survival) & Q11 (LanguageModel reachability)

**Machine (Q11 measurement below):** sandboxed Linux CI-style container, no dedicated GPU, Google Chrome 144.0.7559.96 (Playwright-driven, `--load-extension`, non-headless under Xvfb).
**Spike harness:** `entrypoints/spike/` (index.html, main.ts, panel.html) + the heartbeat/probe hooks added to `entrypoints/offscreen/main.ts`, both deleted at task 1.20. This report is what remains.

---

## §9.1 — Q8: offscreen document survival across 30 minutes, including screen lock and sleep/wake

**Not measured in this session.** The three scenarios this question asks about (S1 idle, S2 screen-locked, S3 system-sleep) are OS-level power-state transitions this sandboxed execution environment cannot trigger — there is no real display session to lock and no way to suspend the host. Fabricating survival numbers for a mechanism nobody actually exercised would be worse than not measuring it: it would let Phase 4 build on a budget nothing verified.

**What is built and verified mechanically instead:** the heartbeat mechanism itself. `entrypoints/offscreen/main.ts` writes `{seq, at, sinceCreateMs}` to `chrome.storage.local.spikeHeartbeat` every 5s and increments `globalThis.__spikeCounter`; `entrypoints/spike/index.html` polls and renders the series; `entrypoints/spike/panel.html` is a standalone view meant to be left open across the lock/sleep test. `chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})` was confirmed reachable from the spike page during the Q11 run below (used to `ensureOffscreen()` before each probe run).

**Action required before Phase 4 depends on this:** run the §9.1 protocol on a real development machine —

1. Build and load the extension unpacked (`npm run build`, then load `.output/chrome-mv3` in `chrome://extensions`).
2. Open `chrome-extension://<id>/spike.html`, click **"Ensure offscreen doc + start watching heartbeat"**.
3. Open `chrome-extension://<id>/spike-panel.html` in a second tab and leave it visible.
4. Run S1 (30 min idle), S2 (lock at t=2min, unlock at t=25min), S3 (sleep at t=2min, wake at t=20min), three times each, recording: whether `chrome.runtime.getContexts()` still returns the offscreen document at t=30min, the largest gap the panel's "Largest gap seen" stat shows, and whether the panel's `sinceCreateMs` column keeps climbing monotonically from before the transition (continuity) or resets near zero (the document was recreated — counts as **not survived** per §9.1).
5. Apply the consequence table in §9.1 exactly as written, append the nine rows and the verdict to this section, and delete `entrypoints/spike/` (task 1.20) only after this is filled in.

**Consequence taken: undetermined — the 12-minute wall-clock budget (architecture.md §3.8) is NOT yet confirmed and must not be treated as validated until the above is run.**

---

## §9.2 — Q11: LanguageModel reachability from an offscreen document

**Measured for real** against `entrypoints/offscreen/main.ts`'s `runQ11Probes()`, invoked from `entrypoints/spike/index.html` via `chrome.runtime.sendMessage({target:'offscreen', type:'SPIKE_RUN_Q11_PROBES'})`, driven by Playwright against a real, non-headless (Xvfb) Chrome 144 with the built extension loaded.

| # | Probe | Method | Result |
|---|---|---|---|
| P1 | Is `LanguageModel` defined in the offscreen global scope? | `typeof LanguageModel !== 'undefined'` | **true** — the single riskiest unverified assumption in the architecture (§9.2) is confirmed on this Chrome version: the constructor exists in an offscreen document, not just a regular tab. |
| P2 | What does availability report? | `await LanguageModel.availability()` | **`"unavailable"`** |
| P3 | Does a session create and answer? | `create()`, then `prompt(...)`, timed | **Not run — blocked by P2.** `create()` rejected: `"Unable to create a text session because the service is not running."` |
| P4 | Does `responseConstraint` constrain decoding? | 20× confusing prompt with a schema | **Not measured** — blocked by P3 |
| P5 | Does image input work? | solid-red 64×64 PNG | **Not measured** — blocked by P3 |

Raw output captured verbatim:
```json
{
  "p1_defined": true,
  "p2_availability": "unavailable",
  "p3_error": "Unable to create a text session because the service is not running."
}
```

**Why P2 reports unavailable here — re-verified and root-caused in a follow-up session, confirmed environment/hardware, not architecture:**

This session re-ran P1/P2 directly against the offscreen document (attached via CDP `Target.attachToTarget` to `chrome-extension://<id>/offscreen.html`, bypassing the now-deleted spike harness) and got the identical result — `P1: true`, `P2: "unavailable"`, and `LanguageModel.params()` (which returns the model's real capability info once eligible) returns `null`. Critically, `chrome://components` lists **no "Optimization Guide On Device Model" entry at all** — not "component registered but not yet downloaded", not "outdated": absent entirely. Chrome only registers that component for possible download after an initial device-eligibility check (disk space, OS, and — the one this sandbox fails — a capable GPU); a device that fails that check never gets the component registered, which is exactly what's observed here. This session's own WebGPU probe (`§9.3` baseline work, same sandbox) independently confirms the only reachable GPU adapter here is `swiftshader` (software rendering, `vendor: "google"`, no real GPU device) — there is no dedicated/capable GPU for Chrome's eligibility check to pass.

**Conclusion: this is a hardware/environment gate, not an architecture or implementation problem.** The thing Q11 actually exists to de-risk — whether `LanguageModel` is reachable *from an offscreen document specifically* (as opposed to a regular tab) — is answered and confirmed **true** (P1). The extension's own code path to it is correct. What's missing is a machine Chrome considers eligible to ever download Gemini Nano in the first place; no extension-side code change can work around that gate. This is recorded as **not measured** for P3–P5, per §9.2's rule, never as a pass or a fail — the hardware floor was not met, so the capability genuinely could not be exercised, as distinct from the capability being exercised and failing.

**Consequence taken, per §9.2's declared table:**

> P1 or P2 unavailable on the reference machine → Judge tier falls to WebLLM. A second probe is required from a `sidepanel` document.

P1 actually returned **true** (the object is defined) — only P2 (availability) reports `unavailable`, which the table treats the same way. **Consequence taken: the Judge tier's Local-only path falls back to WebLLM per §9.2, and Phase 4 is told now, before any code is built on the assumption of a reachable on-device model on a typical machine.**

**The required second probe (side panel) is not runnable in Phase 1** — `sidepanel.html` does not exist yet; it is a Phase 5 deliverable (§4.1, forward dependency). **Action required:** re-run this exact probe set from a side panel document as soon as Phase 5 lands the side panel, before Phase 4's judge-tier routing is finalized, and **separately, re-run the full P1–P5 set (including P3–P5, which never got the chance to run here) on a real development machine that meets Chrome's on-device model hardware floor** — the `unavailable` result above is a sandbox artifact, not evidence the capability doesn't exist on real user hardware.

**Cold `create()` latency, `clone()` latency, and the 20-token round trip (Q6):** not measured — none of these are meaningful without a working session (P3).

---

## Summary of what Phase 4 can and cannot rely on yet

| Question | Status |
|---|---|
| Q8 (offscreen survival) | **Not measured.** Harness built and mechanically verified; the actual 9-run protocol needs a real, unattended development machine across real lock/sleep. Do not treat the 12-minute wall-clock budget as confirmed. |
| Q11 P1 (LanguageModel defined in offscreen) | **Confirmed true**, for real, on Chrome 144. |
| Q11 P2 (availability) | **`unavailable`** in this sandbox — root-caused (follow-up session) to no capable GPU passing Chrome's on-device-model eligibility gate (component never registers in `chrome://components`); confirmed environment/hardware, not a code/architecture defect. Re-run on real hardware required. |
| Q11 P3–P5 | **Not measured** — blocked by P2 in this environment. |
| Q11 fallback consequence | **Taken now**: Judge tier's Local-only path falls back to WebLLM until a passing P2/P3 result exists on real hardware, and the required side-panel re-probe is deferred to Phase 5. |
