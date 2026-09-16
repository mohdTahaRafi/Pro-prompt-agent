/**
 * lib/page/overlay-dismiss.ts — the three dismissal strategies and three
 * constraints. Docs/planning/phase_6_recovery_journal_reporting.md §3.2,
 * §12 task 6.2.
 *
 * happy-dom performs no real layout — getBoundingClientRect() and
 * elementFromPoint() are stubbed per test, the same technique
 * tests/unit/actuator.spec.ts uses for the same reason (see its header).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { attemptDismiss } from '@lib/page/overlay-dismiss';

const ORIGIN = 'https://shop.example';

function stubRect(el: HTMLElement, rect: Partial<DOMRect> = {}) {
  const full = { x: 0, y: 0, width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30, toJSON() {}, ...rect };
  (el as any).getBoundingClientRect = () => full;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('attemptDismiss — Escape courtesy', () => {
  it('reports dismissed:true via "escape" when the obstruction clears on its own after Escape', () => {
    const target = document.createElement('button');
    target.textContent = 'Continue';
    document.body.appendChild(target);
    stubRect(target);

    let escaped = false;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') escaped = true; });
    (document as any).elementFromPoint = () => (escaped ? target : document.body);

    const result = attemptDismiss(target, ORIGIN);
    expect(result).toEqual({ dismissed: true, strategy: 'escape' });
  });
});

describe('attemptDismiss — named-dismiss (constraint 1: only inside the obscurer)', () => {
  it('a cookie banner covering a button is dismissed via its own "Accept" control, and the button is no longer covered', () => {
    const target = document.createElement('button');
    target.textContent = 'Continue';
    target.id = 'target';
    document.body.appendChild(target);
    stubRect(target);

    const banner = document.createElement('div');
    banner.id = 'banner';
    stubRect(banner, { top: 0, left: 0, width: 300, height: 300, bottom: 300, right: 300 });
    // fixed position so obscurerAt() recognises it as a standalone overlay
    banner.style.position = 'fixed';
    const accept = document.createElement('button');
    accept.textContent = 'Accept all';
    banner.appendChild(accept);
    document.body.appendChild(banner);

    let dismissed = false;
    accept.addEventListener('click', () => { dismissed = true; banner.remove(); });
    (document as any).elementFromPoint = () => (dismissed ? target : accept);

    const result = attemptDismiss(target, ORIGIN);
    expect(result).toEqual({ dismissed: true, strategy: 'named-dismiss' });
    expect(dismissed).toBe(true);
  });

  it('never clicks something OUTSIDE the obscuring element — the page\'s own submit button named "Continue" is never touched', () => {
    // The obscurer's only control is unnamed/irrelevant; a "Continue"
    // button living on the page itself (outside the obscurer) must never
    // be found by named-dismiss, which is scoped via querySelector on the
    // obscurer element alone.
    const target = document.createElement('button');
    target.textContent = 'Target';
    document.body.appendChild(target);
    stubRect(target);

    const pageContinue = document.createElement('button');
    pageContinue.textContent = 'Continue';
    let pageContinueClicked = false;
    pageContinue.addEventListener('click', () => { pageContinueClicked = true; });
    document.body.appendChild(pageContinue);

    const banner = document.createElement('div');
    banner.style.position = 'fixed';
    stubRect(banner, { width: 300, height: 300 });
    document.body.appendChild(banner);   // no dismiss control inside it at all

    (document as any).elementFromPoint = () => banner;

    const result = attemptDismiss(target, ORIGIN);
    expect(result).toEqual({ dismissed: false, reason: 'no_candidate' });
    expect(pageContinueClicked).toBe(false);
  });
});

describe('attemptDismiss — constraint 2: tier classification', () => {
  it('a dismiss-worded control on a sensitive origin (never Low there, §5.2 rule 3) is refused, not clicked', () => {
    // DISMISS_WORD_RE only matches short, generic dismissal words (accept,
    // ok, continue, close, ...) — none of which overlap with
    // lib/policy/tiers.ts's own ALWAYS_NAME_RE danger-word list, so a
    // realistic "not actually free to click" candidate here comes from the
    // ORIGIN escalation (classifyClick rule 3: any click on a sensitive
    // origin is Always), not from the button's own name.
    const BANK_ORIGIN = 'https://my-bank.example';   // \b(bank)\b needs a boundary before "bank"
    const target = document.createElement('button');
    target.textContent = 'Continue';
    document.body.appendChild(target);
    stubRect(target);

    const banner = document.createElement('div');
    banner.style.position = 'fixed';
    stubRect(banner, { width: 300, height: 300 });
    const accept = document.createElement('button');
    accept.textContent = 'Accept';   // matches DISMISS_WORD_RE — a real candidate
    let clicked = false;
    accept.addEventListener('click', () => { clicked = true; });
    banner.appendChild(accept);
    document.body.appendChild(banner);

    (document as any).elementFromPoint = () => banner;

    const result = attemptDismiss(target, BANK_ORIGIN);
    expect(result).toEqual({ dismissed: false, reason: 'not_low_tier' });
    expect(clicked).toBe(false);
  });
});

describe('attemptDismiss — constraint 3: one attempt', () => {
  it('a second obscuring layer after the click is reported as still_obscured, never retried internally', () => {
    const target = document.createElement('button');
    target.textContent = 'Continue';
    document.body.appendChild(target);
    stubRect(target);

    const banner = document.createElement('div');
    banner.style.position = 'fixed';
    stubRect(banner, { width: 300, height: 300 });
    const accept = document.createElement('button');
    accept.textContent = 'Close';
    let clickCount = 0;
    accept.addEventListener('click', () => { clickCount += 1; });
    banner.appendChild(accept);
    document.body.appendChild(banner);

    // elementFromPoint NEVER reports the target free — a second layer
    // remains no matter what happened.
    (document as any).elementFromPoint = () => banner;

    const result = attemptDismiss(target, ORIGIN);
    expect(result).toEqual({ dismissed: false, reason: 'still_obscured' });
    expect(clickCount).toBe(1);   // exactly one click attempt, never a retry loop
  });
});

describe('attemptDismiss — no obscurer found at all', () => {
  it('reports no_obscurer when elementFromPoint returns null', () => {
    const target = document.createElement('button');
    document.body.appendChild(target);
    stubRect(target);
    (document as any).elementFromPoint = () => null;
    expect(attemptDismiss(target, ORIGIN)).toEqual({ dismissed: false, reason: 'no_obscurer' });
  });
});
