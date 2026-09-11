/**
 * Never-rules — sensitive kinds and origins with no override path.
 * Docs/planning/phase_3_gate_actuation_verification.md §5.4.
 *
 * There is no override path, and that is enforced structurally, not by
 * convention: lib/policy/tiers.ts's classifyTier() returns 'never' from its
 * first branch, before any parameter, mode, site policy, or approval state
 * is even read. gate() refuses NEVER_TIER immediately at check 5 — no later
 * check can un-refuse it.
 */
import type { SensitiveKind } from '@lib/page/sensitive';

export const NEVER_KINDS: ReadonlySet<Exclude<SensitiveKind, null | 'file' | 'hidden'>> =
  new Set(['password', 'payment', 'otp']);

// Origins where ANY mutating verb is Never for MVP. Not a blocklist of bad
// sites — a list of domains where an agent mistake is not recoverable by
// the user.
const SENSITIVE_ORIGIN_RE = [
  /\b(bank|banking|creditunion|paypal|stripe|wise|revolut|venmo)\b/i,
  /\.(bank|insurance)$/i,
  /\b(gov|gouv|gob|gc\.ca|gov\.uk|nic\.in|govt\.nz)\b/i,        // government
  /\b(nhs|health|patient|medicare|medicaid|epic|mychart)\b/i,   // health
];

/**
 * Verbs that write a value directly, with no structural or name-based
 * read-only signal of their own to lean on (unlike `click`, which
 * lib/policy/tiers.ts's classifyClick() already reasons about per-target,
 * and `navigate`, which escalates on unsaved input — §5.3). On a sensitive
 * origin these are always Always, never their normal tier — SPEC NOTE: the
 * phase doc's own §5.1 sketch has this branch returning 'never' unqualified
 * for "MUTATING_VERBS", which would make every click on gov.uk permanently
 * un-actionable with no approval path. That contradicts §5.4's own prose
 * ("a run on gov.uk cannot fill a form WITHOUT APPROVAL on every mutating
 * action" — friction, not impossibility) and the J-1 scenario the whole
 * document uses as its running example. 'never' is reserved for the three
 * NEVER_KINDS fields, where there genuinely is no recoverable path; a
 * sensitive *origin* gets the same Always-tier approval gate every other
 * consequential action gets. See Docs/planning/phase_3_gate_actuation_verification.md §5.4.
 */
export const SENSITIVE_ORIGIN_ALWAYS_VERBS: ReadonlySet<string> = new Set(['type', 'select']);

export function isSensitiveOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return SENSITIVE_ORIGIN_RE.some((re) => re.test(host));
}
