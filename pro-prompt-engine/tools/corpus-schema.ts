/**
 * The shared bake-off corpus entry shape (§10.1, task 2.16) — one Zod
 * schema used by every tool that reads or writes `corpus.json`, so the
 * three source types can never silently drift apart between
 * build-corpus.ts, collect-real-fixtures.ts, assemble-corpus.ts, and
 * bakeoff.ts.
 *
 * `source` has three values because §10.1's corpus is a 15 hand-built / 15
 * frozen-capture / 10 live-panel split:
 * - 'hand-built'     — synthetic HTML, walked by the real buildSnapshot()
 *                       pipeline under happy-dom (tools/build-corpus.ts).
 * - 'frozen-capture'  — a real page frozen once via tests/captures/capture.ts
 *                       (scripts stripped, assets inlined), then read
 *                       through the real extension in real Chromium.
 * - 'live-panel'      — a real, currently-live page read directly through
 *                       the real extension in real Chromium — no freeze
 *                       step. ("Panel" per §9's debug tab; here read via
 *                       the same chrome.tabs.sendMessage path the panel
 *                       itself uses, driven by Playwright rather than a
 *                       human click — see collect-real-fixtures.ts's own
 *                       header for why, and §17 for the dated deviation
 *                       this substitutes for the manual GUI workflow.)
 */
import { z } from 'zod';

export const CorpusSourceSchema = z.enum(['hand-built', 'frozen-capture', 'live-panel']);
export type CorpusSource = z.infer<typeof CorpusSourceSchema>;

export const CorpusEntrySchema = z.object({
  id: z.string(),
  source: CorpusSourceSchema,
  snapshotFile: z.string(),
  goal: z.string(),
  gold: z.object({
    targetHandle: z.string().nullable(),
    targetDescription: z.string(),
    steps: z.array(z.string()),
  }),
});
export type CorpusEntry = z.infer<typeof CorpusEntrySchema>;
