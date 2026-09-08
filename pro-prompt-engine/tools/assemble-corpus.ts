/**
 * Merges the corpus's three source files into the final, scored
 * tests/fixtures/snapshots/corpus.json (§10.1's 15 hand-built / 15
 * frozen-capture / 10 live-panel split, task 2.16), and mechanically
 * enforces the split rather than just describing it:
 *
 * - corpus.hand-built.json      (15) — tools/build-corpus.ts
 * - corpus.frozen-capture.json  (15) — hand-authored gold answers over the
 *                                      real snapshots tools/collect-real-fixtures.ts
 *                                      produced from tools/corpus-targets.ts's
 *                                      FROZEN_CAPTURE_TARGETS
 * - corpus.live-panel.json      (10) — same, for LIVE_PANEL_TARGETS
 *
 * Every merged entry is re-validated against CorpusEntrySchema, and every
 * snapshot file it references is re-validated against
 * PerceptionSnapshotSchema — the "a schema check passes over all 40"
 * acceptance criterion (task 2.16), now over the real 40, not the
 * synthetic one.
 *
 * Usage: npx tsx tools/assemble-corpus.ts
 * Writes: tests/fixtures/snapshots/corpus.json
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CorpusEntrySchema, type CorpusEntry } from './corpus-schema';
import { PerceptionSnapshotSchema } from '@lib/schemas/snapshot.schema';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'tests/fixtures/snapshots');

const PARTS: Array<{ file: string; source: CorpusEntry['source']; expectedCount: number }> = [
  { file: 'corpus.hand-built.json', source: 'hand-built', expectedCount: 15 },
  { file: 'corpus.frozen-capture.json', source: 'frozen-capture', expectedCount: 15 },
  { file: 'corpus.live-panel.json', source: 'live-panel', expectedCount: 10 },
];

function main() {
  const merged: CorpusEntry[] = [];
  let failures = 0;

  for (const part of PARTS) {
    const filePath = path.join(DIR, part.file);
    if (!existsSync(filePath)) {
      console.error(`❌ missing ${part.file} — run the collector/author step that produces it first.`);
      failures += 1;
      continue;
    }
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!Array.isArray(raw)) {
      console.error(`❌ ${part.file} is not a JSON array`);
      failures += 1;
      continue;
    }
    if (raw.length !== part.expectedCount) {
      console.error(`❌ ${part.file} has ${raw.length} entries, expected exactly ${part.expectedCount}`);
      failures += 1;
    }
    for (const entry of raw) {
      const parsed = CorpusEntrySchema.safeParse(entry);
      if (!parsed.success) {
        failures += 1;
        console.error(`❌ ${part.file}: schema failure for entry`, JSON.stringify(entry).slice(0, 120), parsed.error.issues);
        continue;
      }
      if (parsed.data.source !== part.source) {
        failures += 1;
        console.error(`❌ ${part.file}: entry "${parsed.data.id}" declares source "${parsed.data.source}", expected "${part.source}"`);
        continue;
      }
      merged.push(parsed.data);
    }
  }

  // Duplicate-id check across the merged set.
  const seen = new Set<string>();
  for (const e of merged) {
    if (seen.has(e.id)) { failures += 1; console.error(`❌ duplicate corpus id: ${e.id}`); }
    seen.add(e.id);
  }

  // Every referenced snapshot file must exist and be schema-valid.
  for (const e of merged) {
    const snapPath = path.join(DIR, e.snapshotFile);
    if (!existsSync(snapPath)) {
      failures += 1;
      console.error(`❌ ${e.id}: snapshot file missing — ${e.snapshotFile}`);
      continue;
    }
    const parsed = PerceptionSnapshotSchema.safeParse(JSON.parse(readFileSync(snapPath, 'utf-8')));
    if (!parsed.success) {
      failures += 1;
      console.error(`❌ ${e.id}: snapshot schema failure —`, parsed.error.issues);
    }
  }

  const counts = { 'hand-built': 0, 'frozen-capture': 0, 'live-panel': 0 } as Record<CorpusEntry['source'], number>;
  for (const e of merged) counts[e.source] += 1;
  console.log(`Composition: ${counts['hand-built']} hand-built / ${counts['frozen-capture']} frozen-capture / ${counts['live-panel']} live-panel = ${merged.length} total`);

  if (failures > 0) {
    console.error(`\n❌ ${failures} problem(s) — corpus.json NOT written. Fix and re-run.`);
    process.exitCode = 1;
    return;
  }
  if (counts['hand-built'] !== 15 || counts['frozen-capture'] !== 15 || counts['live-panel'] !== 10) {
    console.error(`\n❌ split is not exactly 15 hand-built / 15 frozen-capture / 10 live-panel — corpus.json NOT written.`);
    process.exitCode = 1;
    return;
  }

  writeFileSync(path.join(DIR, 'corpus.json'), JSON.stringify(merged, null, 2));
  console.log(`\n✅ Wrote ${merged.length}-entry corpus.json — exactly 15 hand-built / 15 frozen-capture / 10 live-panel, every entry and snapshot schema-valid.`);
}

main();
