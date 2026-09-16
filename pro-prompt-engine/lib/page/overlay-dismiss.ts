/**
 * Overlay dismissal — OBSCURED recovery. Content script only.
 * Docs/planning/phase_6_recovery_journal_reporting.md §3.2.
 *
 * `OBSCURED` is the most common recoverable failure on the real web, and it
 * is nearly always a cookie banner, a newsletter modal, or a chat widget.
 * This module makes exactly ONE attempt to clear whatever is covering the
 * target and reports what happened — the caller (lib/agent/tab-agent.ts)
 * decides what to do next via lib/agent/recovery.ts, never this file.
 *
 * Three hard constraints, each of which exists because violating it is
 * worse than the obstruction:
 *
 * 1. Only elements INSIDE the obscuring element are considered. Searching
 *    the whole page for something named "Accept" would find the form's own
 *    submit button.
 * 2. The dismissal candidate is passed through classifyClick() and must
 *    come back Low. A banner whose only button is "Accept and subscribe"
 *    is Medium or Always, and dismissing it is not a free action — the
 *    caller asks instead.
 * 3. One attempt, enforced by this function never looping or being called
 *    twice for the same occurrence by its caller. Two obscuring layers is
 *    a page that does not want to be automated.
 */
import { classifySensitive } from '@lib/page/sensitive';
// [Phase 6 bundle-size fix] classifyClick alone, from the PURE module —
// never '@lib/policy/tiers' itself, whose hasUnsavedUserInput() pulls in
// lib/policy/ownership.ts + lib/agent/journal.ts (and, through journal.ts,
// the whole Dexie database singleton) — see tier-classify.ts's header.
import { classifyClick } from '@lib/policy/tier-classify';
import { computeRole } from '@lib/page/roles';
import { accessibleName } from '@lib/page/accname';
import type { LedgerDescriptor } from '@lib/types/agent.types';

export type DismissOutcome =
  | { dismissed: true; strategy: 'escape' | 'named-dismiss' | 'aria-close' | 'native-dialog' }
  | { dismissed: false; reason: 'no_obscurer' | 'no_candidate' | 'not_low_tier' | 'still_obscured' };

// Ordered by how unambiguous the word is — "close"/"×" before "continue",
// which some pages also use for a form's own submit button (mitigated by
// constraint 1: this regex is only ever tested against candidates already
// scoped to the obscuring element).
const DISMISS_WORD_RE = new RegExp(
  '^(accept( all)?|allow all|got it|ok|okay|agree|i agree|continue|close|dismiss|'
  + 'no thanks|not now|maybe later|skip|×|✕)$',
  'i',
);

function isObscuredAt(cx: number, cy: number, target: Element): boolean {
  const top = document.elementFromPoint(cx, cy);
  if (!top) return true;
  return !(top === target || target.contains(top) || top.contains(target));
}

/**
 * Walks up from whatever elementFromPoint found to the nearest ancestor
 * that looks like a standalone overlay (fixed/sticky positioned, or a
 * <dialog>) — so "inside the obscuring element" means the whole banner,
 * not just the one leaf node the point happened to land on. Bounded to 6
 * ancestors so a page with no such ancestor falls back to the leaf itself
 * rather than climbing to <body>, which would defeat constraint 1 entirely.
 */
function obscurerAt(cx: number, cy: number, target: Element): HTMLElement | null {
  const top = document.elementFromPoint(cx, cy);
  if (!top || top === target || target.contains(top)) return null;
  let el: HTMLElement | null = top as HTMLElement;
  for (let i = 0; i < 6 && el; i++) {
    if (el.tagName === 'DIALOG') return el;
    const style = getComputedStyle(el);
    if (style.position === 'fixed' || style.position === 'sticky') return el;
    el = el.parentElement;
  }
  return top as HTMLElement;
}

function findNamedDismiss(obscurer: HTMLElement): HTMLElement | null {
  const candidates = obscurer.querySelectorAll<HTMLElement>(
    'button, a, [role="button"], input[type="button"], input[type="submit"]',
  );
  for (const c of candidates) {
    if (DISMISS_WORD_RE.test(accessibleName(c).trim())) return c;
  }
  return null;
}

function findAriaClose(obscurer: HTMLElement): HTMLElement | null {
  return obscurer.querySelector<HTMLElement>(
    '[aria-label*="close" i], [aria-label*="dismiss" i], button.close, [data-dismiss]',
  );
}

function findNativeDialog(obscurer: HTMLElement): HTMLDialogElement | null {
  return obscurer.closest('dialog') as HTMLDialogElement | null;
}

const STRATEGIES: Array<{
  name: 'named-dismiss' | 'aria-close' | 'native-dialog';
  find: (o: HTMLElement) => HTMLElement | null;
}> = [
  { name: 'named-dismiss', find: findNamedDismiss },
  { name: 'aria-close', find: findAriaClose },
  { name: 'native-dialog', find: findNativeDialog },
];

/** Classifies a dismiss candidate the same way the gate would (constraint
 *  2) — a minimal LedgerDescriptor built from the live node, since the
 *  candidate was never part of any snapshot and has no handle of its own. */
function isLowTier(el: HTMLElement, origin: string): boolean {
  if (classifySensitive(el) !== null) return false;
  const desc: LedgerDescriptor = {
    role: computeRole(el),
    name: accessibleName(el),
    inputType: el instanceof HTMLInputElement ? (el.getAttribute('type') || 'text').toLowerCase() : undefined,
    ordinal: 0,
    actionable: true,
    href: el instanceof HTMLAnchorElement ? el.href : undefined,
    sensitiveKind: null,
  };
  return classifyClick(desc, origin) === 'low';
}

/**
 * The whole recovery, for one OBSCURED occurrence. `target` is the element
 * the plan step actually wants; `origin` is the run's current origin, for
 * tier classification. Escape is dispatched first as a courtesy (dismisses
 * many modals with no click at all) and its effect is checked before any
 * click is attempted, per §3.2.
 */
export function attemptDismiss(target: Element, origin: string): DismissOutcome {
  const r = target.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  if (!isObscuredAt(cx, cy, target)) return { dismissed: true, strategy: 'escape' };

  const obscurer = obscurerAt(cx, cy, target);
  if (!obscurer) return { dismissed: false, reason: 'no_obscurer' };

  for (const strategy of STRATEGIES) {
    const candidate = strategy.find(obscurer);
    if (!candidate) continue;
    if (!isLowTier(candidate, origin)) return { dismissed: false, reason: 'not_low_tier' };

    if (strategy.name === 'native-dialog') (candidate as HTMLDialogElement).close();
    else candidate.click();

    return isObscuredAt(cx, cy, target)
      ? { dismissed: false, reason: 'still_obscured' }
      : { dismissed: true, strategy: strategy.name };
  }
  return { dismissed: false, reason: 'no_candidate' };
}
