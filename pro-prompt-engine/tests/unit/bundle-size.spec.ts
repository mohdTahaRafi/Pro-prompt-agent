/**
 * Bundle size — §13's two CI gzip-check rows.
 * Docs/planning/phase_5_agent_loop.md §13, §11 task 5.18.
 *
 * Mirrors tests/unit/manifest.spec.ts's pattern: reads the already-built
 * production output, building once itself if nothing has built yet.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, '.output/chrome-mv3');

beforeAll(() => {
  if (!existsSync(path.join(OUT, 'manifest.json'))) {
    execSync('npm run build', { cwd: ROOT, stdio: 'pipe' });
  }
}, 120_000);

function gzipSize(relPath: string): number {
  return gzipSync(readFileSync(path.join(OUT, relPath))).length;
}

/** Every script src / modulepreload href an HTML entrypoint eagerly loads —
 *  exactly what the browser fetches for that page, never the shared chunks
 *  another entrypoint (e.g. the offscreen document's WebLLM host) only
 *  reaches via a runtime dynamic import(). */
function eagerScriptSizes(htmlFile: string): number {
  const html = readFileSync(path.join(OUT, htmlFile), 'utf-8');
  const paths = [...html.matchAll(/(?:src|href)="(\/chunks\/[^"]+\.js)"/g)].map((m) => m[1]);
  return [...new Set(paths)].reduce((sum, p) => sum + gzipSize(p), 0);
}

describe('bundle size (§13)', () => {
  it('content-scripts/agent.js is ≤ 80 KB gzipped (overlay added, §9.2)', () => {
    const size = gzipSize('content-scripts/agent.js');
    expect(size, `${(size / 1024).toFixed(1)} KB gzipped`).toBeLessThanOrEqual(80 * 1024);
  });

  it('the side panel is ≤ 400 KB gzipped, excluding WebLLM (only reachable via the offscreen document\'s own dynamic import)', () => {
    const size = eagerScriptSizes('sidepanel.html');
    expect(size, `${(size / 1024).toFixed(1)} KB gzipped`).toBeLessThanOrEqual(400 * 1024);
  });
});
