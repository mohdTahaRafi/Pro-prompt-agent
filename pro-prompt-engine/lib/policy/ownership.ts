/**
 * Ownership — the gate's shadow ledger of handles. Service worker only.
 * Docs/planning/phase_3_gate_actuation_verification.md §4.4.
 *
 * The gate cannot see the content script's registry — that lives in the
 * page's isolated world. So the gate keeps its own record: when a snapshot
 * crosses into the service worker, record() stores {runId, tabId, epoch,
 * handle → descriptor} in chrome.storage.session.
 *
 * Why chrome.storage.session rather than memory: the service worker is
 * terminated on idle and the gate is routinely cold-started. An in-memory
 * ledger would be empty on the first action after a wake, refusing every
 * handle with UNKNOWN_HANDLE. storage.session survives the wake, dies with
 * the browser, and never touches disk — the exact lifetime a handle ledger
 * should have.
 *
 * Why the ledger duplicates the descriptor rather than asking the content
 * script: the tier classifier needs the target's role, name and input type
 * to decide (§5), and it must decide WITHOUT asking the content script,
 * because the content script is on the page the model was influenced by. A
 * gate that phoned the page to ask "what kind of element is this?" would let
 * the page answer.
 *
 * Why record() keeps only the latest epoch per tab, not a history: a
 * request naming an epoch older than what is currently recorded can never
 * be the epoch that is actually live on the page any more — the ledger
 * doesn't need to remember what an old epoch looked like to know that a
 * request against it is stale, only that the epoch it holds now disagrees.
 */
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import type { LedgerDescriptor } from '@lib/types/agent.types';

interface TabLedger {
  epoch: number;
  handles: Record<string, LedgerDescriptor>;
}
type RunLedger = Record<number, TabLedger>;   // keyed by tabId

const key = (runId: number) => `own:${runId}`;

async function load(runId: number): Promise<RunLedger> {
  const store = (await chrome.storage.session.get(key(runId)))[key(runId)] as RunLedger | undefined;
  return store ?? {};
}

async function save(runId: number, store: RunLedger): Promise<void> {
  await chrome.storage.session.set({ [key(runId)]: store });
}

export async function record(runId: number, tabId: number, snap: PerceptionSnapshot): Promise<void> {
  const store = await load(runId);
  store[tabId] = {
    epoch: snap.epoch,
    handles: Object.fromEntries(snap.elements.map((e) => [e.handle, {
      role: e.role, name: e.name, inputType: e.inputType, ordinal: e.ordinal,
      formId: e.formId, actionable: e.actionable, valueShape: e.valueShape,
      href: e.href, sensitiveKind: e.sensitiveKind ?? null,
    } satisfies LedgerDescriptor])),
  };
  await save(runId, store);
}

export interface Owner {
  tabId: number;
  epoch: number;
  descriptor: LedgerDescriptor;
}

/**
 * Finds which tab (if any) currently owns this handle. Prefers a tab whose
 * recorded epoch matches the request's epoch exactly — the unambiguous,
 * still-live case. Failing that, falls back to any tab that has ever
 * recorded this handle string, so the gate's epoch comparison (not this
 * function) is what produces STALE_EPOCH rather than a false UNKNOWN_HANDLE.
 * Only a handle recorded in NO tab at all is genuinely unknown.
 */
export async function lookup(runId: number, handle: string, epoch: number): Promise<Owner | null> {
  const store = await load(runId);
  let fallback: Owner | null = null;
  for (const [tabIdStr, ledger] of Object.entries(store)) {
    const d = ledger.handles[handle];
    if (!d) continue;
    const owner: Owner = { tabId: Number(tabIdStr), epoch: ledger.epoch, descriptor: d };
    if (ledger.epoch === epoch) return owner;
    if (!fallback) fallback = owner;
  }
  return fallback;
}

/** The stored descriptor for a handle, searched across the run's whole
 *  ledger. Callers that need ownership (tabId/epoch) identity use lookup()
 *  instead — this is for the tier classifier (§5), which by the time it
 *  runs (gate check 5) has already had ownership validated at check 4. */
export async function descriptor(runId: number, handle?: string): Promise<LedgerDescriptor | null> {
  if (!handle) return null;
  const store = await load(runId);
  for (const ledger of Object.values(store)) {
    const d = ledger.handles[handle];
    if (d) return d;
  }
  return null;
}

/** The full recorded ledger for one tab — used by §5.3's unsaved-input
 *  check, which needs every currently-known text field, not just one. */
export async function forTab(runId: number, tabId: number): Promise<TabLedger | null> {
  const store = await load(runId);
  return store[tabId] ?? null;
}

/** Test/cleanup only — drops a run's entire ledger. */
export async function clear(runId: number): Promise<void> {
  await chrome.storage.session.remove(key(runId));
}
