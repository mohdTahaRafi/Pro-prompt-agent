# Phase 1 Baseline — SC-11

**Machine:** Linux mightylord77-IdeaPad-Slim-5-14IMH9 7.0.0-28-generic #28~24.04.1-Ubuntu SMP PREEMPT_DYNAMIC Wed Jul  1 15:50:57 UTC 2 x86_64 x86_64 x86_64 GNU/Linux

**Browser:** Google Chrome 144.0.7559.96

**Runs per cell:** 2

Recorded BEFORE this phase's changes land (§9.3). Phase 8 must stay within +150ms of this datum; this phase's own budget is +50ms (§13).

## Sandbox findings

Every "not measured" row below has a real, reproduced root cause — none are a blanket "no provider available":

- **webgpu** — a real GPU adapter (SwiftShader, software) is reachable in this sandbox, and the smallest catalog model downloads over a real network in a few seconds. Loading it fails with a real, reproducible WGSL compute-shader compile error from Dawn/SwiftShader (see the WEBGPU_ERROR text below) — a software-WebGPU-backend limitation, not fixable without real GPU hardware.
- **ollama** — `ollama serve` is running with a model pulled. GET /api/tags (this script's own reachability probe, and the extension's GET_PROVIDER_STATUS) succeeds. Real inference (POST /api/chat) 403s: Ollama's own Origin/CORS check rejects `chrome-extension://*` origins unless the server is started with `OLLAMA_ORIGINS` covering them. Fixing this needs root on this machine (`sudo systemctl edit ollama`, add `Environment="OLLAMA_ORIGINS=chrome-extension://*"`, `sudo systemctl restart ollama`) — not available in this session.
- **groq** — no API key is configured anywhere in this sandbox; genuinely unreachable, not a code or config issue.

Separately, a real pre-existing bug was found while diagnosing ollama: `routeInference()` in `lib/adapters/llm-router.ts` (Phase 4 scope) only keeps the *last*-tried provider's error, and groq is always tried last — so any failure in webgpu or ollama surfaces to the caller as "Groq API key not configured" regardless of what actually failed. This script works around it with its own direct GET/POST probes; the app itself still needs that fix in Phase 4.

| Op | Provider | p50 (ms) | p95 (ms) | Successful runs | Notes |
|---|---|---|---|---|---|
| REFACTOR | webgpu | — | — | 0/2 | **not measured** — webgpu not reachable — model load failed: WEBGPU_ERROR: WEBGPU_ERROR: [Invalid ShaderModule (unlabeled)] is invalid due to a previous error.
 - While validating compute stage ([Invalid ShaderModule (unlabeled)], entryPoint: "reshape1_kernel").
 |
| SCORE | webgpu | — | — | 0/2 | **not measured** — webgpu not reachable — model load failed: WEBGPU_ERROR: WEBGPU_ERROR: [Invalid ShaderModule (unlabeled)] is invalid due to a previous error.
 - While validating compute stage ([Invalid ShaderModule (unlabeled)], entryPoint: "reshape1_kernel").
 |
| GENERATE | webgpu | — | — | 0/2 | **not measured** — webgpu not reachable — model load failed: WEBGPU_ERROR: WEBGPU_ERROR: [Invalid ShaderModule (unlabeled)] is invalid due to a previous error.
 - While validating compute stage ([Invalid ShaderModule (unlabeled)], entryPoint: "reshape1_kernel").
 |
| SAVE_CONTEXT | webgpu | — | — | 0/2 | **not measured** — webgpu not reachable — model load failed: WEBGPU_ERROR: WEBGPU_ERROR: [Invalid ShaderModule (unlabeled)] is invalid due to a previous error.
 - While validating compute stage ([Invalid ShaderModule (unlabeled)], entryPoint: "reshape1_kernel").
 |
| REFACTOR | ollama | — | — | 0/2 | **not measured** — ollama: GET /api/tags reachable, but POST /api/chat -> HTTP 403 (likely Ollama's Origin/CORS check rejecting chrome-extension://* — restart ollama with OLLAMA_ORIGINS covering it) |
| SCORE | ollama | — | — | 0/2 | **not measured** — ollama: GET /api/tags reachable, but POST /api/chat -> HTTP 403 (likely Ollama's Origin/CORS check rejecting chrome-extension://* — restart ollama with OLLAMA_ORIGINS covering it) |
| GENERATE | ollama | — | — | 0/2 | **not measured** — ollama: GET /api/tags reachable, but POST /api/chat -> HTTP 403 (likely Ollama's Origin/CORS check rejecting chrome-extension://* — restart ollama with OLLAMA_ORIGINS covering it) |
| SAVE_CONTEXT | ollama | — | — | 0/2 | **not measured** — ollama: GET /api/tags reachable, but POST /api/chat -> HTTP 403 (likely Ollama's Origin/CORS check rejecting chrome-extension://* — restart ollama with OLLAMA_ORIGINS covering it) |
| REFACTOR | groq | — | — | 0/2 | **not measured** — groq not reachable on this machine |
| SCORE | groq | — | — | 0/2 | **not measured** — groq not reachable on this machine |
| GENERATE | groq | — | — | 0/2 | **not measured** — groq not reachable on this machine |
| SAVE_CONTEXT | groq | — | — | 0/2 | **not measured** — groq not reachable on this machine |
