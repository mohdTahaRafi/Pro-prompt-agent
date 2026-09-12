/**
 * Reporter — journal → summary. Minimal this phase (§10, §16): a plain
 * enumeration, e.g. "12 actions, 11 confirmed, 1 unconfirmed." The real
 * report — grouped, gap-aware, with reason codes for every unconfirmed or
 * skipped step — is Phase 6.
 * Docs/planning/phase_5_agent_loop.md §10, §11 task 5.14.
 *
 * Composed from the journal, never from the planner (§3.7.5, §10): the
 * `finish` action's own `summary` field (whatever a model produced) is
 * NEVER used verbatim — this is the one and only source of the text that
 * ends up on `run.completed`.
 */
import { query } from '@lib/agent/journal';
import type { Verified } from '@lib/types/agent.types';

export interface JournalCounts {
  actions: number;
  confirmed: number;
  unconfirmed: number;
  failed: number;
}

export async function countOutcomes(runId: number): Promise<JournalCounts> {
  const observed = await query(runId, 'action.observed');
  const counts: JournalCounts = { actions: 0, confirmed: 0, unconfirmed: 0, failed: 0 };
  for (const e of observed) {
    const data = e.data as { verified?: Verified };
    if (!data?.verified) continue;   // read verbs journal action.observed too, with no verdict to tally
    counts.actions += 1;
    if (data.verified === 'confirmed') counts.confirmed += 1;
    else if (data.verified === 'unconfirmed') counts.unconfirmed += 1;
    else counts.failed += 1;
  }
  return counts;
}

export function summaryText(counts: JournalCounts): string {
  const parts = [`${counts.actions} action${counts.actions === 1 ? '' : 's'}`];
  if (counts.confirmed) parts.push(`${counts.confirmed} confirmed`);
  if (counts.unconfirmed) parts.push(`${counts.unconfirmed} unconfirmed`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  return parts.join(', ');
}

export async function summarize(runId: number): Promise<{ counts: JournalCounts; text: string }> {
  const counts = await countOutcomes(runId);
  return { counts, text: summaryText(counts) };
}
