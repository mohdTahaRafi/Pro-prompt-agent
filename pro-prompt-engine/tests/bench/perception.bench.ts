/**
 * Phase 2 §14 performance validation for the perception pipeline.
 *
 * Builds a synthetic page with ~2,000 DOM nodes and ~150 interactive
 * elements, runs buildSnapshot() 50 times, and reports p50/p95 for build
 * time and serialised snapshot size against the targets:
 *   - snapshot build ≤ 120ms p95
 *   - serialised size ≤ 96 KB p95
 *   - content-script bundle ≤ 80 KB gzipped (checked against the last
 *     `npm run build` output; run that first if it's stale or missing)
 *
 * This is a standalone script (`npx tsx tests/bench/perception.bench.ts`),
 * not a Vitest suite — it wires up a happy-dom Window by hand rather than
 * relying on Vitest's environment plugin, since it needs to run outside the
 * test runner's per-file isolation to get a stable, controllable page.
 *
 * Usage: npx tsx tests/bench/perception.bench.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDomEnv, instantSettle } from '../../tools/dom-env';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

installDomEnv();
// happy-dom's PerformanceObserver support is uneven across versions; the
// settle detector treats a construction failure as "unsupported" (settle.ts
// wraps po.observe() in try/catch), so a minimal stub is enough here — this
// bench is not measuring settle timing, it measures buildSnapshot() with a
// pre-resolved settle result.

async function main() {
  // Dynamic imports AFTER the globals are wired — these modules read
  // `document`/`Element` etc. at call time, not at module-load time, but
  // importing after wiring avoids any accidental early binding.
  const { buildSnapshot } = await import('@lib/page/perception');
  const { ElementRegistry } = await import('@lib/page/registry');

  buildSyntheticPage(2000, 150);

  const durationsMs: number[] = [];
  const sizesBytes: number[] = [];
  const RUNS = 50;

  for (let i = 0; i < RUNS; i++) {
    const registry = new ElementRegistry();
    const fakeSettle = instantSettle();
    const t0 = performance.now();
    const result = await buildSnapshot(registry, fakeSettle as never, {
      runId: `bench-${i}`, tabId: 1, tokenBudget: 6000,
    });
    const elapsed = performance.now() - t0;
    durationsMs.push(elapsed);
    if (result.ok) {
      sizesBytes.push(Buffer.byteLength(JSON.stringify(result.snapshot), 'utf-8'));
    } else {
      throw new Error(`buildSnapshot failed on run ${i}: ${result.reason}`);
    }
  }

  const buildP50 = percentile(durationsMs, 50);
  const buildP95 = percentile(durationsMs, 95);
  const sizeP50 = percentile(sizesBytes, 50);
  const sizeP95 = percentile(sizesBytes, 95);

  console.log('── Perception performance (Phase 2 §14) ──');
  console.log(`Synthetic page: 2,000 nodes, 150 interactive elements, ${RUNS} runs`);
  console.log(`Snapshot build:    p50 ${buildP50.toFixed(1)}ms  p95 ${buildP95.toFixed(1)}ms  (target: ≤120ms p95)`);
  console.log(`Serialised size:   p50 ${(sizeP50 / 1024).toFixed(1)}KB  p95 ${(sizeP95 / 1024).toFixed(1)}KB  (target: ≤96KB p95)`);

  const buildOk = buildP95 <= 120;
  const sizeOk = sizeP95 <= 96 * 1024;

  // ── Content-script bundle size (from the last production build) ──
  const bundlePath = path.join(ROOT, '.output/chrome-mv3/content-scripts/agent.js');
  let bundleOk = false;
  let gzippedKb = -1;
  if (existsSync(bundlePath)) {
    const raw = readFileSync(bundlePath);
    gzippedKb = gzipSync(raw).length / 1024;
    bundleOk = gzippedKb <= 80;
    console.log(`Content-script bundle: ${gzippedKb.toFixed(1)}KB gzipped  (target: ≤80KB — hard CI check)`);
  } else {
    console.log(`Content-script bundle: NOT MEASURED — run "npm run build" first (${bundlePath} not found)`);
  }

  console.log('');
  console.log(buildOk ? '✅ build time within budget' : '❌ BUILD TIME OVER BUDGET');
  console.log(sizeOk ? '✅ serialised size within budget' : '❌ SERIALISED SIZE OVER BUDGET');
  console.log(bundlePath && existsSync(bundlePath)
    ? (bundleOk ? '✅ content-script bundle within budget' : '❌ CONTENT-SCRIPT BUNDLE OVER BUDGET')
    : '⚠️  content-script bundle not checked');

  if (!buildOk || !sizeOk || (existsSync(bundlePath) && !bundleOk)) {
    process.exitCode = 1;
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** A page with ~2,000 total DOM nodes and ~150 genuinely interactive
 *  elements, mixing forms, a repeat grid, landmarks, and out-of-viewport
 *  content — the shape §14's target is measured against. */
function buildSyntheticPage(totalNodes: number, interactiveCount: number): void {
  const parts: string[] = [];
  parts.push('<header>Site header</header>');
  parts.push('<nav aria-label="Main"><a href="/">Home</a><a href="/about">About</a></nav>');

  // A long form — ~40 fields, 80 nodes (label + input each).
  const formFields = 40;
  parts.push('<form id="app-form" aria-label="Application form">');
  for (let i = 0; i < formFields; i++) {
    parts.push(`<label for="f${i}">Field ${i}</label><input id="f${i}" name="f${i}">`);
  }
  parts.push('<button type="submit">Submit application</button>');
  parts.push('</form>');

  // A repeating product grid — 40 cards x 4 nodes = 160 nodes, ~40 interactive links.
  parts.push('<div class="grid">');
  for (let i = 0; i < 40; i++) {
    parts.push(`<article><img src="${i}.jpg" alt="Product ${i}"><h3>Product ${i}</h3><a href="/p/${i}">View</a></article>`);
  }
  parts.push('</div>');

  // Filler structural content to reach the total node budget, plus enough
  // extra buttons to reach the interactive-element target.
  const usedInteractive = formFields + 1 + 40;   // fields + submit + grid links
  const extraButtons = Math.max(0, interactiveCount - usedInteractive);
  for (let i = 0; i < extraButtons; i++) {
    parts.push(`<button>Action ${i}</button>`);
  }

  let currentNodes = countApproxNodes(parts);
  let fillerIndex = 0;
  while (currentNodes < totalNodes) {
    parts.push(`<p>Filler paragraph ${fillerIndex} with some descriptive but non-interactive text.</p>`);
    fillerIndex += 1;
    currentNodes += 1;
  }

  parts.push('<aside aria-label="Sidebar"><p>Related content</p></aside>');
  parts.push('<footer>Site footer</footer>');

  document.body.innerHTML = parts.join('\n');
}

function countApproxNodes(parts: string[]): number {
  // Rough tag-count estimate for sizing the filler loop — exactness doesn't
  // matter, this only needs to land in the right neighbourhood.
  const joined = parts.join('');
  return (joined.match(/<[a-zA-Z]/g) ?? []).length;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
