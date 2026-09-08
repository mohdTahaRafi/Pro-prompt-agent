/**
 * PII Scrubber — Regex-based redaction for sensitive data
 *
 * Applied BEFORE any prompt leaves the browser for Groq cloud.
 * WebGPU & Ollama are local, so they bypass this.
 */

const PII_PATTERNS: Array<{ pattern: RegExp; replacement: string; label: string }> = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[EMAIL_REDACTED]', label: 'email' },
  { pattern: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g, replacement: '[SSN_REDACTED]', label: 'ssn' },
  { pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, replacement: '[CC_REDACTED]', label: 'credit_card' },
  // [Phase 1 §5.7] Narrowed from /\b\d{10,12}\b/g, which matched order ids,
  // unix-ms timestamps and invoice numbers. Requires a phone-shaped separator
  // or an international prefix — a bare eleven-digit run with no separators
  // is more often an identifier than a phone number, and redacting
  // identifiers corrupts the prompt the user actually wrote. This trades
  // recall for precision deliberately: the scrubber is the fourth line of
  // defence (architecture.md §3.7.23), behind exclusion, minimisation and
  // condensation, and is never presented to a user as a guarantee.
  { pattern: /(?:\+\d{1,3}[-.\s]?)?\b\d{3}[-.\s]\d{3,4}[-.\s]\d{4}\b/g, replacement: '[PHONE_REDACTED]', label: 'phone' },
  // International groupings vary (UK: +44 20 7946 0958 is 2-4-4, not the
  // 3-3(or4)-4 shape above) — two to four separator-delimited groups after
  // the country code, each 2-4 digits.
  { pattern: /\+\d{1,3}(?:[-.\s]?\d{2,4}){2,4}\b/g, replacement: '[PHONE_REDACTED]', label: 'phone_intl' },
  { pattern: /(?:sk-|gsk_|ghp_|glpat-|xoxb-|xoxp-)[A-Za-z0-9_-]{20,}/g, replacement: '[API_KEY_REDACTED]', label: 'api_key' },
  { pattern: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----/g, replacement: '[PRIVATE_KEY_REDACTED]', label: 'private_key' },
  { pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]+/gi, replacement: '[PASSWORD_REDACTED]', label: 'password' },
];

export function scrubPII(text: string): { cleaned: string; detected: string[] } {
  let cleaned = text;
  const detected: string[] = [];
  for (const { pattern, replacement, label } of PII_PATTERNS) {
    const matches = cleaned.match(pattern);
    if (matches) {
      detected.push(label);
      cleaned = cleaned.replace(pattern, replacement);
    }
  }
  return { cleaned, detected };
}

export function hasPII(text: string): boolean {
  // [Phase 1] Every pattern carries the `g` flag (used by scrubPII's
  // .replace()), and RegExp.prototype.test() on a global regex is stateful —
  // it advances lastIndex on a match and resumes from there next call. These
  // pattern objects are module-level singletons reused across every call, so
  // without resetting lastIndex a match found on one call could cause the
  // very next call to start scanning mid-string and silently miss an
  // earlier match. Reset before every test.
  return PII_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}
