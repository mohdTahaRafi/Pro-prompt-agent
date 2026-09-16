/**
 * Reporter — journal → the end-of-run report. [Phase 6, full rewrite]
 * Docs/planning/phase_6_recovery_journal_reporting.md §6.
 *
 * THE RULE (§6.1): buildReport() has NO ACCESS TO PLANNER OUTPUT. `run.plan`
 * is read for step LABELS only (`n`, `intent`) — every verdict, evidence
 * string, gap, question and count comes from `runEvents`. This file imports
 * nothing from lib/agent/planner.ts (task 6.10's own import-boundary
 * assertion, checked directly by tests/unit/journal.spec.ts). A step the
 * journal cannot evidence cannot be reported as done — not as a matter of
 * prompt discipline, because the data required to claim it simply is not
 * there.
 *
 * Supersedes the Phase 5 stub (`countOutcomes`/`summaryText`/`summarize`) —
 * lib/agent/supervisor.ts is the only other caller and now calls
 * buildReport()/summaryTextFor() instead.
 */
import { query } from '@lib/agent/journal';
import { db } from '@lib/db/dexie-db';
import type { RunEvent } from '@lib/types/run.types';
import type { Plan } from '@lib/schemas/plan.schema';
import type { AskReason } from '@lib/types/agent.types';

// ── §6.2 — the shape ──

export interface RunReport {
  goal: string;
  outcome: 'completed' | 'completed_with_gaps' | 'failed' | 'stuck' | 'stopped';
  steps: ReportedStep[];
  gaps: Gap[];
  questions: AskedQuestion[];
  disclosure: { remoteCalls: number; provider?: string; classA: number; classB: number };
  counts: { attempted: number; confirmed: number; unconfirmed: number; failed: number; recovered: number; skipped: number };
}

export interface ReportedStep {
  n: number;
  intent: string;
  verdict: 'confirmed' | 'unconfirmed' | 'failed' | 'skipped' | 'not_attempted';
  evidence?: string;          // "field now reads 'Mohd Taha'" — from the journal
  attempts: number;
  recoveredBy?: string;       // "clicked to focus, then retyped"
  tabId: number | null;       // [Phase 7 renders this; single-tab hides it]
  sourceUrl: string;          // where this happened — traceability (PR-VER-6)
}

export interface Gap {
  kind: 'unconfirmed' | 'not_found' | 'needs_user' | 'refused' | 'skipped_by_user';
  what: string;               // "Refresh rate"
  where: string;              // "monitor-c.example.com/specs"
  why: string;                // "not present on the page after expanding all sections"
}

export interface AskedQuestion {
  question: string;
  reason: AskReason;
  stepN: number | null;
  answer?: string;
}

// ── Entry point ──

export async function buildReport(runId: number): Promise<RunReport> {
  const allEvents = await query(runId);
  const run = await db.runs.get(runId);
  // The ONLY inputs. run.plan is read for step LABELS; every verdict, value
  // and claim comes from events. tests/unit/journal.spec.ts asserts that
  // removing run.plan changes only the labels and none of the outcomes.
  const plan = run?.plan;

  const generationEvents = latestGenerationEvents(allEvents);

  return {
    goal: run?.goal ?? '',
    outcome: deriveOutcome(allEvents),
    steps: deriveSteps(generationEvents, plan),
    gaps: deriveGaps(generationEvents, plan),
    questions: deriveQuestions(allEvents),
    disclosure: deriveDisclosure(allEvents),
    counts: deriveCounts(generationEvents, plan),
  };
}

/** A plain-language one-liner for `run.completed`'s own `summary` field —
 *  replaces Phase 5's countOutcomes()-based summaryText(). Never echoes a
 *  planner-supplied summary verbatim (§6, architecture.md §3.7.5) — built
 *  entirely from the already-derived report. */
export function summaryTextFor(report: RunReport): string {
  const { confirmed, unconfirmed, failed, recovered } = report.counts;
  const parts = [`${report.counts.attempted} action${report.counts.attempted === 1 ? '' : 's'}`];
  if (confirmed) parts.push(`${confirmed} confirmed`);
  if (unconfirmed) parts.push(`${unconfirmed} unconfirmed`);
  if (failed) parts.push(`${failed} failed`);
  if (recovered) parts.push(`${recovered} recovered`);
  let text = parts.join(', ');
  if (report.gaps.length > 0) {
    text += `. ${report.gaps.length} unknown: ${report.gaps.map((g) => `"${g.what}"`).join(', ')}.`;
  }
  return text;
}

// ── §6.1's "no access to planner output" boundary, mechanically ──
// A run that replanned overwrites run.plan with the NEW plan (§4.3) — its
// step numbering starts over from 1, independent of the previous
// generation's. Events journaled against an earlier generation's stepN
// would otherwise collide with the CURRENT plan's identically-numbered
// steps. Only events at or after the run's LAST plan.approved/
// plan.replanned are correlated against run.plan.steps — everything
// earlier is still counted in deriveQuestions()/deriveDisclosure() (which
// are generation-independent) but not attributed to a step label.
function latestGenerationEvents(events: RunEvent[]): RunEvent[] {
  let startSeq = 0;
  for (const e of events) {
    if (e.kind === 'plan.approved' || e.kind === 'plan.replanned') startSeq = e.seq;
  }
  return events.filter((e) => e.seq >= startSeq);
}

// ── outcome ──

function deriveOutcome(events: RunEvent[]): RunReport['outcome'] {
  const completed = [...events].reverse().find((e) => e.kind === 'run.completed');
  const outcome = (completed?.data as { outcome?: RunReport['outcome'] } | undefined)?.outcome;
  return outcome ?? 'failed';
}

// ── steps ──

function stepNOf(e: RunEvent): number | null {
  const n = (e.data as { stepN?: unknown } | undefined)?.stepN;
  return typeof n === 'number' ? n : null;
}

function deriveSteps(events: RunEvent[], plan: Plan | undefined): ReportedStep[] {
  if (!plan) return [];
  const byStep = new Map<number, RunEvent[]>();
  for (const e of events) {
    const n = stepNOf(e);
    if (n === null) continue;
    if (!byStep.has(n)) byStep.set(n, []);
    byStep.get(n)!.push(e);
  }

  return plan.steps.map((step) => {
    const stepEvents = byStep.get(step.n) ?? [];
    const observed = stepEvents.filter((e) => e.kind === 'action.observed');
    const refused = stepEvents.filter((e) => e.kind === 'action.refused');
    const recovered = stepEvents.filter((e) => e.kind === 'recovery.recovered');
    const asked = stepEvents.filter((e) => e.kind === 'ask_user.asked');
    const answered = stepEvents.some((e) => e.kind === 'ask_user.answered');

    const last = observed.at(-1)?.data as
      | { verified?: 'confirmed' | 'unconfirmed' | 'failed'; evidence?: { before?: string; after?: string; detail?: string }; tabId?: number; url?: string }
      | undefined;

    let verdict: ReportedStep['verdict'];
    let evidence: string | undefined;
    if (last?.verified) {
      verdict = last.verified;
      evidence = evidenceTextFor(last.evidence);
    } else if (asked.length > 0) {
      verdict = answered ? 'confirmed' : 'unconfirmed';
      evidence = answered ? 'the user answered' : undefined;
    } else if (refused.length > 0) {
      verdict = 'failed';
      evidence = `refused: ${(refused.at(-1)?.data as { code?: string } | undefined)?.code ?? 'unknown'}`;
    } else {
      verdict = 'not_attempted';
    }

    const lastObservedData = observed.at(-1)?.data as { url?: string } | undefined;
    const sourceUrl = lastObservedData?.url ?? '';

    return {
      n: step.n,
      intent: step.intent,
      verdict,
      evidence,
      attempts: Math.max(1, observed.length),
      recoveredBy: recovered.at(-1) ? (recovered.at(-1)!.data as { method?: string }).method : undefined,
      tabId: stepEvents[0]?.tabId ?? null,
      sourceUrl,
    };
  });
}

function evidenceTextFor(ev?: { before?: string; after?: string; detail?: string }): string | undefined {
  if (!ev) return undefined;
  if (ev.after !== undefined) return `now reads "${ev.after}"`;
  if (ev.detail) return ev.detail;
  return undefined;
}

// ── gaps ──

function deriveGaps(events: RunEvent[], plan: Plan | undefined): Gap[] {
  const gaps: Gap[] = [];
  const origin = originOf(events);

  if (plan) {
    const byStep = new Map<number, RunEvent[]>();
    for (const e of events) {
      const n = stepNOf(e);
      if (n === null) continue;
      if (!byStep.has(n)) byStep.set(n, []);
      byStep.get(n)!.push(e);
    }
    for (const step of plan.steps) {
      const stepEvents = byStep.get(step.n) ?? [];
      const observed = stepEvents.filter((e) => e.kind === 'action.observed');
      const last = observed.at(-1)?.data as { verified?: string; url?: string; evidence?: { detail?: string } } | undefined;
      const asked = stepEvents.filter((e) => e.kind === 'ask_user.asked');
      const answered = stepEvents.some((e) => e.kind === 'ask_user.answered');

      if (observed.length === 0 && asked.length === 0) {
        gaps.push({ kind: 'not_found', what: step.intent, where: origin, why: 'the run ended before this step was attempted' });
      } else if (last?.verified === 'unconfirmed') {
        gaps.push({ kind: 'unconfirmed', what: step.intent, where: last.url ?? origin, why: last.evidence?.detail ?? 'could not confirm this took effect' });
      } else if (asked.length > 0 && !answered) {
        gaps.push({ kind: 'needs_user', what: step.intent, where: origin, why: 'still waiting on the user' });
      }
    }
  }

  // [Phase 6 §6.3, J-2] region shown/total shortfall from every read_structure
  // event — real numbers from the walk itself, not re-derived. Each MISSING
  // row is reported as its own `not_found` gap with the region's label as
  // `what`, exactly matching "2 unknown — 'Refresh rate' and 'Panel type'".
  // Individual field NAMES are not knowable from shown/total alone (the
  // walk does not report which specific rows were never rendered — only
  // how many); the region label plus a count is what is actually known,
  // and that is what is reported rather than a guessed field name.
  for (const e of events) {
    if (e.kind !== 'action.observed') continue;
    const data = e.data as { read?: { regions?: Array<{ regionId: string; label: string; shown: number; total: number }> }; url?: string } | undefined;
    for (const region of data?.read?.regions ?? []) {
      if (region.shown < region.total) {
        const missing = region.total - region.shown;
        gaps.push({
          kind: 'not_found',
          what: `${missing} of ${region.total} in "${region.label}"`,
          where: data?.url ?? origin,
          why: 'not present on the page read, even after settling',
        });
      }
    }
  }

  // [Phase 6 §3.5/§3.4] a run that ended via SITE_REFUSED or STOPPED before
  // any step ran produces exactly one gap naming the whole task, rather
  // than a `not_found` gap per unattempted step (already covered above for
  // per-step attribution when a plan exists).
  const refusal = [...events].reverse().find((e) => e.kind === 'site.refused');
  if (refusal) {
    const data = refusal.data as { kind?: string; evidence?: string };
    gaps.push({ kind: 'refused', what: 'the rest of this task', where: origin, why: data.evidence ?? 'the site refused to continue' });
  }

  return gaps;
}

function originOf(events: RunEvent[]): string {
  for (const e of events) {
    const url = (e.data as { url?: string } | undefined)?.url;
    if (url) { try { return new URL(url).host; } catch { /* fall through */ } }
  }
  return '';
}

// ── questions ──

function deriveQuestions(events: RunEvent[]): AskedQuestion[] {
  const questions: AskedQuestion[] = [];
  for (const e of events) {
    if (e.kind !== 'ask_user.asked') continue;
    const data = e.data as { question: string; reason: AskReason; stepN?: number };
    const answerEvent = events.find((x) => x.kind === 'ask_user.answered' && x.seq > e.seq);
    questions.push({
      question: data.question, reason: data.reason, stepN: data.stepN ?? null,
      answer: answerEvent ? (answerEvent.data as { answer?: string }).answer : undefined,
    });
  }
  return questions;
}

// ── disclosure ──

function deriveDisclosure(events: RunEvent[]): RunReport['disclosure'] {
  let remoteCalls = 0;
  let provider: string | undefined;
  let classA = 0;
  let classB = 0;
  for (const e of events) {
    if (e.kind === 'inference.remote') {
      remoteCalls += 1;
      const data = e.data as { provider?: string; disclosureClass?: 'A' | 'B' };
      if (data.provider) provider = data.provider;
      if (data.disclosureClass === 'A') classA += 1;
      else if (data.disclosureClass === 'B') classB += 1;
    }
  }
  return { remoteCalls, provider, classA, classB };
}

const SKIP_ANSWER_RE = /^\s*skip(\s+(this|it))?\s*$/i;

/** `skipped` is deliberately journal-only, never plan.steps.length-derived
 *  (§6.1's own hard rule — a run.plan deletion must change ONLY the report's
 *  step LABELS, and plan.steps.length is not a label). "Skipped" means the
 *  user explicitly said so when asked (§3's recovery-table asks routinely
 *  end with "...or should I skip it?") — a plan step the run never reached
 *  at all is a `not_found` Gap (deriveGaps), not a skip: nobody chose to
 *  skip it, the run simply never got there. */
function deriveCounts(events: RunEvent[], _plan: Plan | undefined): RunReport['counts'] {
  const counts = { attempted: 0, confirmed: 0, unconfirmed: 0, failed: 0, recovered: 0, skipped: 0 };
  for (const e of events) {
    if (e.kind === 'action.observed') {
      const data = e.data as { verified?: string };
      if (!data.verified) continue;   // read verbs journal action.observed too, no verdict to tally
      counts.attempted += 1;
      if (data.verified === 'confirmed') counts.confirmed += 1;
      else if (data.verified === 'unconfirmed') counts.unconfirmed += 1;
      else counts.failed += 1;
    }
    if (e.kind === 'recovery.recovered') counts.recovered += 1;
    if (e.kind === 'ask_user.answered') {
      const answer = (e.data as { answer?: string }).answer ?? '';
      if (SKIP_ANSWER_RE.test(answer)) counts.skipped += 1;
    }
  }
  return counts;
}
