/**
 * Tier classification — verb × target × origin → risk tier.
 * Docs/planning/phase_3_gate_actuation_verification.md §5.
 *
 * classifyTier() and classifyClick() are pure, synchronous, and do no I/O —
 * the gate calls them with data it has already loaded. hasUnsavedUserInput()
 * (§5.3) is the one exception: it is async and reads the ownership ledger
 * and the journal, because "did THIS run write this value" is a question
 * only the journal can answer. The gate calls it directly for the `navigate`
 * verb only, after classifyTier() has already returned its base tier — see
 * the file header note on that function for why the escalation isn't
 * folded into the synchronous switch.
 *
 * [Phase 6] classifyTier/classifyClick themselves now LIVE in
 * lib/policy/tier-classify.ts and are re-exported here unchanged — see
 * that file's header for why: lib/page/overlay-dismiss.ts (a content
 * script) needs classifyClick without pulling this file's
 * ownership.ts/journal.ts imports (and, through journal.ts, the whole
 * Dexie database singleton) into the content-script bundle. Every
 * pre-Phase-6 importer of this module is unaffected — the same two names
 * are still exported from '@lib/policy/tiers'.
 */
import * as ownership from '@lib/policy/ownership';
import * as journal from '@lib/agent/journal';

export { classifyTier, classifyClick } from '@lib/policy/tier-classify';

const TEXT_INPUT_TYPES = new Set([
  'text', 'email', 'tel', 'url', 'search', 'number', 'date', 'datetime-local',
  'month', 'week', 'time', 'textarea',
]);

// ── §5.3 navigate and unsaved input ──

/**
 * "Unsaved input" is determined by the gate from the ledger, not by asking
 * the page: any descriptor in the current epoch whose inputType is a text
 * kind and whose valueShape is not 'empty', where that value was NOT
 * written by this run. The journal is the record of what this run wrote,
 * so the check is a journal query, not a heuristic (PR-NAV-3).
 */
export async function hasUnsavedUserInput(runId: number, tabId: number): Promise<boolean> {
  const ledger = await ownership.forTab(runId, tabId);
  if (!ledger) return false;
  const written = new Set(
    (await journal.query(runId, 'action.observed'))
      .filter((e) => (e.data as { verb?: string })?.verb === 'type' && e.tabId === tabId)
      .map((e) => (e.data as { handle?: string }).handle),
  );
  return Object.entries(ledger.handles).some(([h, d]) =>
    TEXT_INPUT_TYPES.has(d.inputType ?? '') && d.valueShape !== 'empty' && !written.has(h));
}
