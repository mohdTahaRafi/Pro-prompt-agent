/**
 * Suspicion halts — four signals, run against every snapshot before it
 * reaches the planner. Docs/planning/phase_6_recovery_journal_reporting.md §5.
 * Replaces the Phase 3 stub (§17) that unconditionally returned 'allow'.
 *
 * A hit HALTS the run and names the reason (PR-SEC-15). Halting is a heavy
 * response and it is the right one — scoring suspicion and continuing below
 * a threshold puts a number between a detected attack and a stopped run,
 * and the number would be tuned downward the first time it caused a false
 * positive. tests/unit/suspicion.spec.ts's 30-clean-capture corpus is the
 * hard gate against exactly that erosion (§10: 0 false positives).
 *
 * SCOPING NOTE on "hidden text": lib/schemas/snapshot.schema.ts's
 * ElementDescriptor (Phase 2) carries a boolean `visible` — the outcome of
 * lib/page/perception.ts's checkVisibility()-based test (display, visibility,
 * opacity, zero-size, out-of-viewport) — not the finer techniques the
 * architecture doc names (`clip`, `font-size:0`, `color:transparent`). This
 * scan works from that boolean, which already catches the common cases
 * (display:none, visibility:hidden, zero-size) an injected instruction is
 * actually delivered through; it does NOT independently re-derive
 * clip-rect/font-size/color-based hiding from raw computed style, which
 * would need a snapshot-schema change (a live-DOM check, not something the
 * offscreen document that runs scan() can do against a serialized
 * PerceptionSnapshot at all). Named here rather than silently narrowed,
 * per §5's own "not immunity" disclaimer this file's exports carry forward.
 *
 * What this does NOT do, stated because PR-SEC-16 requires it: none of this
 * is immunity. A page can steer a choice within scope — a button named
 * "Continue to your account" — with no hidden text, no instruction shape,
 * no origin change and no credential request. This is one of six layers
 * (architecture.md §3.9), not the whole defence.
 */
import type { PerceptionSnapshot, ElementDescriptor } from '@lib/schemas/snapshot.schema';
import type { RunRecord } from '@lib/types/run.types';

export type SuspicionSignal = 'hidden_text' | 'instruction_shaped' | 'origin_drift' | 'credential_request';

export interface SuspicionHit {
  signal: SuspicionSignal;
  handle?: string;
  evidence: string;
}

export interface SuspicionResult {
  halt: boolean;
  hits: SuspicionHit[];
}

// Deliberately broad — false positives here cost a halt the user can
// dismiss and continue past; a missed instruction-shaped label costs
// nothing at all, catching it. The asymmetry favours the broad regex.
const INSTRUCTION_RE = new RegExp(
  '\\b(ignore (the |all )?(previous|prior|above)|disregard|new instructions?|system:|'
  + 'you are now|as an ai|do not tell|instead,? (you should|please))\\b',
  'i',
);

function isHiddenButNamed(el: ElementDescriptor): boolean {
  return !el.visible && el.name.trim().length > 0;
}

function scanElement(el: ElementDescriptor, hits: SuspicionHit[]): void {
  const name = el.name.trim();
  if (!name) return;

  if (isHiddenButNamed(el) && (name.length > 60 || INSTRUCTION_RE.test(name))) {
    hits.push({ signal: 'hidden_text', handle: el.handle, evidence: name.slice(0, 200) });
  }
  if (INSTRUCTION_RE.test(name)) {
    hits.push({ signal: 'instruction_shaped', handle: el.handle, evidence: name.slice(0, 200) });
  }
}

/**
 * Run against every snapshot BEFORE it reaches the planner or the judge
 * tier (§5) — lib/agent/tab-agent.ts's ensureSnapshot() is the one choke
 * point every perceive() passes through, for both planning and per-step
 * resolution, so calling scan() there covers both without a second call
 * site. `run` supplies the scope union and the run's first-snapshot
 * baseline (RunRecord.firstSnapshotExcludedCount, set once by the caller).
 */
export function scan(snap: PerceptionSnapshot, run: Pick<RunRecord, 'scope' | 'firstSnapshotExcludedCount'>): SuspicionResult {
  const hits: SuspicionHit[] = [];

  for (const el of snap.elements) scanElement(el, hits);

  if (!run.scope.includes(snap.origin)) {
    hits.push({ signal: 'origin_drift', evidence: snap.origin });
  }

  const baseline = run.firstSnapshotExcludedCount ?? 0;
  if (snap.excludedCount > 0 && baseline === 0) {
    hits.push({ signal: 'credential_request', evidence: `${snap.excludedCount} sensitive field(s) appeared` });
  }

  return { halt: hits.length > 0, hits };
}
