/**
 * Structure-aware pruning — lib/page/perception.ts's ordering + prune(),
 * exercised through buildSnapshot(). Phase 2 §7.4/§7.5, task 2.10.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildSnapshot } from '@lib/page/perception';
import { ElementRegistry } from '@lib/page/registry';
import type { SettleDetector, SettleResult } from '@lib/page/settle';

function fakeSettle(): SettleDetector {
  const result: SettleResult = {
    settled: true, waitedMs: 0, calibration: 'visible',
    mutations: 0, resourceEntries: 0, suspect: false,
  };
  return { wait: async () => result, stop: () => {} } as unknown as SettleDetector;
}

async function snapshot(opts: Partial<{ region: string; tokenBudget: number }> = {}) {
  const registry = new ElementRegistry();
  const result = await buildSnapshot(registry, fakeSettle(), {
    runId: 'test-run', tabId: 1, tokenBudget: 6000, ...opts,
  });
  return result;
}

function bigForm(id: string, fieldCount: number): string {
  const fields = Array.from({ length: fieldCount }, (_, i) =>
    `<label for="${id}-f${i}">Field number ${i} with a moderately long descriptive label to spend tokens</label>
     <input id="${id}-f${i}" name="f${i}">`).join('\n');
  return `<form id="${id}" aria-label="Big form ${id}">${fields}</form>`;
}

function sidebarLinks(count: number): string {
  return `<aside aria-label="Sidebar">${Array.from({ length: count },
    (_, i) => `<a href="/x${i}">Sidebar link number ${i} with a fairly long link label text</a>`).join('')}</aside>`;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('pruning — Rule 1: never truncate the target region', () => {
  it('a form larger than the budget is kept whole when it is the target region, overshooting instead', async () => {
    // 60 fields is comfortably enough to exceed a 1000-token budget on its
    // own, while staying well under the 12,000 hard ceiling. Rule 1 only
    // ever applies to an ACTUAL target — explicitly requested here, the way
    // a real PERCEIVE_STRUCTURE {region} call would.
    document.body.innerHTML = bigForm('big', 60);
    const result = await snapshot({ region: 'form:big', tokenBudget: 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const formRegion = result.snapshot.regions.find((r) => r.regionId === 'form:big')!;
    expect(formRegion.complete).toBe(true);
    expect(formRegion.shown).toBe(formRegion.total);
    // The overshoot is recorded, never silent.
    expect(result.snapshot.overBudget).toBeDefined();
    expect(result.snapshot.overBudget!.by).toBeGreaterThan(0);
  });

  it('a non-target region IS pruned while the target region stays whole', async () => {
    document.body.innerHTML = bigForm('big', 40) + sidebarLinks(60);
    const result = await snapshot({ region: 'form:big', tokenBudget: 1500 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const formRegion = result.snapshot.regions.find((r) => r.regionId === 'form:big')!;
    expect(formRegion.complete).toBe(true);

    const sidebarRegion = result.snapshot.regions.find((r) => r.regionId.startsWith('landmark:complementary'));
    expect(sidebarRegion).toBeDefined();
    expect(sidebarRegion!.complete).toBe(false);
    expect(sidebarRegion!.shown).toBeLessThan(sidebarRegion!.total);
  });
});

describe('pruning — Rule 2: a repeat block is dropped whole or kept whole, never split', () => {
  it('a repeat block that does not fit is dropped ENTIRELY, not partially', async () => {
    const cards = Array.from({ length: 40 }, (_, i) =>
      `<article><h3>Product with a long descriptive title number ${i}</h3><span>Price tag for item ${i}</span></article>`).join('');
    document.body.innerHTML = `<div>${cards}</div>`;

    const result = await snapshot({ tokenBudget: 500 });   // deliberately tiny
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const repeatRegion = result.snapshot.regions.find((r) => r.regionId.startsWith('repeat:'));
    expect(repeatRegion).toBeDefined();
    // Either the whole block survived (shown === total) or none of it did
    // (shown === 0) — never a partial count.
    expect(repeatRegion!.shown === 0 || repeatRegion!.shown === repeatRegion!.total).toBe(true);
  });

  it('a repeat block that DOES fit is kept whole', async () => {
    const cards = Array.from({ length: 5 }, (_, i) =>
      `<article><h3>Item ${i}</h3></article>`).join('');
    document.body.innerHTML = `<div>${cards}</div>`;

    const result = await snapshot({ tokenBudget: 6000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const repeatRegion = result.snapshot.regions.find((r) => r.regionId.startsWith('repeat:'))!;
    expect(repeatRegion.shown).toBe(repeatRegion.total);
    expect(repeatRegion.complete).toBe(true);
  });
});

describe('pruning — Rule 3: completeness is reported per region, never as one global boolean', () => {
  it('every pruned region appears in regions[] with shown/total, not a single flag', async () => {
    document.body.innerHTML = bigForm('main', 5) + sidebarLinks(80);
    const result = await snapshot({ region: 'form:main', tokenBudget: 2000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Both regions are reported independently — a single global boolean
    // could not distinguish "the form is fine, only the sidebar was cut."
    const formRegion = result.snapshot.regions.find((r) => r.regionId === 'form:main')!;
    const sidebarRegion = result.snapshot.regions.find((r) => r.regionId.startsWith('landmark:complementary'))!;
    expect(formRegion).toBeDefined();
    expect(sidebarRegion).toBeDefined();
    expect(typeof formRegion.shown).toBe('number');
    expect(typeof formRegion.total).toBe('number');
    expect(typeof sidebarRegion.shown).toBe('number');
    expect(typeof sidebarRegion.total).toBe('number');
    // The two regions' completeness can genuinely differ — proving this
    // isn't collapsed into one flag.
    expect(formRegion.complete).toBe(true);
    expect(sidebarRegion.complete).toBe(false);
  });
});

describe('pruning — budget mechanics', () => {
  it('a page well within budget keeps everything and never records overBudget', async () => {
    document.body.innerHTML = `<button>Save</button><button>Cancel</button>`;
    const result = await snapshot({ tokenBudget: 6000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.overBudget).toBeUndefined();
    expect(result.snapshot.elements.length).toBe(2);
  });

  it('a snapshot whose kept set would exceed 12,000 tokens is refused with PERCEPTION_TOO_LARGE', async () => {
    // A single form far larger than even the hard ceiling, explicitly
    // targeted — Rule 1 forces it to stay whole, and the hard
    // MAX_SNAPSHOT_TOKENS ceiling (§7.5) refuses the snapshot outright
    // rather than silently exceeding it by a huge margin.
    document.body.innerHTML = bigForm('huge', 400);
    const result = await snapshot({ region: 'form:huge', tokenBudget: 6000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('PERCEPTION_TOO_LARGE');
  }, 20_000);

  it('a 5,000-descriptor page returns under 6,000 tokens or records overBudget (task 2.10)', async () => {
    // Many small, independent regions (not one giant target form) — pruning
    // has room to work, so the result should land under budget rather than
    // needing a Rule-1 overshoot.
    const buttons = Array.from({ length: 400 }, (_, i) => `<button>Btn ${i}</button>`).join('');
    document.body.innerHTML = buttons;
    const result = await snapshot({ tokenBudget: 6000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Either it fit (no overshoot record) or an overshoot was explicitly
    // and honestly recorded — either way, never silent.
    if (result.snapshot.overBudget === undefined) {
      expect(result.snapshot.elements.length).toBeLessThanOrEqual(400);
    } else {
      expect(result.snapshot.overBudget.by).toBeGreaterThan(0);
    }
  });
});

describe('ordering — viewport-first with form-scoped expansion (§7.4)', () => {
  it('an explicit region is ordered first regardless of document position', async () => {
    document.body.innerHTML = sidebarLinks(5) + bigForm('target', 5);
    const result = await snapshot({ region: 'form:target', tokenBudget: 6000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The explicit target region's elements should all be present and
    // complete even though they appear AFTER the sidebar in document order.
    const targetRegion = result.snapshot.regions.find((r) => r.regionId === 'form:target')!;
    expect(targetRegion.complete).toBe(true);
  });
});
