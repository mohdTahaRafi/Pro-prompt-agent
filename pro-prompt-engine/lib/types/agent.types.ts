/**
 * Agent types — the gate, tier and verification type set.
 * Docs/planning/phase_3_gate_actuation_verification.md.
 *
 * Everything here is a plain data shape shared across a context boundary
 * (service worker ↔ content script ↔ options page), so nothing here is a
 * class and nothing here carries behaviour — see lib/utils/result.ts's
 * header for why.
 */
import type { SensitiveKind } from '@lib/page/sensitive';

// ── Risk tier — §5 ──

export type Tier = 'low' | 'medium' | 'always' | 'never';

// ── Refusal codes — §4.3 ──

export type RefusalCode =
  | 'UNKNOWN_RUN'
  | 'TAB_NOT_IN_ROSTER'
  | 'TAB_GONE'
  | 'OUT_OF_SCOPE'
  | 'UNKNOWN_HANDLE'
  | 'HANDLE_NOT_OWNED'
  | 'STALE_EPOCH'
  | 'MALFORMED_ACTION'
  | 'NOT_YET_IMPLEMENTED'
  | 'CAPABILITY_NOT_GRANTED'
  | 'NEVER_TIER'
  | 'RUN_STATE'
  | 'STOPPED';

/** The user-facing sentence for each refusal code — §4.3's right-hand
 *  column. `{origin}` is interpolated by formatRefusal() below. */
export const REFUSAL_COPY: Record<RefusalCode, string> = {
  UNKNOWN_RUN: 'That run no longer exists.',
  TAB_NOT_IN_ROSTER: 'That tab is no longer part of this task.',
  TAB_GONE: 'That tab is no longer part of this task.',
  OUT_OF_SCOPE: "Pro Prompt isn't allowed on {origin}. Grant it first.",
  UNKNOWN_HANDLE: 'That element is no longer on the page.',
  HANDLE_NOT_OWNED: 'That element belongs to a different tab.',
  STALE_EPOCH: 'The page changed; re-reading it.',
  MALFORMED_ACTION: 'That instruction could not be understood.',
  NOT_YET_IMPLEMENTED: "I can't do that yet.",
  CAPABILITY_NOT_GRANTED: 'This site is allowed to be read but not changed.',
  NEVER_TIER: 'I will never type into a password, payment, or one-time-code field.',
  RUN_STATE: 'The task is paused.',
  STOPPED: 'Stopped.',
};

/** Renders a refusal code into the §4.3 user-facing sentence, interpolating
 *  the origin where the copy calls for one. Kept separate from
 *  lib/policy/gate.ts so the gate itself stays a pure decision — the
 *  presentation layer (entrypoints/options/App.tsx's Copilot panel) is what
 *  turns a code into words. */
export function formatRefusal(code: RefusalCode, ctx: { origin?: string } = {}): string {
  return REFUSAL_COPY[code].replace('{origin}', ctx.origin ?? 'this site');
}

// ── Actuator / backend failure causes — §6.3, §7.2 ──

export type FailureCause =
  | 'STOPPED'
  | 'TARGET_MISSING'
  | 'TARGET_AMBIGUOUS'
  | 'TARGET_DISABLED'
  | 'OBSCURED'
  | 'NEVER_TIER_AT_ACTUATOR'
  | 'WRITE_REJECTED'
  | 'PARTIAL_EFFECT';

/** Errors an ActuationBackend's attach/detach/perceive/capture can produce —
 *  distinct from FailureCause, which is what act() (a permitted, in-flight
 *  action) can fail with. */
export type BackendError =
  | 'TARGET_MISSING'
  | 'INVALID_SNAPSHOT'
  | 'PERCEPTION_TOO_LARGE'
  | 'NOT_IMPLEMENTED';

// ── Approval — §9 ──

export interface ApprovalPrompt {
  action: string;        // `Click "Submit application"`
  target: string;        // the accessible name, or "role ordinal" if unnamed
  site: string;           // hostname
  consequence: string;    // a SPECIFIC sentence, never generic (PR-APR-3/4)
  tier: 'always';
}

// ── Gate decision — §4.2 ──

// `needsApproval` is declared (optional, `false`) on every variant so it is
// a usable discriminant across the whole union — `if (decision.needsApproval)`
// narrows cleanly without an `in` guard at every call site.
export type ActionDecision =
  | { permitted: false; needsApproval?: false; code: RefusalCode }
  | { permitted: false; needsApproval: true; tier: Tier; prompt: ApprovalPrompt }
  | { permitted: true; needsApproval?: false; tier: Tier };

// ── Ownership ledger descriptor — §4.4 ──

/** What the shadow ledger remembers about one handle. A reduced,
 *  independently-derived copy of the snapshot descriptor — see §4.4's "why
 *  the ledger duplicates the descriptor". */
export interface LedgerDescriptor {
  role: string;
  name: string;
  inputType?: string;
  ordinal: number;
  formId?: string;
  actionable: boolean;
  valueShape?: string;
  href?: string;
  sensitiveKind: SensitiveKind;
}

// ── Verification — §7 ──

export type VerificationKind =
  | 'state' | 'appearance' | 'disappearance' | 'location' | 'count' | 'negative'
  | 'semantic' | 'traceability';   // declared now, Phase 4 judge tier fills them in (§7.3)

/** Three values, by design. There is no fourth for "we assume so"
 *  (PR-VER-7, PP-5). */
export type Verified = 'confirmed' | 'unconfirmed' | 'failed';

export interface VerificationResult {
  verified: Verified;
  check: VerificationKind;
  evidence?: { before?: string; after?: string; detail?: string };
  failureCause?: FailureCause;
}
