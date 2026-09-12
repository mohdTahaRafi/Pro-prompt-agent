/**
 * Reconcile — interrupted runs halt. Docs/planning/phase_5_agent_loop.md §3.1, §11 task 5.15.
 *
 * Split out of entrypoints/background.ts (mirroring lib/model/offscreen-bridge.ts's
 * own split) for exactly one reason: entrypoints/*.ts files are WXT
 * `defineBackground`/`defineContentScript` roots that only run inside the
 * built extension, not under plain Vitest (tests/unit/approval-copy.spec.ts's
 * header has the fuller note) — this module has no such wrapper, so
 * tests/unit/reconcile.spec.ts can call it directly against the chrome.*
 * test double.
 *
 * The service worker is stateless and may be terminated between any two
 * actions. Nothing about a run lives ONLY in the offscreen document's
 * Supervisor registry — that registry is re-derivable, not authoritative;
 * the `runs` row is. Any row in a non-terminal state whose Supervisor is
 * not (or can no longer be) found alive is journaled `run.interrupted` and
 * moved to `halted`. A run is never automatically resumed from here — the
 * persisted state, page state, tab state and element handles cannot be
 * verified trustworthy after an interruption.
 */
import { db } from '@lib/db/dexie-db';
import { ensureOffscreen } from '@lib/model/offscreen-bridge';
import * as journal from '@lib/agent/journal';
import type { RunState } from '@lib/types/run.types';
import type { ExtensionResponse } from '@lib/types/message.types';

const TERMINAL: RunState[] = ['halted', 'stopped', 'failed', 'completed'];

export async function askOffscreen<T = unknown>(message: Record<string, unknown>): Promise<T | undefined> {
  // [Phase 5 acceptance audit, 2026-09-13] ensureOffscreen() can now reject
  // (lib/model/offscreen-bridge.ts's readiness-race fix: it gives up after
  // a timeout instead of hanging forever) — folded into the SAME resilient
  // "never actually reached anyone" outcome as the sendMessage call below,
  // not left to bubble up raw. Every caller here (admitRun's `ack?.started`
  // check, relayRunControl's `ack?.found` check, reconcileRuns treating an
  // unreachable offscreen as "no known runs") already has its own specific
  // handling for "didn't get through"; an uncaught rejection here would
  // skip straight past all of it to a generic, unhelpful error instead.
  const res = await ensureOffscreen()
    .then(() => chrome.runtime.sendMessage({ target: 'offscreen', ...message }))
    .catch(() => undefined);
  return res?.data as T | undefined;
}

/**
 * [Phase 5 acceptance audit, 2026-09-13] The shared shape for every
 * run-control relay (plan approval, action approval, ask_user answer,
 * pause, resume, take over) in entrypoints/background.ts. Each targets a
 * specific Supervisor by runId inside the offscreen document's registry
 * (entrypoints/offscreen/main.ts); a Supervisor absent from that registry
 * (the run already ended, or the offscreen document never actually
 * received it — see lib/model/offscreen-bridge.ts's header) used to mean
 * every one of these six messages silently no-opped while still reporting
 * `{status:'success'}` back to the caller, indistinguishable from the
 * control having actually been applied. `found` (set by the matching
 * offscreen/main.ts case, true only when `supervisors.has(runId)`) is
 * what lets this tell the two apart.
 */
export async function relayRunControl(type: string, payload: Record<string, unknown>): Promise<ExtensionResponse> {
  const ack = await askOffscreen<{ found: boolean }>({ type, payload });
  if (!ack?.found) {
    return {
      status: 'error',
      message: "This run couldn't be reached — it may have already ended or the background service restarted.",
    };
  }
  return { status: 'success' };
}

export async function reconcileRuns(): Promise<void> {
  const live = await db.runs.where('state').noneOf(TERMINAL).toArray();
  if (live.length === 0) return;
  const known = (await askOffscreen<number[]>({ type: 'LIST_RUNS' })) ?? [];
  for (const run of live) {
    if (known.includes(run.id!)) continue;
    await journal.append(run.id!, 'run.interrupted', null, { atState: run.state, reason: 'AGENT_RUNTIME_LOST' });
    await db.runs.update(run.id!, { state: 'halted', outcome: 'failed', endedAt: Date.now() });
  }
}
