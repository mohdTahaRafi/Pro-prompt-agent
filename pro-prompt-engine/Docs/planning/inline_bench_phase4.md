# Phase 4 — Inline Completion Model Bench (Q6)

**Generated during:** Phase 4 implementation, 2026-09-11
**Scope:** Docs/planning/phase_4_model_tiers_routing.md §9, task 4.16, OQ-8/Q6

## Coverage — what actually ran, and what did not

**No candidate model was measurable in this environment, for a structural reason rather than a configuration one: the inline tier's ONLY engine, in either posture, is Chrome's built-in Prompt API (`LanguageModel`) — §3.7.22's local-only condition, enforced by `tests/unit/router.spec.ts`'s boundary assertion on `CHAINS.inline`. There is no WebLLM/Ollama/remote fallback to substitute for it, by design.**

The Prompt API is a real-Chrome-only surface: it requires a Chrome channel and OS combination with the on-device model component, `chrome://flags/#prompt-api-for-chrome-extension` (or the equivalent origin trial) enabled, and — on first use — a multi-hundred-megabyte one-time model download completed and cached. None of that is present in this session:

- This implementation ran in a sandboxed Linux dev container with no interactive Chrome UI session — `chrome://flags` cannot be set, and no prior download exists to inherit.
- The project's own e2e suite (`tests/e2e/`, Playwright against a real, automation-launched Chromium) was run as part of this phase's verification and passed all 25 specs, but Playwright's bundled Chromium build does not ship the on-device model component `LanguageModel` depends on — `tests/unit/prompt-api.spec.ts` confirms via `chrome.runtime.sendMessage({type:'PROMPT_API_AVAILABILITY'})` returning `'unavailable'` unless `LanguageModel` is mocked, which is exactly what that suite does instead of a live measurement.
- `Docs/planning/baseline_phase1.md` (Phase 1's own SC-11 baseline) independently documents this same session having no usable local model backend at all — WebGPU compute-shader compilation fails on the sandbox's software GPU adapter, and Ollama's CORS policy rejects `chrome-extension://` origins without root access this session doesn't have. Nothing about that changed for this phase.

**What WAS verified, mechanically, in place of a live measurement:**

| Property | How | Result |
|---|---|---|
| `CHAINS.inline` has no remote engine in either posture | `tests/unit/router.spec.ts`, `tests/unit/inline.spec.ts` | ✅ passes — structural, not timing-dependent |
| `DEBOUNCE_MS`/`MIN_CHARS`/`MAX_TOKENS` are the §9 values (300/12/24) | `lib/ui/autocomplete-manager.ts` source | ✅ set as specified |
| A password field never triggers a request | `tests/unit/inline.spec.ts` | ✅ passes |
| `innerHTML` appears nowhere in the file | `tests/unit/inline.spec.ts` (greps the source) | ✅ passes |
| The warm-base-session + `clone()`-per-request mechanism (the ≥95% hit-rate mechanism itself) | `tests/unit/prompt-api.spec.ts`, driving the REAL `entrypoints/offscreen/main.ts` handlers against a mocked `LanguageModel` | ✅ 1 `create()` shared across 3 sequential requests with the same system prompt (3 clones, 1 create) |
| `availability() === 'downloadable'` returns `ENGINE_DOWNLOADING` without blocking | `tests/unit/prompt-api.spec.ts` | ✅ passes, < 200ms |
| An in-flight request aborts within the message round trip | `tests/unit/prompt-api.spec.ts` | ✅ passes |

None of this substitutes for the actual question Q6 asks — **which local model gives the best inline quality within 400ms, measured from the content script, including both message hops, on a 200-completion hand-graded acceptance set** — which requires a real Chrome build with the Prompt API enabled and (for a genuine comparison) WebLLM candidates actually downloaded and loaded. That measurement did not happen this session.

## What ships as the default anyway, and why

`lib/model/engines/webllm.ts`'s `DEFAULT_JUDGE_MODEL` (`Qwen2.5-1.5B-Instruct-q4f32_1-MLC`) is reused as the de facto inline fallback reference point only in the sense that it is the smallest, fastest model already in `WEBGPU_MODELS` — but the **inline tier's actual engine is the Prompt API, never WebLLM** (§3.7.22), so this is not a real Q6 answer, just the closest analog available for a future comparison run.

**No shipped default is named for Q6.** The router routes inline traffic to whichever model the Prompt API's own on-device component is, which is Chrome's choice, not this product's — there is nothing to default *between*. Q6, as literally asked (comparing candidate models), does not have an object to compare on the inline tier's actual, single-engine design; it would apply if a future revision widened inline to compare Prompt-API-model-variants (not offered by the API) or reconsidered WebLLM as an inline fallback (which §3.7.22 and the router's boundary assertion currently forbid by design).

## Re-running this for real

1. On a real Chrome Dev/Canary build with `chrome://flags/#optimization-guide-on-device-model` and the Prompt API flag enabled, and the on-device model already downloaded (`chrome://components`, "Optimization Guide On Device Model").
2. Load the unpacked extension (`npm run build`, then load `.output/chrome-mv3`).
3. Grant a real origin, type into a real field, and record round-trip latency from the content script's own `performance.now()` bracketing the `chrome.runtime.sendMessage` call in `lib/ui/autocomplete-manager.ts`, across a real 200-completion set, hand-graded for acceptance.
4. Update this file's table with p50/p95 and the acceptance rate, and name a default if a genuine comparison becomes possible.
