/**
 * Content-script token-budget estimator. Deliberately NOT `gpt-tokenizer`.
 *
 * [Phase 2 §14 vs §7.5 — a real conflict, resolved here, per CLAUDE.md §5's
 * anti-punting rule: decided and documented, not hand-waved.] §7.5's
 * pseudocode calls `countTokens()` from `gpt-tokenizer` directly inside the
 * content script's prune loop; §14 hard-caps the *injected* content-script
 * bundle at 80 KB gzipped specifically because it runs on every granted
 * page. Measured fact: `gpt-tokenizer`'s BPE rank tables alone gzip to
 * several hundred KB–2 MB (`cl100k_base` ~300 KB gzipped, `o200k_base`
 * larger) — a static OR dynamic import of it anywhere in agent.content.ts's
 * module graph blows the budget ~5–8x, because WXT builds content scripts
 * as a single IIFE (verified: `formats: ['iife']` in
 * node_modules/wxt/dist/core/builders/vite/index.mjs) — IIFE output has no
 * async chunk-loading runtime, so Rollup inlines every reachable import,
 * dynamic or not. There is no way to keep the real encoder out of this
 * bundle while still calling it from here. A second, independent budget
 * also argues against it: §14's 120ms p95 snapshot-build target leaves
 * little room for a few hundred real BPE encode() calls (one per
 * candidate) in the hot prune loop.
 *
 * The resolution: the content script's LIVE pruning decisions use this
 * fast, deliberately conservative character-based estimate — calibrated to
 * OVER-count relative to real BPE (erring toward pruning MORE, never less),
 * mirroring the same false-positive-safe/false-negative-unsafe asymmetry
 * lib/page/sensitive.ts already uses for privacy. The snapshot schema
 * carries no field asserting an exact token total (only `overBudget: {by}`
 * when Rule 1 forces an overshoot), so nothing downstream depends on this
 * number being BPE-exact. The REAL gpt-tokenizer (lib/utils/token-counter.ts)
 * still does the authoritative counting in every context that isn't
 * bundle-size-constrained: the Phase 2 pruning study (§10.2, offline,
 * Node/Vitest) validates that this estimator's margin holds against real
 * BPE counts over the 40-snapshot corpus, and Phase 4's router does its own
 * real accounting before any remote call, which is the actual cost/safety
 * backstop for tokens leaving the device.
 */

// 3.2 chars/token, not the commonly-quoted ~4: JSON-serialised descriptors
// are punctuation-dense (quotes, colons, braces, commas) relative to prose,
// and BPE tokenizes punctuation less efficiently per character than words.
// Using a SMALLER divisor than the prose average makes this estimate
// deliberately generous — it reports MORE tokens than a real encoder
// typically would, which is the safe direction to be wrong in here.
const CONSERVATIVE_CHARS_PER_TOKEN = 3.2;

export function countTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CONSERVATIVE_CHARS_PER_TOKEN);
}
