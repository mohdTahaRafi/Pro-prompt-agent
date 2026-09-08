/**
 * The single sensitive-field classifier — content script; pure, synchronous,
 * no I/O.
 *
 * Two deliberate biases, stated because they have costs.
 *
 * False positives are acceptable; false negatives are not. A field named
 * account_number that is really a customer reference gets excluded, and the
 * agent reports it as something only the user can fill. That is a lost
 * capability. A payment field that is not excluded is a hard-gate violation
 * (architecture.md §3.8). The asymmetry is total, so the classifier errs
 * wide and the report explains the exclusion rather than hiding it.
 *
 * It is a heuristic over authored markup and can be defeated by a page that
 * wants to. A site that labels its password field favourite_colour will not
 * be caught. That is why exclusion is layer one of five (§3.7.23) and not
 * the whole defence, and it is why PR-SEC-16 forbids ever describing this as
 * immunity.
 *
 * Created in Phase 1 because three consumers need it immediately: the
 * snippet manager (lib/ui/snippet-manager.ts), the Phase 2 perception layer,
 * and the Phase 4 autocomplete rebuild.
 * See Docs/planning/phase_1_foundation_preconditions.md §6.
 */

export type SensitiveKind = 'password' | 'payment' | 'otp' | 'file' | 'hidden' | null;

const SENSITIVE_INPUT_TYPES = new Set(['password']);

const SENSITIVE_AUTOCOMPLETE = new Set([
  // WHATWG autofill tokens that identify payment and credential fields.
  'current-password', 'new-password', 'one-time-code',
  'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-type',
  'cc-name', 'cc-given-name', 'cc-family-name',
]);

// Matched against name / id / aria-label / placeholder / the field's <label> text.
const SENSITIVE_NAME_RE =
  /\b(pass(word|wd|phrase)|pwd|cvv|cvc|csc|card[\s_-]?(number|num|no)|cc[\s_-]?num|security[\s_-]?code|otp|one[\s_-]?time|2fa|mfa|auth(entication)?[\s_-]?code|verification[\s_-]?code|pin|iban|sort[\s_-]?code|routing[\s_-]?number|account[\s_-]?number|ssn|social[\s_-]?security|tax[\s_-]?id)\b/i;

export function classifySensitive(el: Element): SensitiveKind {
  if (!(el instanceof HTMLElement)) return null;
  const tag = el.tagName;

  if (tag === 'INPUT') {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute('type') || 'text').toLowerCase();
    if (SENSITIVE_INPUT_TYPES.has(type)) return 'password';
    if (type === 'file') return 'file';              // PR-ACT-8: reported, never filled
    if (type === 'hidden') return 'hidden';

    const ac = (input.getAttribute('autocomplete') || '').toLowerCase();
    // autocomplete may carry section/billing prefixes: "section-a billing cc-number"
    for (const token of ac.split(/\s+/)) {
      if (SENSITIVE_AUTOCOMPLETE.has(token)) {
        return token === 'one-time-code' ? 'otp'
             : token.startsWith('cc-') ? 'payment' : 'password';
      }
    }
    if (input.inputMode === 'numeric' && (input.maxLength === 4 || input.maxLength === 6)
        && SENSITIVE_NAME_RE.test(descriptiveText(el))) return 'otp';
  }

  if (SENSITIVE_NAME_RE.test(descriptiveText(el))) {
    const t = descriptiveText(el);
    if (/otp|one[\s_-]?time|2fa|mfa|verification|auth/i.test(t)) return 'otp';
    if (/cvv|cvc|csc|card|iban|routing|account[\s_-]?number/i.test(t)) return 'payment';
    return 'password';
  }
  return null;
}

/** Everything a human would read as naming this field, concatenated once. */
function descriptiveText(el: HTMLElement): string {
  const parts = [
    el.getAttribute('name'), el.id, el.getAttribute('aria-label'),
    el.getAttribute('placeholder'), el.getAttribute('data-testid'),
    labelTextFor(el),
  ];
  return parts.filter(Boolean).join(' ');
}

/** The text of a <label for="id"> or an ancestor <label> wrapping this field. */
function labelTextFor(el: HTMLElement): string {
  if (el.id) {
    const doc = el.ownerDocument;
    const byFor = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (byFor?.textContent) return byFor.textContent;
  }
  const ariaLabelledBy = el.getAttribute('aria-labelledby');
  if (ariaLabelledBy) {
    const labelEl = el.ownerDocument.getElementById(ariaLabelledBy);
    if (labelEl?.textContent) return labelEl.textContent;
  }
  const wrapping = el.closest('label');
  return wrapping?.textContent || '';
}
