/**
 * Tier classification — verb × target × origin → risk tier.
 * Docs/planning/phase_3_gate_actuation_verification.md §5.
 *
 * classifyTier() and classifyClick() are pure, synchronous, and do no I/O —
 * the gate calls them with data it has already loaded. hasUnsavedUserInput()
 * (§5.3) is the one exception: it is async and reads the ownership ledger
 * and the journal, because "did THIS run write this value" is a question
 * only the journal can answer. The gate calls it directly for the `navigate`
 * verb only, after classifyTier() has already returned its base tier — see
 * the file header note on that function for why the escalation isn't
 * folded into the synchronous switch.
 */
import type { Action } from '@lib/schemas/action.schema';
import type { LedgerDescriptor, Tier } from '@lib/types/agent.types';
import { isSensitiveOrigin, NEVER_KINDS, SENSITIVE_ORIGIN_ALWAYS_VERBS } from '@lib/policy/never-rules';
import * as ownership from '@lib/policy/ownership';
import * as journal from '@lib/agent/journal';

const TEXT_INPUT_TYPES = new Set([
  'text', 'email', 'tel', 'url', 'search', 'number', 'date', 'datetime-local',
  'month', 'week', 'time', 'textarea',
]);

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
      return 'medium';   // → 'always' if unsaved input; see hasUnsavedUserInput below

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

// ── §5.3 navigate and unsaved input ──

/**
 * "Unsaved input" is determined by the gate from the ledger, not by asking
 * the page: any descriptor in the current epoch whose inputType is a text
 * kind and whose valueShape is not 'empty', where that value was NOT
 * written by this run. The journal is the record of what this run wrote,
 * so the check is a journal query, not a heuristic (PR-NAV-3).
 */
export async function hasUnsavedUserInput(runId: number, tabId: number): Promise<boolean> {
  const ledger = await ownership.forTab(runId, tabId);
  if (!ledger) return false;
  const written = new Set(
    (await journal.query(runId, 'action.observed'))
      .filter((e) => (e.data as { verb?: string })?.verb === 'type' && e.tabId === tabId)
      .map((e) => (e.data as { handle?: string }).handle),
  );
  return Object.entries(ledger.handles).some(([h, d]) =>
    TEXT_INPUT_TYPES.has(d.inputType ?? '') && d.valueShape !== 'empty' && !written.has(h));
}
