/**
 * Cockpit — the side panel. Docs/planning/phase_5_agent_loop.md §9.1, §11 tasks 5.9, 5.10, 5.12, 5.13, 5.14.
 *
 * Renders from the journal and the run state, NEVER from planner narration
 * (§3.2 ownership rules, architecture.md). It subscribes to `db.runEvents`
 * and `db.runs` via a Dexie liveQuery, not a message round trip — if the
 * planner said it would do something and the journal has no `action.observed`
 * for it, this panel shows it as pending or failed, never as done.
 *
 * `chrome.sidePanel` (Chrome 114+) is the only extension surface that
 * survives page navigation AND sits beside the page — a run that navigates
 * would destroy an in-page React tree and its state (§3.4).
 */
import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@lib/db/dexie-db';
import type { RunRecord, RunEvent } from '@lib/types/run.types';
import type { Plan, PlanStep } from '@lib/schemas/plan.schema';
import type { Action } from '@lib/schemas/action.schema';
import type { ApprovalPrompt, VerificationResult } from '@lib/types/agent.types';

function send<T = any>(type: string, payload?: unknown): Promise<T> {
  return chrome.runtime.sendMessage({ type, payload }).then((r: any) => {
    if (r?.status === 'error') throw new Error(r.message);
    return r?.data as T;
  });
}

const TERMINAL_STATES = new Set<RunRecord['state']>(['halted', 'stopped', 'failed', 'completed']);

interface BudgetSnapshot {
  actions: number; plannerCalls: number; startedAt: number; pausedMs: number;
  limits: { maxActions: number; maxWallClockMs: number };
}

/** Reads the shared Budget's own mirror (lib/agent/budget.ts) directly out
 *  of chrome.storage.session and stays live via chrome.storage.onChanged —
 *  the SAME numbers gate check 6.5 enforces against, not a re-derived
 *  approximation from the journal. */
function useBudget(runId: number | undefined): BudgetSnapshot | null {
  const [snap, setSnap] = useState<BudgetSnapshot | null>(null);
  useEffect(() => {
    if (runId === undefined) { setSnap(null); return; }
    const key = `budget:${runId}`;
    chrome.storage.session.get(key).then((r) => setSnap((r[key] as BudgetSnapshot) ?? null));
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && key in changes) setSnap((changes[key].newValue as BudgetSnapshot) ?? null);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [runId]);
  return snap;
}

function useElapsedLabel(budget: BudgetSnapshot | null): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => clearInterval(id);
  }, []);
  if (!budget) return '0:00';
  const ms = Date.now() - budget.startedAt - budget.pausedMs;
  const s = Math.max(0, Math.round(ms / 1_000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function actionSummary(a: Action): string {
  switch (a.verb) {
    case 'click': return `Click`;
    case 'type': return `Type "${a.text}"`;
    case 'select': return `Select "${a.value}"`;
    case 'navigate': return `Go to ${a.url}`;
    case 'scroll': return 'Scroll';
    case 'history_back': return 'Go back';
    case 'history_forward': return 'Go forward';
    case 'ask_user': return `Ask: ${a.question}`;
    case 'finish': return 'Finish';
    default: return a.verb;
  }
}

function verdictBadge(v: VerificationResult['verified'] | undefined) {
  if (v === 'confirmed') return <span className="text-accent-green text-xs">✓ confirmed</span>;
  if (v === 'failed') return <span className="text-accent-red text-xs">✕ failed</span>;
  if (v === 'unconfirmed') return <span className="text-accent-yellow text-xs">⚠ unconfirmed</span>;
  return <span className="text-text-muted text-xs">…</span>;
}

// ── The constrained plan editor (§8): remove, reorder, edit intent text,
//    and add a step from verb x target-from-snapshot x value. No free-form
//    step text anywhere — a free-form step would be re-parsed by a model
//    into an action, reintroducing exactly the ambiguity the handle model
//    removes. ──

interface PickableElement { handle: string; role: string; name: string }
const ADDABLE_VERBS = ['click', 'type', 'select'] as const;

function buildStep(n: number, verb: (typeof ADDABLE_VERBS)[number], el: PickableElement, value: string): PlanStep {
  const action: Action =
    verb === 'click' ? { verb: 'click', handle: el.handle }
    : verb === 'type' ? { verb: 'type', handle: el.handle, text: value, mode: 'replace' }
    : { verb: 'select', handle: el.handle, value };
  return { n, intent: `${verb} "${el.name}"`, action, expectation: 'the page reflects this change', targetHint: { role: el.role, name: el.name } };
}

function PlanEditor({
  plan, elements, onStart, onReject, busy,
}: { plan: Plan; elements: PickableElement[]; onStart: (edited: Plan | undefined) => void; onReject: () => void; busy: boolean }) {
  const [steps, setSteps] = useState<PlanStep[]>(plan.steps);
  const [addVerb, setAddVerb] = useState<(typeof ADDABLE_VERBS)[number]>('click');
  const [addHandle, setAddHandle] = useState(elements[0]?.handle ?? '');
  const [addValue, setAddValue] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  const edited = useMemo(() => JSON.stringify(steps) !== JSON.stringify(plan.steps), [steps, plan.steps]);

  function remove(n: number) { setSteps((s) => s.filter((step) => step.n !== n)); }
  function move(n: number, dir: -1 | 1) {
    setSteps((s) => {
      const i = s.findIndex((step) => step.n === n);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.length) return s;
      const copy = [...s];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }
  function editIntent(n: number, intent: string) {
    setSteps((s) => s.map((step) => (step.n === n ? { ...step, intent } : step)));
  }
  function addStep() {
    const el = elements.find((e) => e.handle === addHandle);
    if (!el) return;
    const nextN = Math.max(0, ...steps.map((s) => s.n)) + 1;
    setSteps((s) => [...s, buildStep(nextN, addVerb, el, addValue)]);
    setAddValue(''); setShowAdd(false);
  }

  return (
    <div className="card p-4 mb-3">
      <p className="text-small text-text-secondary mb-3">{plan.restatement}</p>
      {plan.clarifyingQuestion && <p className="text-small italic mb-3">{plan.clarifyingQuestion}</p>}

      <ol className="space-y-2 mb-3">
        {steps.map((s, i) => (
          <li key={s.n} className="text-small border-l-2 border-primary/40 pl-3 flex items-start gap-2">
            <div className="flex-1">
              <input
                value={s.intent}
                onChange={(e) => editIntent(s.n, e.target.value)}
                className="input-field text-small py-1 mb-1"
                aria-label={`Step ${i + 1} intent`}
              />
              <span className="text-xs text-text-muted block">{actionSummary(s.action)} — expects: {s.expectation}</span>
            </div>
            <div className="flex flex-col gap-1">
              <button onClick={() => move(s.n, -1)} disabled={i === 0} className="btn-icon w-6 h-6 text-xs disabled:opacity-30" title="Move up">↑</button>
              <button onClick={() => move(s.n, 1)} disabled={i === steps.length - 1} className="btn-icon w-6 h-6 text-xs disabled:opacity-30" title="Move down">↓</button>
              <button onClick={() => remove(s.n)} className="btn-icon w-6 h-6 text-xs text-accent-red" title="Remove step">✕</button>
            </div>
          </li>
        ))}
        {steps.length === 0 && <li className="text-small italic text-text-muted">No steps.</li>}
      </ol>

      <h4 className="text-body font-semibold mb-1">What I will not do</h4>
      <ul className="text-small text-text-secondary list-disc list-inside mb-3">
        {plan.willNotDo.length === 0 ? <li className="list-none italic">(nothing declared)</li> : plan.willNotDo.map((w, i) => <li key={i}>{w}</li>)}
      </ul>

      {!showAdd ? (
        <button onClick={() => setShowAdd(true)} disabled={elements.length === 0} className="btn-secondary px-3 py-1.5 text-xs border border-border-default mb-3 disabled:opacity-50">
          + Add a step
        </button>
      ) : (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <select value={addVerb} onChange={(e) => setAddVerb(e.target.value as any)} className="input-field text-xs py-1 w-24">
            {ADDABLE_VERBS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <select value={addHandle} onChange={(e) => setAddHandle(e.target.value)} className="input-field text-xs py-1 flex-1">
            {elements.map((el) => <option key={el.handle} value={el.handle}>{el.role} "{el.name}"</option>)}
          </select>
          {addVerb !== 'click' && (
            <input value={addValue} onChange={(e) => setAddValue(e.target.value)} placeholder="value" className="input-field text-xs py-1 w-28" />
          )}
          <button onClick={addStep} className="btn-primary px-3 py-1 text-xs">Add</button>
          <button onClick={() => setShowAdd(false)} className="btn-secondary px-2 py-1 text-xs border border-border-default">Cancel</button>
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={() => onStart(edited ? { ...plan, steps: steps.map((s, i) => ({ ...s, n: i + 1 })) } : undefined)}
          disabled={busy} className="btn-primary px-5 py-2 disabled:opacity-50">
          {busy ? '⏳' : '▶️'} Start
        </button>
        <button onClick={onReject} disabled={busy} className="btn-secondary px-4 py-2 border border-border-default disabled:opacity-50">Reject</button>
      </div>
    </div>
  );
}

// ── Main component ──

export default function Cockpit() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [goal, setGoal] = useState('');
  const [mode, setMode] = useState<RunRecord['mode']>('supervised');
  const [posture, setPosture] = useState<'local-only' | 'hybrid'>('local-only');
  const [disclosure, setDisclosure] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectReason, setShowRejectReason] = useState(false);
  const [askAnswer, setAskAnswer] = useState('');

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => setTabId(tabs[0]?.id ?? null));
    const onActivated = () => chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => setTabId(tabs[0]?.id ?? null));
    chrome.tabs.onActivated?.addListener?.(onActivated);
    return () => chrome.tabs.onActivated?.removeListener?.(onActivated);
  }, []);

  useEffect(() => {
    send<any>('GET_POSTURE_CAPABILITY', { posture }).then((cap) => setDisclosure(cap.disclosure.summary)).catch(() => setDisclosure(''));
  }, [posture]);

  const runs = useLiveQuery(() => db.runs.orderBy('startedAt').reverse().limit(20).toArray(), []) ?? [];
  const run = useMemo(
    () => (tabId === null ? undefined : runs.find((r) => r.roster.includes(tabId))),
    [runs, tabId],
  );
  const events = useLiveQuery<RunEvent[]>(
    () => (run?.id ? db.runEvents.where('runId').equals(run.id).sortBy('seq') : Promise.resolve([])),
    [run?.id],
  ) ?? [];

  const budget = useBudget(run?.id);
  const elapsed = useElapsedLabel(budget);

  const proposedEvent = events.find((e) => e.kind === 'plan.proposed');
  const elements: PickableElement[] = (proposedEvent?.data as any)?.elements ?? [];

  const observedWithVerdict = events.filter((e) => e.kind === 'action.observed' && (e.data as any)?.verified);
  const completedEvent = events.filter((e) => e.kind === 'run.completed').at(-1);

  // Latest approval.requested with no later grant/deny for the SAME requestId.
  const pendingApproval = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind === 'approval.requested') {
        const { requestId, prompt } = e.data as { requestId: string; prompt: ApprovalPrompt };
        const answered = events.some((x, j) => j > i && (x.kind === 'approval.granted' || x.kind === 'approval.denied') && (x.data as any)?.requestId === requestId);
        if (!answered) return { requestId, prompt };
      }
    }
    return null;
  }, [events]);

  const pendingAskUser = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind === 'ask_user.asked') {
        const answered = events.some((x, j) => j > i && x.kind === 'ask_user.answered');
        if (!answered) return e.data as { question: string; reason: string; options?: string[] };
      }
    }
    return null;
  }, [events]);

  async function startRun() {
    if (!tabId || !goal.trim()) return;
    setBusy(true); setError('');
    try {
      const data = await send<{ phase: string; reason?: string; ollamaPullCommand?: string; code?: string; message?: string }>(
        'AGENT_ADMIT_RUN', { tabId, goal: goal.trim(), mode, posture },
      );
      if (data.phase !== 'admitted') setError(data.message ?? data.reason ?? 'Could not start this run.');
    } catch (e: any) { setError(e?.message ?? String(e)); }
    setBusy(false);
  }

  async function approvePlan(editedPlan: Plan | undefined) {
    if (!run?.id) return;
    setBusy(true);
    try { await send('AGENT_PLAN_APPROVAL', { runId: run.id, approve: true, editedPlan }); }
    catch (e: any) { setError(e?.message ?? String(e)); }
    setBusy(false);
  }
  async function rejectPlan() {
    if (!run?.id) return;
    setBusy(true);
    try { await send('AGENT_PLAN_APPROVAL', { runId: run.id, approve: false }); }
    catch (e: any) { setError(e?.message ?? String(e)); }
    setBusy(false);
  }

  async function respondApproval(approve: boolean) {
    if (!run?.id || !pendingApproval) return;
    setBusy(true);
    try {
      await send('AGENT_APPROVAL_RESPONSE', {
        runId: run.id, requestId: pendingApproval.requestId, approve,
        reason: !approve && rejectReason.trim() ? rejectReason.trim() : undefined,
      });
      setRejectReason(''); setShowRejectReason(false);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    setBusy(false);
  }

  async function answerAskUser(answer: string) {
    if (!run?.id) return;
    setBusy(true);
    try { await send('AGENT_ASK_USER_ANSWER', { runId: run.id, answer }); setAskAnswer(''); }
    catch (e: any) { setError(e?.message ?? String(e)); }
    setBusy(false);
  }

  async function stop() {
    if (!run?.id) return;
    await send('AGENT_STOP', { runId: run.id });
  }
  async function pause() { if (run?.id) await send('AGENT_PAUSE', { runId: run.id }); }
  async function resume() { if (run?.id) await send('AGENT_RESUME', { runId: run.id }); }
  async function takeOver() { if (run?.id) await send('AGENT_TAKE_OVER', { runId: run.id }); }

  // ── No live run for this tab: the start form ──
  if (!run || TERMINAL_STATES.has(run.state)) {
    return (
      <div className="p-4">
        {run && TERMINAL_STATES.has(run.state) && (
          <div className="card p-4 mb-4">
            <h2 className="text-h2 font-semibold mb-1">
              {run.state === 'completed' ? 'Completed' : run.state === 'stopped' ? 'Stopped' : run.state === 'halted' ? 'Interrupted' : 'Failed'}
              {run.outcome === 'completed_with_gaps' ? ' with gaps' : ''}
            </h2>
            <p className="text-small text-text-secondary">
              {run.state === 'halted'
                ? 'This run was interrupted and has been halted. Start a new run to continue.'
                : (completedEvent?.data as any)?.summary ?? '—'}
            </p>
          </div>
        )}

        <h2 className="text-h1 font-bold mb-1">Start a run</h2>
        <p className="text-small text-text-secondary mb-4">
          State a multi-step task in plain terms. A plan is shown before anything runs.
        </p>

        <div className="card p-4 mb-3">
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <label className="text-small text-text-muted">Mode</label>
            <select value={mode} onChange={(e) => setMode(e.target.value as any)} className="input-field text-small py-1">
              <option value="supervised">Supervised (default)</option>
              <option value="suggest">Suggest</option>
              <option value="step">Step — approve every action</option>
            </select>
            <label className="text-small text-text-muted">Posture</label>
            <select value={posture} onChange={(e) => setPosture(e.target.value as any)} className="input-field text-small py-1">
              <option value="local-only">Local-only</option>
              <option value="hybrid">Hybrid</option>
            </select>
          </div>
          {disclosure && (
            <div className="text-small p-3 rounded-lg mb-3 border border-border-default">
              <span>{disclosure.split('**').map((part, i) => (i % 2 === 1 ? <b key={i}>{part}</b> : <span key={i}>{part}</span>))}</span>
            </div>
          )}
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3}
            placeholder='e.g. "Fill this in from my details and stop before submitting."'
            className="input-field mb-3" />
          <button onClick={startRun} disabled={!tabId || !goal.trim() || busy} className="btn-primary px-5 py-2 disabled:opacity-50 w-full">
            {busy ? '⏳ Starting…' : '🧭 Plan this task'}
          </button>
        </div>

        {error && <div className="card p-3 border border-accent-red/40 text-accent-red text-small">{error}</div>}
      </div>
    );
  }

  // ── A live run — always-visible header, then state-specific body ──
  return (
    <div className="p-4">
      <div className="mb-3">
        <h2 className="text-h2 font-semibold">{run.goal}</h2>
        <p className="text-xs text-text-muted">{run.origin} · {run.mode} · {run.posture}</p>
      </div>

      {run.state === 'planning' && <div className="card p-4 mb-3 text-small text-text-secondary">Planning… (usually a few seconds)</div>}

      {run.state === 'awaiting_plan_approval' && run.plan && (
        <PlanEditor plan={run.plan} elements={elements} onStart={approvePlan} onReject={rejectPlan} busy={busy} />
      )}

      {run.state !== 'planning' && run.state !== 'awaiting_plan_approval' && run.plan && (
        <div className="card p-4 mb-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-small font-medium">Steps</span>
            {budget && (
              <span className="text-xs text-text-muted">
                {budget.actions} of {budget.limits.maxActions} actions · {elapsed} elapsed
              </span>
            )}
          </div>
          <ol className="space-y-1.5">
            {run.plan.steps.map((s, i) => {
              const outcome = observedWithVerdict[i]?.data as any;
              const current = !outcome && i === observedWithVerdict.length;
              return (
                <li key={s.n} className={`text-small flex items-center justify-between gap-2 ${current ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>
                  <span>{s.intent}</span>
                  {outcome ? verdictBadge(outcome.verified) : current ? <span className="text-xs text-primary">running…</span> : <span className="text-xs text-text-muted">pending</span>}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {run.state === 'awaiting_approval' && pendingApproval && (
        <div className="card p-4 mb-3 border border-accent-yellow/40">
          <h3 className="text-body font-semibold mb-1">{pendingApproval.prompt.action}</h3>
          <p className="text-xs text-text-muted mb-2">on {pendingApproval.prompt.site}</p>
          <p className="text-small mb-3">{pendingApproval.prompt.consequence}</p>
          {showRejectReason && (
            <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Why? (optional)" className="input-field text-small mb-2" />
          )}
          <div className="flex gap-2">
            <button onClick={() => respondApproval(true)} disabled={busy} className="btn-primary px-4 py-2 disabled:opacity-50">✅ Approve</button>
            <button onClick={() => (showRejectReason ? respondApproval(false) : setShowRejectReason(true))} disabled={busy} className="btn-secondary px-4 py-2 border border-border-default disabled:opacity-50">
              ❌ {showRejectReason ? 'Reject' : 'Reject with reason'}
            </button>
          </div>
        </div>
      )}

      {run.state === 'awaiting_user' && pendingAskUser && (
        <div className="card p-4 mb-3 border border-primary/40">
          <p className="text-small mb-3">{pendingAskUser.question}</p>
          {pendingAskUser.options?.length ? (
            <div className="flex flex-wrap gap-2">
              {pendingAskUser.options.map((o) => (
                <button key={o} onClick={() => answerAskUser(o)} disabled={busy} className="btn-secondary px-3 py-1.5 text-xs border border-border-default disabled:opacity-50">{o}</button>
              ))}
            </div>
          ) : (
            <div className="flex gap-2">
              <input value={askAnswer} onChange={(e) => setAskAnswer(e.target.value)} className="input-field text-small flex-1"
                onKeyDown={(e) => { if (e.key === 'Enter' && askAnswer.trim()) answerAskUser(askAnswer.trim()); }} />
              <button onClick={() => askAnswer.trim() && answerAskUser(askAnswer.trim())} disabled={busy || !askAnswer.trim()} className="btn-primary px-4 py-2 disabled:opacity-50">Answer</button>
            </div>
          )}
        </div>
      )}

      {run.state === 'paused' && (
        <div className="card p-4 mb-3 text-small text-text-secondary">Paused. Nothing will run until you resume.</div>
      )}
      {run.state === 'taken_over' && (
        <div className="card p-4 mb-3 text-small text-text-secondary">You're driving. Press Resume when you're done.</div>
      )}

      <div className="flex gap-2 flex-wrap">
        {run.state === 'running' && <button onClick={pause} className="btn-secondary px-3 py-1.5 text-xs border border-border-default">⏸ Pause</button>}
        {(run.state === 'paused' || run.state === 'taken_over') && <button onClick={resume} className="btn-primary px-3 py-1.5 text-xs">▶️ Resume</button>}
        {run.state === 'running' && <button onClick={takeOver} className="btn-secondary px-3 py-1.5 text-xs border border-border-default">🖐 Take over</button>}
        {!TERMINAL_STATES.has(run.state) && <button onClick={stop} className="btn-secondary px-3 py-1.5 text-xs border border-accent-red/40 text-accent-red">⏹ Stop</button>}
      </div>

      {error && <div className="card p-3 mt-3 border border-accent-red/40 text-accent-red text-small">{error}</div>}
    </div>
  );
}
