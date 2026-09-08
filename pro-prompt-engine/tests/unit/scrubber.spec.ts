/**
 * Carries both directions of the narrowed phone rule (§5.7): a corpus of
 * true phone numbers that must still redact, and a corpus of order ids,
 * timestamps, ISBNs and invoice numbers that must now survive.
 */
import { describe, it, expect } from 'vitest';
import { scrubPII, hasPII } from '@lib/utils/pii-scrubber';

const TRUE_PHONE_NUMBERS = [
  '555-123-4567',
  '555.123.4567',
  '555 123 4567',
  '+1-555-123-4567',
  '+44 20 7946 0958',
  '(call me at) 212-555-0199',
];

const NON_PHONE_IDENTIFIERS = [
  'Order #1234567890123',
  'Invoice INV0987654321',
  'timestamp 1699999999999',
  'ISBN 9781234567897',
  'tracking id 123456789012',
  'session_id=98765432109',
  'account balance is 4000000000',
];

describe('pii-scrubber — narrowed phone rule (§5.7)', () => {
  it.each(TRUE_PHONE_NUMBERS)('redacts a true phone number: %s', (phone) => {
    const { cleaned, detected } = scrubPII(`Call me at ${phone} anytime.`);
    expect(cleaned).not.toContain(phone);
    expect(detected.some((label) => label.startsWith('phone'))).toBe(true);
    expect(cleaned).toMatch(/\[PHONE(_INTL)?_REDACTED\]/);
  });

  it.each(NON_PHONE_IDENTIFIERS)('leaves a non-phone identifier untouched: %s', (text) => {
    const { cleaned } = scrubPII(text);
    expect(cleaned).toBe(text);
  });

  it('hasPII agrees with scrubPII on both corpora', () => {
    for (const phone of TRUE_PHONE_NUMBERS) expect(hasPII(`Call ${phone}`)).toBe(true);
  });

  it('still redacts email, SSN, credit card, API keys and private keys', () => {
    expect(scrubPII('contact me at jane@example.com').cleaned).toContain('[EMAIL_REDACTED]');
    expect(scrubPII('SSN: 123-45-6789').cleaned).toContain('[SSN_REDACTED]');
    expect(scrubPII('card 4111 1111 1111 1111').cleaned).toContain('[CC_REDACTED]');
    expect(scrubPII('key: sk-abcdefghijklmnopqrstuvwx').cleaned).toContain('[API_KEY_REDACTED]');
    expect(scrubPII('password: hunter2').cleaned).toContain('[PASSWORD_REDACTED]');
  });
});
