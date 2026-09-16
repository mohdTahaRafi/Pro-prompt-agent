/**
 * Tier classification — the PURE half of lib/policy/tiers.ts, split out
 * here [Phase 6] so a content-script module (lib/page/overlay-dismiss.ts)
 * can classify a dismiss candidate's click tier (§3.2 constraint 2)
 * WITHOUT dragging lib/policy/ownership.ts and lib/agent/journal.ts — and
 * through journal.ts, the entire Dexie database singleton — into the
 * content-script bundle. tiers.ts's own hasUnsavedUserInput() genuinely
 * needs those (it queries the journal), so it could not simply be trimmed;
 * splitting the file was the actual fix, not a budget bump, once
 * tests/unit/bundle-size.spec.ts caught the Dexie singleton's constructor
 * (a real module-scope side effect — `export const db = new ProPromptDB()`
 * — that no tree-shaker can remove) leaking into content-scripts/agent.js
 * via this one function's transitive imports.
 *
 * lib/policy/tiers.ts re-exports classifyTier/classifyClick from here
 * UNCHANGED, so lib/policy/gate.ts and every existing test keep importing
 * from '@lib/policy/tiers' with no changes at all — only a NEW importer
 * that must avoid the ownership/journal half (overlay-dismiss.ts) reaches
 * into this file directly.
 *
 * Docs/planning/phase_3_gate_actuation_verification.md §5.
 */
import type { Action } from '@lib/schemas/action.schema';
import type { LedgerDescriptor, Tier } from '@lib/types/agent.types';
import { isSensitiveOrigin, NEVER_KINDS, SENSITIVE_ORIGIN_ALWAYS_VERBS } from '@lib/policy/never-rules';

export function classifyTier(action: Action, target: LedgerDescriptor | null, origin: string): Tier {
  // ── NEVER, first and unconditionally. No later branch can lower this. ──
  if (target && target.sensitiveKind && NEVER_KINDS.has(target.sensitiveKind as 'password' | 'payment' | 'otp')) {
    return 'never';
  }

  // ── Sensitive-origin escalation for verbs with no target-level signal of
  //    their own (§5.4's SENSITIVE_ORIGIN_ALWAYS_VERBS note). ──
  if (isSensitiveOrigin(origin) && SENSITIVE_ORIGIN_ALWAYS_VERBS.has(action.verb)) {
    return 'always';
  }

  switch (action.verb) {
    case 'read_page':
    case 'read_structure':
    case 'read_element':
    case 'wait_for_settle':
    case 'scroll':
      return 'low';

    case 'click':
      return classifyClick(target, origin);

    case 'type':
      // Medium if it REPLACES text the user wrote; Low if the field is empty.
      if (action.mode === 'replace' && target?.valueShape && target.valueShape !== 'empty') {
        return 'medium';
      }
      return 'low';

    case 'select':
      return 'medium';

    case 'navigate':
      return 'medium';   // → 'always' if unsaved input; see lib/policy/tiers.ts's hasUnsavedUserInput

    case 'history_back':
    case 'history_forward':
      return 'medium';

    default:
      return 'low';
  }
}

// ── §5.2 classifyClick — the whole difficulty in one function ──

const ALWAYS_NAME_RE = new RegExp(
  '\\b(submit|send|post|publish|buy|purchase|order|pay|checkout|' +
  'place[\\s-]?order|confirm[\\s-]?(and|&)?[\\s-]?pay|delete|remove[\\s-]?account|' +
  'deactivate|close[\\s-]?account|cancel[\\s-]?(subscription|order|booking)|' +
  'apply[\\s-]?now|book[\\s-]?now|transfer|withdraw|donate|subscribe|unsubscribe|' +
  'accept[\\s-]?(offer|terms)|sign[\\s-]?(contract|agreement)|reply|comment|share|' +
  'invite|report|block|unfriend|leave[\\s-]?(group|review))\\b',
  'i',
);

function toOriginSafe(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

export function classifyClick(t: LedgerDescriptor | null, origin: string): Tier {
  if (!t) return 'medium';   // unknown target: never Low

  // 1. A submit control inside a form is Always, whatever it is called.
  //    This is the structural signal and it outranks the name.
  if (t.inputType === 'submit' || t.inputType === 'image') return 'always';
  if (t.role === 'button' && t.inputType === 'submit' && t.formId) return 'always';

  // 2. Name-based classification for controls that are not form submits —
  //    the "Send" button of a JS-driven composer has no <form> at all.
  if (ALWAYS_NAME_RE.test(t.name)) return 'always';

  // 3. Sensitive origins: any click that is not provably a read is Always.
  if (isSensitiveOrigin(origin)) return 'always';

  // 4. Links that leave the origin are Medium — they leave the run's context.
  if (t.role === 'link' && t.href) {
    const linkOrigin = toOriginSafe(t.href);
    if (linkOrigin && linkOrigin !== origin) return 'medium';
  }

  // 5. Everything else — a tab, a disclosure toggle, a filter, a menu item —
  //    is trivially undone and is Low.
  return 'low';
}
