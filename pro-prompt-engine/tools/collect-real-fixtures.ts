/**
 * Collects the 15 frozen-capture + 10 live-panel real-page snapshots for
 * the §10.1 corpus (the 15 hand-built / 15 frozen-capture / 10 live-panel
 * split) — the automated replacement for §9's manual debug-panel workflow.
 *
 * WHY AUTOMATED, NOT THE MANUAL PANEL — a disclosed, decided deviation
 * (Docs/planning/phase_2_perception.md §17 carries the dated account):
 * §9's Perception debug tab assumes a human clicking "Read structure" and
 * "Save as fixture" in a real Chrome window they're driving by hand.
 * wxt.config.ts's own PP_E2E comment already established that
 * chrome.permissions.request() cannot be driven by Playwright for a NEW
 * origin — it opens a native bubble that hangs forever waiting for a real
 * click. That blocks a naive automation of the panel for arbitrary real
 * URLs. The fix used here is the same one already proven for e2e: put
 * every target origin (tools/corpus-targets.ts) into a PP_CORPUS build's
 * *static* host_permissions (wxt.config.ts), so the extension already
 * holds each permission before this script runs and
 * chrome.permissions.request() resolves instantly, no bubble. Everything
 * downstream is the real, unmodified pipeline: real Chromium, the real
 * built agent.content.ts, the real chrome.tabs.sendMessage path §9's panel
 * itself uses — nothing here is simulated or hand-typed.
 *
 * What this script does NOT do: author goal/gold answers. That happens
 * afterward, by hand, reading each real snapshot's actual elements[] —
 * the same honest method tools/build-corpus.ts uses for its 10 synthetic
 * entries. This script's job stops at producing real, schema-valid
 * PerceptionSnapshot JSON for each of the 30 real targets.
 *
 * Prerequisite: npm run build:corpus (PP_CORPUS=1 wxt build).
 * Usage: npx tsx tools/collect-real-fixtures.ts
 *   (or: npm run collect:corpus, which runs both steps)
 * Writes: tests/fixtures/snapshots/<id>.json (30 files),
 *         tests/fixtures/snapshots/collection-log.json
 */
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FROZEN_CAPTURE_TARGETS, LIVE_PANEL_TARGETS, type FrozenTarget, type LiveTarget } from './corpus-targets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, '.output/corpus-collect/chrome-mv3');
const OUT_DIR = path.join(ROOT, 'tests/fixtures/snapshots');
const CAPTURE_PORT = 5600;

interface CollectResult {
  id: string; source: 'frozen-capture' | 'live-panel'; url: string;
  ok: boolean; elementCount?: number; error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Runs tests/captures/capture.ts for any frozen target not already on
 *  disk — freezing it once (scripts stripped, assets inlined). */
function ensureCaptured(targets: FrozenTarget[]): void {
  for (const t of targets) {
    const indexPath = path.join(ROOT, 'tests/captures', t.id, 'index.html');
    if (t.alreadyCaptured || existsSync(indexPath)) {
      console.log(`  (already captured) ${t.id}`);
      continue;
    }
    console.log(`  capturing ${t.id} <- ${t.url}`);
    execFileSync('npx', ['tsx', 'tests/captures/capture.ts', t.id, t.url, t.notes], { cwd: ROOT, stdio: 'inherit' });
  }
}

async function collectOne(
  context: BrowserContext, popup: Page, id: string, url: string,
  source: 'frozen-capture' | 'live-panel', results: CollectResult[],
): Promise<void> {
  let page: Page | undefined;
  try {
    page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const origin = new URL(url).origin;

    const granted = await popup.evaluate(
      async (o) => chrome.runtime.sendMessage({ type: 'GRANT_ORIGIN', payload: { origin: o } }), origin,
    ) as { status?: string; message?: string };
    if (granted?.status !== 'success') throw new Error(`grant failed: ${JSON.stringify(granted)}`);

    // The content script registers at document_idle for future navigations
    // to this origin — the already-loaded page needs a reload to pick it
    // up (tests/e2e/perception.spec.ts's own comment records the same).
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(300);

    const tabs = await popup.evaluate(
      async (o) => chrome.tabs.query({ url: `${o}/*` }), origin,
    ) as Array<{ id: number }>;
    const tabId = tabs[0]?.id;
    if (!tabId) throw new Error('no tab found for granted origin after reload');

    const runId = `corpus-${id}-${Date.now()}`;
    // Real settle detection against a real, possibly-dynamic page, not a
    // synthetic fixture — exercises the same code path §9's panel does,
    // and a genuinely useful real-world check the synthetic corpus can't
    // provide.
    await popup.evaluate(
      async (args) => chrome.tabs.sendMessage(args.tid, { type: 'WAIT_FOR_SETTLE', runId: args.rid, maxMs: 8000 }),
      { tid: tabId, rid: runId },
    ).catch(() => undefined);   // best-effort — a page that never quiesces still gets read below

    const resp = await popup.evaluate(
      async (args) => chrome.tabs.sendMessage(args.tid, { type: 'PERCEIVE_STRUCTURE', runId: args.rid, tokenBudget: 6000 }),
      { tid: tabId, rid: runId },
    ) as { status?: string; message?: string; data?: { elements: unknown[] } };
    if (resp?.status !== 'success' || !resp.data) throw new Error(`PERCEIVE_STRUCTURE failed: ${JSON.stringify(resp).slice(0, 300)}`);

    writeFileSync(path.join(OUT_DIR, `${id}.json`), JSON.stringify(resp.data, null, 2));
    console.log(`✅ ${id} (${source}) — ${resp.data.elements.length} elements`);
    results.push({ id, source, url, ok: true, elementCount: resp.data.elements.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`❌ ${id} (${source}) — ${message}`);
    results.push({ id, source, url, ok: false, error: message });
  } finally {
    await page?.close().catch(() => undefined);
  }
}

async function main() {
  if (!existsSync(EXT)) {
    console.error(`Extension build not found at ${EXT}\nRun "npm run build:corpus" first (PP_CORPUS=1 wxt build).`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });

  // Optional CLI allowlist for a targeted retry of specific ids, e.g.
  // `npx tsx tools/collect-real-fixtures.ts wikipedia-create-account` —
  // re-running the full 30-target pass to fix one failure wastes both
  // time and the other 29 origins' already-good data.
  const only = new Set(process.argv.slice(2));
  const frozenTargets = only.size ? FROZEN_CAPTURE_TARGETS.filter((t) => only.has(t.id)) : FROZEN_CAPTURE_TARGETS;
  const liveTargets = only.size ? LIVE_PANEL_TARGETS.filter((t) => only.has(t.id)) : LIVE_PANEL_TARGETS;
  if (only.size) console.log(`Targeted run: ${[...only].join(', ')}`);

  console.log('── Ensuring all frozen captures exist ──');
  ensureCaptured(frozenTargets);

  // Best-effort: clear anything already holding CAPTURE_PORT (an orphan
  // from an earlier interrupted run) before starting a fresh server,
  // rather than failing on EADDRINUSE and leaving every frozen-capture
  // target unreachable for the rest of this run.
  try { execFileSync('fuser', ['-k', `${CAPTURE_PORT}/tcp`], { stdio: 'ignore' }); } catch { /* nothing was listening, or fuser isn't installed — fine either way */ }

  console.log(`\n── Starting the combined capture server on :${CAPTURE_PORT} ──`);
  // Found the hard way, twice: (1) `npx tsx ...` spawns tsx as a
  // grandchild of npx, so killing the npx process leaves tsx running;
  // (2) even the tsx binary directly spawns ITS OWN node subprocess
  // (tsx is a thin launcher, not the interpreter), so a plain
  // `capServer.kill()` can still leave that grandchild holding the port
  // after a run that exited normally and reached `finally`. Fixed at the
  // process-GROUP level instead of chasing each indirection layer:
  // `detached: true` puts capServer in its own new process group (pgid
  // = its own pid), which every process it spawns inherits by default —
  // so `process.kill(-pgid)` below reaches all of them in one signal,
  // regardless of how many layers of launcher are in between.
  const tsxBin = path.join(ROOT, 'node_modules/.bin/tsx');
  const capServer: ChildProcess = spawn(tsxBin, ['tests/captures/serve-all.ts', String(CAPTURE_PORT)], {
    cwd: ROOT, stdio: 'inherit', detached: true,
  });
  const killCapServerGroup = () => {
    if (capServer.pid) { try { process.kill(-capServer.pid, 'SIGKILL'); } catch { /* already gone */ } }
  };
  process.on('SIGTERM', killCapServerGroup);
  process.on('SIGINT', killCapServerGroup);

  // Confirm the server is actually reachable rather than assuming a fixed
  // delay was enough — a port already in use (e.g. an orphaned server
  // from an earlier interrupted run) previously failed silently here and
  // only surfaced 15 collection failures later, one per frozen target.
  let serverUp = false;
  for (let i = 0; i < 20 && !serverUp; i += 1) {
    await sleep(300);
    try {
      const resp = await fetch(`http://localhost:${CAPTURE_PORT}/`, { signal: AbortSignal.timeout(1000) });
      serverUp = resp.ok;
    } catch { /* keep polling */ }
  }
  if (!serverUp) {
    console.error(`Capture server never came up on :${CAPTURE_PORT} — is the port already in use by a stale process? (lsof -i :${CAPTURE_PORT})`);
    process.exitCode = 1;
    return;
  }

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10_000 });
    const extensionId = sw.url().split('/')[2];

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    const results: CollectResult[] = [];

    console.log(`\n── Frozen captures (${frozenTargets.length}) ──`);
    for (const t of frozenTargets) {
      await collectOne(context, popup, t.id, `http://localhost:${CAPTURE_PORT}/${t.id}/index.html`, 'frozen-capture', results);
    }

    console.log(`\n── Live-panel saves (${liveTargets.length}) ──`);
    for (const t of liveTargets) {
      await collectOne(context, popup, t.id, t.url, 'live-panel', results);
    }

    // Merge into the existing log by id (a targeted retry via the CLI
    // allowlist above must not clobber the other 29 entries' history).
    const logPath = path.join(OUT_DIR, 'collection-log.json');
    const prior: CollectResult[] = existsSync(logPath) ? JSON.parse(readFileSync(logPath, 'utf-8')) : [];
    const byId = new Map(prior.map((r) => [r.id, r]));
    for (const r of results) byId.set(r.id, r);
    const merged = [...byId.values()];
    writeFileSync(logPath, JSON.stringify(merged, null, 2));

    const ok = results.filter((r) => r.ok).length;
    console.log(`\nThis run: ${ok}/${results.length} collected. Overall log now has ${merged.filter((r) => r.ok).length}/${merged.length} ok. Log: tests/fixtures/snapshots/collection-log.json`);
    if (ok < results.length) {
      console.log('Failed targets this run:');
      for (const r of results.filter((r) => !r.ok)) console.log(`  - ${r.id}: ${r.error}`);
      process.exitCode = 1;
    }
  } finally {
    await context.close();
    killCapServerGroup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
