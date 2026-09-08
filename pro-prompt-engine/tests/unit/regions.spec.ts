/**
 * Region derivation — lib/page/perception.ts's deriveRegions(), exercised
 * through buildSnapshot(). Phase 2 §7.3, task 2.9.
 *
 * fixtures/product-grid.html's real shape (2 forms, 4 landmarks, a 24-item
 * product grid) is built programmatically here — see perception.spec.ts's
 * header comment on why (innerHTML-inserted <script> tags are inert).
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

async function snapshot(tokenBudget = 12_000) {
  const registry = new ElementRegistry();
  const result = await buildSnapshot(registry, fakeSettle(), {
    runId: 'test-run', tabId: 1, tokenBudget,
  });
  if (!result.ok) throw new Error(`buildSnapshot failed: ${result.reason}`);
  return result.snapshot;
}

/** A card whose child-tag SHAPE matches every other card (<article><img>
 *  <h3><span>), but whose class name differs — proving the repeat detector
 *  is structural, not class-based (§7.3). */
function makeCard(n: number): string {
  return `<article class="card card--${n}"><img src="${n}.jpg" alt="Product ${n}"><h3>Product ${n}</h3><span class="price">$${n}</span></article>`;
}

// The grid sits in a plain, non-landmark <div> — NOT wrapped in <main> —
// so priority 2 (landmark) never shadows priority 3 (repeat) for its
// items. §7.3's priority order (form > landmark > repeat > root) means a
// repeat block nested inside a landmark collapses into that landmark's
// completeness reporting instead of its own; that's a real, documented
// corner case (perception.ts §7.3 comment) this fixture deliberately
// avoids to exercise the case task 2.9 actually specifies.
function buildProductGridPage(): void {
  document.body.innerHTML = `
    <header>Site header</header>
    <nav aria-label="Main navigation"><a href="/">Home</a></nav>
    <form id="search-form" aria-label="Search">
      <input type="search" name="q" placeholder="Search products">
      <button type="submit">Search</button>
    </form>
    <div class="grid">${Array.from({ length: 24 }, (_, i) => makeCard(i + 1)).join('')}</div>
    <aside aria-label="Related content"><a href="/x">Related item</a></aside>
    <form id="newsletter-form" aria-label="Newsletter signup">
      <input type="email" name="email" placeholder="Email address">
      <button type="submit">Subscribe</button>
    </form>
    <footer>Site footer</footer>
  `;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('deriveRegions — task 2.9 acceptance', () => {
  it('2 forms + 4 landmarks + a 24-item repeat grid yields exactly 7 regions', async () => {
    buildProductGridPage();
    const snap = await snapshot();

    const formRegions = snap.regions.filter((r) => r.regionId.startsWith('form:'));
    const landmarkRegions = snap.regions.filter((r) => r.regionId.startsWith('landmark:'));
    const repeatRegions = snap.regions.filter((r) => r.regionId.startsWith('repeat:'));

    expect(formRegions.length).toBe(2);
    expect(landmarkRegions.length).toBe(4);
    expect(repeatRegions.length).toBe(1);
    expect(snap.regions.length).toBe(7);
  });

  it("the grid's region total is 24 (block granularity, not inner-element count)", async () => {
    buildProductGridPage();
    const snap = await snapshot();
    const repeatRegion = snap.regions.find((r) => r.regionId.startsWith('repeat:'))!;
    expect(repeatRegion.total).toBe(24);
    expect(repeatRegion.shown).toBe(24);
    expect(repeatRegion.complete).toBe(true);
  });

  it('a 2-item list is NOT a repeat region (below the 3-sibling minimum)', async () => {
    document.body.innerHTML = `
      <div class="pair">
        <article><img src="1.jpg" alt="a"><h3>A</h3></article>
        <article><img src="2.jpg" alt="b"><h3>B</h3></article>
      </div>`;
    const snap = await snapshot();
    expect(snap.regions.some((r) => r.regionId.startsWith('repeat:'))).toBe(false);
  });

  it('a repeat region label reads as "a list of N similar items"', async () => {
    buildProductGridPage();
    const snap = await snapshot();
    const repeatRegion = snap.regions.find((r) => r.regionId.startsWith('repeat:'))!;
    expect(repeatRegion.label).toBe('a list of 24 similar items');
  });

  it('siblings with a different child-tag shape do not form a repeat region', async () => {
    // Same tag (article) repeated 4 times, but each has a DIFFERENT child
    // shape — not a structural repeat, even though the tag count qualifies.
    document.body.innerHTML = `
      <div class="mixed">
        <article><img alt="a"><h3>A</h3></article>
        <article><h3>B</h3><span>only a span</span></article>
        <article><p>C</p></article>
        <article></article>
      </div>`;
    const snap = await snapshot();
    expect(snap.regions.some((r) => r.regionId.startsWith('repeat:'))).toBe(false);
  });

  it('a form region is tagged with the form accessible name as its label', async () => {
    buildProductGridPage();
    const snap = await snapshot();
    const searchForm = snap.regions.find((r) => r.regionId.startsWith('form:') && r.label === 'Search');
    expect(searchForm).toBeDefined();
  });

  it('elements inside the grid are tagged with the grid repeat regionId', async () => {
    buildProductGridPage();
    const snap = await snapshot();
    const repeatRegion = snap.regions.find((r) => r.regionId.startsWith('repeat:'))!;
    const headingEls = snap.elements.filter((e) => e.role === 'heading' && e.name.startsWith('Product'));
    expect(headingEls.length).toBeGreaterThan(0);
    for (const h of headingEls) expect(h.regionId).toBe(repeatRegion.regionId);
  });

  it('everything outside any form/landmark/repeat falls back to region:root', async () => {
    document.body.innerHTML = `<button>Standalone</button>`;
    const snap = await snapshot();
    const el = snap.elements.find((e) => e.name === 'Standalone')!;
    expect(el.regionId).toBe('region:root');
  });
});
