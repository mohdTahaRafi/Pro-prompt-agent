/**
 * lib/agent/anomaly.ts — the three §4 detectors.
 * Docs/planning/phase_6_recovery_journal_reporting.md §4, §12 task 6.8.
 */
import { describe, it, expect } from 'vitest';
import { isLowFieldCount, medianOf, isFieldShortfall, verificationCollapse, isUnexpectedOrigin } from '@lib/agent/anomaly';

describe('isLowFieldCount / medianOf — collapsed table (J-2)', () => {
  it('a collapsed table producing 6 of 24 rows (median 24) fires the low-count detector', () => {
    const median = medianOf([24, 24, 25]);   // three comparable prior reads of the same region
    expect(isLowFieldCount(6, median)).toBe(true);
  });

  it('a normal read (22 of a ~24 median) does not fire', () => {
    const median = medianOf([24, 23, 25]);
    expect(isLowFieldCount(22, median)).toBe(false);
  });

  it('never fires with no history (median 0)', () => {
    expect(isLowFieldCount(1, 0)).toBe(false);
  });

  it('medianOf is the true median for both odd and even history lengths', () => {
    expect(medianOf([1, 3, 2])).toBe(2);
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
    expect(medianOf([])).toBe(0);
  });
});

describe('isFieldShortfall', () => {
  it('fires when the extracted count is far below the field count', () => {
    expect(isFieldShortfall(1, 10)).toBe(true);
  });

  it('does not fire for a normal shortfall', () => {
    expect(isFieldShortfall(9, 10)).toBe(false);
  });

  it('never fires with fieldCount <= 0', () => {
    expect(isFieldShortfall(0, 0)).toBe(false);
  });
});

describe('verificationCollapse — four consecutive unconfirmed replans, six ends the run', () => {
  it('fires "replan" exactly at streak 4', () => {
    expect(verificationCollapse(1)).toBeNull();
    expect(verificationCollapse(2)).toBeNull();
    expect(verificationCollapse(3)).toBeNull();
    expect(verificationCollapse(4)).toBe('replan');
    expect(verificationCollapse(5)).toBeNull();
  });

  it('fires "end" from streak 6 onward', () => {
    expect(verificationCollapse(6)).toBe('end');
    expect(verificationCollapse(7)).toBe('end');
  });

  it('a monotonically increasing streak (a real run) fires replan exactly once, then end from 6 onward', () => {
    // The caller (lib/agent/supervisor.ts) stops calling this the moment it
    // gets 'end' — the pure function itself keeps answering 'end' for every
    // streak at or past 6, which is what makes it safe to call unconditionally
    // every time a verdict comes in rather than needing its own "already
    // fired" bookkeeping.
    const seen: Array<'replan' | 'end'> = [];
    for (let s = 1; s <= 8; s++) {
      const v = verificationCollapse(s);
      if (v) seen.push(v);
    }
    expect(seen.filter((v) => v === 'replan')).toEqual(['replan']);
    expect(seen.filter((v) => v === 'end')).toEqual(['end', 'end', 'end']);
    expect(seen[0]).toBe('replan');
  });
});

describe('isUnexpectedOrigin', () => {
  const SCOPE = ['https://a.example', 'https://b.example'];

  it('true for an origin in scope but not the one the plan expected', () => {
    expect(isUnexpectedOrigin('https://b.example', 'https://a.example', SCOPE)).toBe(true);
  });

  it('false for the expected origin', () => {
    expect(isUnexpectedOrigin('https://a.example', 'https://a.example', SCOPE)).toBe(false);
  });

  it('false for an origin outside scope — that is the gate\'s job, not this detector\'s', () => {
    expect(isUnexpectedOrigin('https://evil.example', 'https://a.example', SCOPE)).toBe(false);
  });
});
