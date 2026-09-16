/**
 * Traceability — is a value actually present in something the run read?
 * Docs/planning/phase_6_recovery_journal_reporting.md §6.3, PR-VER-6, SC-5.
 *
 * A value appears in the report only if a `read_*` event in this run's
 * journal contains it. Exact substring match first; a normalised
 * comparison second (₹28,999 → 28999 — punctuation and case stripped);
 * the judge tier only for the values normalisation leaves genuinely
 * ambiguous (a value with digits that still doesn't match anything).
 * Everything else is untraceable, which is the SAFE default — this module
 * never guesses a value into the report; lib/agent/reporter.ts turns an
 * untraceable value into an excluded claim plus a `Gap`, never a silent
 * pass.
 */

export type TraceVerdict = 'exact' | 'normalized' | 'judged' | 'none';

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9.]/g, '');
}

/** True when `value` normalises identically to some substring shape found
 *  in `corpus` — a full-string containment check on the NORMALISED forms,
 *  which is what survives currency symbols, thousands separators and
 *  case/whitespace differences without needing per-locale formatting
 *  rules. */
function normalizedMatch(value: string, corpus: string[]): boolean {
  const nv = normalize(value);
  if (!nv) return false;
  return corpus.some((t) => normalize(t).includes(nv));
}

/** A judge-tier callback, injected by the caller — reporter.ts supplies a
 *  real one backed by lib/model/router.ts's judge tier in production;
 *  tests supply a deterministic stub. Its ABSENCE is not a crash: an
 *  ambiguous value with no judge available is simply untraceable, the same
 *  safe default as a value the judge itself says is not traceable. */
export type JudgeFn = (value: string, corpus: string[]) => Promise<boolean>;

/** A value counts as "ambiguous" (worth a judge call) only when it carries
 *  digits — the exact category normalisation is meant to rescue (prices,
 *  counts, measurements) — and neither cheaper check already resolved it.
 *  A value with no digits that failed both checks is not ambiguous, it is
 *  simply absent; asking a model would not change that. */
function isAmbiguous(value: string): boolean {
  return /\d/.test(value);
}

export async function traceValue(value: string, corpus: string[], judge?: JudgeFn): Promise<TraceVerdict> {
  const v = value.trim();
  if (!v) return 'none';
  if (corpus.some((t) => t.includes(v))) return 'exact';
  if (normalizedMatch(v, corpus)) return 'normalized';
  if (judge && isAmbiguous(v)) {
    const ok = await judge(v, corpus).catch(() => false);
    return ok ? 'judged' : 'none';
  }
  return 'none';
}

/** Traces every (value, where-it-should-have-come-from) pair, returning
 *  only those found NOT traceable — lib/agent/reporter.ts turns each of
 *  these into a `Gap`, and drops the value from the reported step. */
export async function untraceable(
  claims: Array<{ value: string }>, corpus: string[], judge?: JudgeFn,
): Promise<Set<string>> {
  const misses = new Set<string>();
  for (const claim of claims) {
    // eslint-disable-next-line no-await-in-loop
    const verdict = await traceValue(claim.value, corpus, judge);
    if (verdict === 'none') misses.add(claim.value);
  }
  return misses;
}
