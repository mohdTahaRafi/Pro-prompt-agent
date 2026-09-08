/**
 * Runs the sensitive-field classifier over the fixture corpus described in
 * §6 and §8.2: Stripe Elements markup, a PayPal card form, three OTP shapes,
 * four password shapes, plus twenty non-sensitive fields that must classify
 * null. Zero false negatives on the sensitive fields is the bar (§3.7.22);
 * the classifier is allowed to be wide, never narrow.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { classifySensitive, type SensitiveKind } from '@lib/page/sensitive';

const FIXTURE_PATH = path.resolve(__dirname, '../e2e/fixtures/sensitive-corpus.html');

let fields: Array<{ el: Element; expected: SensitiveKind; label: string }>;

beforeAll(() => {
  const html = readFileSync(FIXTURE_PATH, 'utf-8');
  document.documentElement.innerHTML = html.replace(/^[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*$/, '');
  const els = Array.from(document.querySelectorAll('[data-expect]'));
  fields = els.map((el) => {
    const raw = el.getAttribute('data-expect')!;
    const expected = (raw === 'null' ? null : raw) as SensitiveKind;
    const label = el.getAttribute('name') || el.id || el.getAttribute('aria-label') || raw;
    return { el, expected, label };
  });
});

describe('classifySensitive — fixture corpus (§6, §8.2)', () => {
  it('parses the fixture and finds every tagged field', () => {
    // 4 password + 7 payment + 3 otp + 1 file + 1 hidden + 20 benign
    expect(fields.length).toBe(36);
  });

  it('every field classifies exactly as tagged — zero false negatives on sensitive fields', () => {
    const mismatches = fields
      .map(({ el, expected, label }) => ({ label, expected, actual: classifySensitive(el) }))
      .filter(({ expected, actual }) => expected !== actual);
    expect(mismatches, JSON.stringify(mismatches, null, 2)).toEqual([]);
  });

  it('classifies password fields as password', () => {
    const passwordFields = fields.filter((f) => f.expected === 'password');
    expect(passwordFields).toHaveLength(4);
    for (const f of passwordFields) expect(classifySensitive(f.el)).toBe('password');
  });

  it('classifies Stripe- and PayPal-shaped fields as payment', () => {
    const paymentFields = fields.filter((f) => f.expected === 'payment');
    expect(paymentFields).toHaveLength(7);
    for (const f of paymentFields) expect(classifySensitive(f.el)).toBe('payment');
  });

  it('classifies all three OTP shapes as otp', () => {
    const otpFields = fields.filter((f) => f.expected === 'otp');
    expect(otpFields).toHaveLength(3);
    for (const f of otpFields) expect(classifySensitive(f.el)).toBe('otp');
  });

  it('classifies file inputs as file and hidden inputs as hidden', () => {
    expect(classifySensitive(document.querySelector('[name="id_upload"]')!)).toBe('file');
    expect(classifySensitive(document.querySelector('[name="csrf_token"]')!)).toBe('hidden');
  });

  it('classifies all twenty benign fields as null', () => {
    const benign = fields.filter((f) => f.expected === null);
    expect(benign).toHaveLength(20);
    for (const f of benign) expect(classifySensitive(f.el)).toBeNull();
  });

  it('a non-HTMLElement input returns null rather than throwing', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    expect(() => classifySensitive(svg)).not.toThrow();
  });
});
