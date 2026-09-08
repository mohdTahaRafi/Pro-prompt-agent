/**
 * Regenerates Docs/planning/bakeoff_phase2.md from an already-saved
 * tests/bench/bakeoff_raw.json, without re-running any real API/Ollama
 * call — for when a fix changes only how the report is WRITTEN (e.g. the
 * control-excluded-from-ranking fix this file's own history recorded),
 * not what was measured. The pruning study section is cheap and local
 * (happy-dom, no network), so it's re-run fresh rather than re-parsed.
 *
 * Usage: npx tsx tools/regen-bakeoff-report.ts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReport, type CandidateReport } from './bakeoff';
import { runPruningStudy } from './pruning-study';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function main() {
  const raw = JSON.parse(readFileSync(path.join(ROOT, 'tests/bench/bakeoff_raw.json'), 'utf-8')) as {
    reports: CandidateReport[];
    stepMatchDisagreements: unknown[];
  };
  const corpus = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/snapshots/corpus.json'), 'utf-8')) as unknown[];

  console.log('── Re-running the pruning study (§10.2) — cheap and local, not a re-measurement ──');
  const pruningSection = await runPruningStudy();

  writeReport(raw.reports, corpus.length, corpus.length, pruningSection);
  console.log('\nRegenerated Docs/planning/bakeoff_phase2.md from the existing tests/bench/bakeoff_raw.json (no model calls made).');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
