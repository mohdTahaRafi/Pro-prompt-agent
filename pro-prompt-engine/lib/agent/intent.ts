/**
 * Intent resolver — THROWAWAY. Docs/planning/phase_3_gate_actuation_verification.md §11.
 *
 * Maps the Copilot panel's free-typed instruction to an Action,
 * deterministically, with no model. Phase 5 deletes this file and replaces
 * it with planner.ts + step-resolver.ts. It exists only so the single-action
 * copilot (this phase) has something to press "Go" against.
 */
import type { Action } from '@lib/schemas/action.schema';
import type { ElementDescriptor, PerceptionSnapshot } from '@lib/schemas/snapshot.schema';

export type IntentResult =
  | { kind: 'action'; action: Action }
  | { kind: 'ambiguous'; candidates: ElementDescriptor[] }
  | { kind: 'unmatched' };

type ByNameResult =
  | { kind: 'one'; el: ElementDescriptor }
  | { kind: 'ambiguous'; candidates: ElementDescriptor[] }
  | { kind: 'none' };

/** Matches by exact accessible name first, then case-insensitive, then a
 *  unique substring. Two matches at any stage means it asks — never
 *  guesses (§11, the same product decision the agent makes from Phase 6). */
function byName(s: PerceptionSnapshot, name: string, roles: string[]): ByNameResult {
  const pool = s.elements.filter((e) => roles.includes(e.role) && e.actionable);

  const exact = pool.filter((e) => e.name === name);
  if (exact.length === 1) return { kind: 'one', el: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact };

  const lower = name.toLowerCase();
  const ci = pool.filter((e) => e.name.toLowerCase() === lower);
  if (ci.length === 1) return { kind: 'one', el: ci[0] };
  if (ci.length > 1) return { kind: 'ambiguous', candidates: ci };

  const sub = pool.filter((e) => e.name.toLowerCase().includes(lower));
  if (sub.length === 1) return { kind: 'one', el: sub[0] };
  if (sub.length > 1) return { kind: 'ambiguous', candidates: sub };

  return { kind: 'none' };
}

function fromByName(r: ByNameResult, toAction: (el: ElementDescriptor) => Action): IntentResult {
  if (r.kind === 'one') return { kind: 'action', action: toAction(r.el) };
  if (r.kind === 'ambiguous') return { kind: 'ambiguous', candidates: r.candidates };
  return { kind: 'unmatched' };
}

type Pattern = (m: RegExpMatchArray, s: PerceptionSnapshot) => IntentResult;

const PATTERNS: Array<[RegExp, Pattern]> = [
  [/^click (?:the )?["“]?(.+?)["”]?(?: button| link)?$/i,
    (m, s) => fromByName(byName(s, m[1], ['button', 'link', 'menuitem', 'tab', 'checkbox']),
      (el) => ({ verb: 'click', handle: el.handle }))],

  [/^type ["“](.+?)["”] (?:in|into) (?:the )?["“]?(.+?)["”]?(?: field| box)?$/i,
    (m, s) => fromByName(byName(s, m[2], ['textbox', 'searchbox', 'combobox']),
      (el) => ({ verb: 'type', handle: el.handle, text: m[1], mode: 'replace' }))],

  [/^select ["“](.+?)["”] (?:in|from) (?:the )?["“]?(.+?)["”]?$/i,
    (m, s) => fromByName(byName(s, m[2], ['combobox', 'listbox']),
      (el) => ({ verb: 'select', handle: el.handle, value: m[1] }))],

  [/^scroll (down|up|to the (top|bottom))$/i,
    (m) => {
      const dir = m[1] === 'down' ? 'down' : m[1] === 'up' ? 'up' : (m[2] as 'top' | 'bottom');
      return { kind: 'action', action: { verb: 'scroll', target: dir } };
    }],

  [/^go (back|forward)$/i,
    (m) => ({ kind: 'action', action: { verb: m[1] === 'back' ? 'history_back' : 'history_forward' } })],

  [/^(?:go to|open) (https?:\/\/\S+)$/i,
    (m) => ({ kind: 'action', action: { verb: 'navigate', url: m[1] } })],

  [/^read (?:the )?(page|structure)$/i,
    (m) => ({ kind: 'action', action: m[1] === 'page' ? { verb: 'read_page' } : { verb: 'read_structure' } })],
];

/** No model, no guess. Unmatched text is reported, never silently dropped
 *  — the panel shows exactly what verbs are available. */
export function resolveIntent(text: string, snapshot: PerceptionSnapshot): IntentResult {
  const trimmed = text.trim();
  for (const [re, handler] of PATTERNS) {
    const m = trimmed.match(re);
    if (m) return handler(m, snapshot);
  }
  return { kind: 'unmatched' };
}

export const UNMATCHED_COPY =
  "I understood that as an instruction I don't have a way to perform. I can click, type, "
  + 'select, scroll, navigate, go back and forward, and read.';
