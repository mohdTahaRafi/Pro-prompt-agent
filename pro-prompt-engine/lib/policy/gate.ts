/**
 * Policy Gate — the eight ordered checks every action passes through.
 * Docs/planning/phase_3_gate_actuation_verification.md §4.
 *
 * Runs in the service worker. The requester (the options page's Copilot
 * panel this phase; the offscreen document from Phase 5) never runs in the
 * same process — enforcement is not in the same memory, the same prompt, or
 * the same call stack as the thing being enforced (architecture.md §3.7.1).
 *
 * The gate NEVER calls a model. Every check is a pure function over
 * persisted state and the request. lib/policy/** imports nothing from
 * lib/model/** or lib/adapters/** — enforced by tests/unit/gate.spec.ts's
 * import-boundary assertion, not just this comment.
 *
 * Order is load-bearing: each check is cheaper than the one after it, and
 * each refusal is a distinct code so the report can say which boundary was
 * hit (§4.2, §4.3).
 */
import { db } from '@lib/db/dexie-db';
import { getSitePolicy, type SitePolicy } from '@lib/db/policy-store';
import { toOrigin, isGranted } from '@lib/policy/scope';
import * as ownership from '@lib/policy/ownership';
import { append as journalAppend } from '@lib/agent/journal';
import { canAct } from '@lib/agent/run-state';
import { classifyTier, hasUnsavedUserInput } from '@lib/policy/tiers';
import { anchorCheck } from '@lib/policy/goal-anchor';
import { readMirror, checkMirror, type BudgetError } from '@lib/agent/budget';
import { ActionSchema, handleOf, type Action, type ActionRequest } from '@lib/schemas/action.schema';
import type { RunRecord, RunState } from '@lib/types/run.types';
import type {
  ActionDecision, ApprovalPrompt, LedgerDescriptor, RefusalCode, Tier,
} from '@lib/types/agent.types';

/** The verb subset the gate will actually run this phase — the other eight
 *  parse successfully (§3) but are refused NOT_YET_IMPLEMENTED so the
 *  schema stays a stable target for Phase 4's constrained decoding. */
export const IMPLEMENTED_VERBS: ReadonlySet<Action['verb']> = new Set([
  'read_page', 'read_structure', 'read_element', 'wait_for_settle',
  'scroll', 'click', 'type', 'select',
  'navigate', 'history_back', 'history_forward',
  // [Phase 5 §10] the two control verbs — ask_user and finish.
  'ask_user', 'finish',
]);

function refuse(code: RefusalCode): ActionDecision {
  return { permitted: false, code };
}

async function refuseAndJournal(
  runId: number, tabId: number | null, verb: string | undefined, origin: string | undefined, code: RefusalCode,
): Promise<ActionDecision> {
  // Journaled BEFORE the response is returned (§4.3) — a refusal that is
  // not recorded is a refusal the report cannot explain.
  await journalAppend(runId, 'action.refused', tabId, { code, verb, tabId, origin });
  return refuse(code);
}

export async function gate(req: ActionRequest): Promise<ActionDecision> {
  // 1. RUN IDENTITY — does this run exist?
  const run = await db.runs.get(req.runId);
  if (!run) return refuseAndJournal(req.runId, req.tabId, req.action?.verb, undefined, 'UNKNOWN_RUN');

  // 2. TAB IDENTITY — is this tab in the run's roster, and does it still exist?
  if (!run.roster.includes(req.tabId)) {
    return refuseAndJournal(run.id!, req.tabId, req.action.verb, undefined, 'TAB_NOT_IN_ROSTER');
  }
  const tab = await chrome.tabs.get(req.tabId).catch(() => null);
  if (!tab || !tab.url) {
    return refuseAndJournal(run.id!, req.tabId, req.action.verb, undefined, 'TAB_GONE');
  }

  // 3. ORIGIN SCOPE OF THAT TAB — resolved from THIS tab's CURRENT url,
  //    never from the run's union of grants (architecture.md §3.7.17).
  const origin = toOrigin(tab.url);
  if (!origin) return refuseAndJournal(run.id!, req.tabId, req.action.verb, undefined, 'OUT_OF_SCOPE');
  if (!run.scope.includes(origin)) {
    return refuseAndJournal(run.id!, req.tabId, req.action.verb, origin, 'OUT_OF_SCOPE');
  }
  if (!(await isGranted(origin))) {   // Chrome is the truth
    return refuseAndJournal(run.id!, req.tabId, req.action.verb, origin, 'OUT_OF_SCOPE');
  }

  // 4. HANDLE OWNERSHIP — a handle from another tab's registry, or another
  //    epoch, is refused before any backend is consulted.
  const handle = handleOf(req.action);
  if (handle) {
    const owner = await ownership.lookup(req.runId, handle, req.epoch);
    if (!owner) return refuseAndJournal(run.id!, req.tabId, req.action.verb, origin, 'UNKNOWN_HANDLE');
    if (owner.tabId !== req.tabId) return refuseAndJournal(run.id!, req.tabId, req.action.verb, origin, 'HANDLE_NOT_OWNED');
    if (owner.epoch !== req.epoch) return refuseAndJournal(run.id!, req.tabId, req.action.verb, origin, 'STALE_EPOCH');
  }

  // 5. ACTION + RISK TIER — the verb must be in the vocabulary, in this
  //    run's permitted set, and its tier determines what happens next.
  const parsed = ActionSchema.safeParse(req.action);
  if (!parsed.success) return refuseAndJournal(run.id!, req.tabId, undefined, origin, 'MALFORMED_ACTION');
  if (!IMPLEMENTED_VERBS.has(parsed.data.verb)) {
    return refuseAndJournal(run.id!, req.tabId, parsed.data.verb, origin, 'NOT_YET_IMPLEMENTED');
  }
  const policy = await getSitePolicy(origin);
  if (!policy?.capabilities.includes(parsed.data.verb)) {
    return refuseAndJournal(run.id!, req.tabId, parsed.data.verb, origin, 'CAPABILITY_NOT_GRANTED');
  }

  // 3+. NAVIGATE'S DESTINATION, in addition to the source-tab check above
  // (§6.3 "Navigating"): the gate confirms the destination origin is in
  // scope and still actually granted BEFORE dispatch — a navigate to an
  // ungranted origin is OUT_OF_SCOPE against the destination, exactly like
  // check 3 is against the source, not merely a capability the source
  // origin happens to hold.
  if (parsed.data.verb === 'navigate') {
    const destOrigin = toOrigin(parsed.data.url);
    if (!destOrigin || !run.scope.includes(destOrigin) || !(await isGranted(destOrigin))) {
      return refuseAndJournal(run.id!, req.tabId, parsed.data.verb, destOrigin ?? origin, 'OUT_OF_SCOPE');
    }
  }

  const target = await ownership.descriptor(req.runId, handle);
  let tier = classifyTier(parsed.data, target, origin);
  if (parsed.data.verb === 'navigate' && (await hasUnsavedUserInput(req.runId, req.tabId))) {
    tier = 'always';   // PR-NAV-3 — computed here, not inside classifyTier,
                        // which stays synchronous (see tiers.ts header note)
  }
  if (tier === 'never') return refuseAndJournal(run.id!, req.tabId, parsed.data.verb, origin, 'NEVER_TIER');

  // 5.5. GOAL ANCHOR (Phase 5 §6) — an action inconsistent with the run's
  //      approved plan is refused before the run-state/budget/stop checks,
  //      which are about WHETHER the run may act at all, not WHETHER this
  //      particular action serves the goal it was admitted for.
  const anchored = await anchorCheck(run, parsed.data, target);
  if (!anchored.ok) return refuseAndJournal(run.id!, req.tabId, parsed.data.verb, origin, 'OFF_GOAL');

  // 6. RUN STATE — canAct is answered from a persisted string, with no
  //    interpreter to rehydrate on a cold service-worker wake. 'watch' mode
  //    is schema-declared but not built until Phase 11 (§7's table) —
  //    refused here, before canAct is even consulted.
  if (run.mode === 'watch') return refuseAndJournal(run.id!, req.tabId, parsed.data.verb, origin, 'RUN_STATE');
  if (!canAct(run.state)) return refuseAndJournal(run.id!, req.tabId, parsed.data.verb, origin, 'RUN_STATE');

  // 6.5. BUDGET (Phase 5 §4.2) — checked against the MIRRORED snapshot in
  //      chrome.storage.session, never against a live Budget instance: the
  //      Supervisor holding the real counters runs in the offscreen
  //      document, a different process from this gate, and a wedged or
  //      compromised Supervisor must not be able to exceed its own budget
  //      just because it stopped calling drawAction() honestly (task 5.4).
  const budgetSnap = await readMirror(req.runId);
  if (budgetSnap) {
    const budgetCheck = checkMirror(budgetSnap);
    if (!budgetCheck.ok) {
      return refuseAndJournal(run.id!, req.tabId, parsed.data.verb, origin, budgetCheck.error as BudgetError as RefusalCode);
    }
  }

  // 7. STOP STATE — read from chrome.storage.session, which survives a cold
  //    wake and never touches disk. Read LAST among the cheap checks so it
  //    is as close as possible in time to the dispatch.
  const stopKey = `stop:${req.runId}`;
  const { [stopKey]: stopped } = await chrome.storage.session.get(stopKey);
  if (stopped) return refuseAndJournal(run.id!, req.tabId, parsed.data.verb, origin, 'STOPPED');

  // 8. APPROVAL REQUIREMENT — Always tier, or a lower tier under a mode
  //    that requires it (§9).
  if (tier === 'always' || requiresApproval(tier, run.mode, policy)) {
    const prompt = buildApprovalPrompt(parsed.data, origin, target);
    await journalAppend(run.id!, 'approval.requested', req.tabId, { requestId: req.requestId, prompt, tier });
    return { permitted: false, tier, needsApproval: true, prompt };
  }

  await journalAppend(run.id!, 'action.permitted', req.tabId, { verb: parsed.data.verb, tier });
  return { permitted: true, tier };
}

/**
 * §7, §9 — which modes require approval below Always tier.
 *
 * 'step' (PR-AUT-3): every action requires approval, every tier — including
 * Low.
 *
 * 'suggest' (PR-AUT-2): "performs no action until told to proceed", THEN
 * behaves as Supervised (§7's table). Phase 3 had no planner to hold a plan
 * for suggest mode to gate on, so it applied the strictest available
 * reading (same as 'step') as a placeholder. Phase 5's Supervisor is what
 * actually enforces "no action until told to proceed" — it holds at
 * `awaiting_plan_approval` and issues no ActionRequest at all until the
 * plan is approved — so BY THE TIME any request reaches this function the
 * hold has already happened, and 'suggest' collapses into the same rule as
 * 'supervised' below.
 *
 * 'supervised' (PR-AUT-4, default): free on Low, always stops at Always
 * (the `tier === 'always'` branch above), and Medium follows this origin's
 * `sitePolicy.mediumRequiresApproval` (§11 task 5.8's "Medium where site
 * policy says so").
 *
 * 'watch' (PR-AUT-5, [Phase 11]) never reaches this function — the gate
 * refuses it with RUN_STATE before check 8 is ever evaluated.
 */
function requiresApproval(tier: Tier, mode: RunRecord['mode'], policy: SitePolicy | undefined): boolean {
  if (mode === 'step') return true;
  if (mode === 'suggest' || mode === 'supervised') {
    return tier === 'medium' && Boolean(policy?.mediumRequiresApproval);
  }
  return false;
}

// ── §9 — the four-part approval prompt ──

function buildApprovalPrompt(a: Action, origin: string, t: LedgerDescriptor | null): ApprovalPrompt {
  return {
    action: verbPhrase(a, t),
    target: targetPhrase(a, t),
    site: new URL(origin).hostname,
    consequence: consequenceFor(a, t),
    tier: 'always',
  };
}

function targetPhrase(a: Action, t: LedgerDescriptor | null): string {
  if (t) return t.name || `${t.role} ${t.ordinal}`;
  if (a.verb === 'navigate') return new URL(a.url).hostname;
  if (a.verb === 'history_back') return 'the previous page';
  if (a.verb === 'history_forward') return 'the next page';
  return 'this page';
}

function verbPhrase(a: Action, t: LedgerDescriptor | null): string {
  const name = t?.name ? `"${t.name}"` : targetPhrase(a, t);
  switch (a.verb) {
    case 'click': return `Click ${name}`;
    case 'type': return `Type into ${name}`;
    case 'select': return `Select a value in ${name}`;
    case 'navigate': return `Go to ${a.url}`;
    case 'history_back': return 'Go back';
    case 'history_forward': return 'Go forward';
    default: return `${a.verb} ${name}`;
  }
}

/** consequenceFor returns a SPECIFIC sentence per matched pattern, never a
 *  generic one (PR-APR-3/4) — tests/unit/approval-copy.spec.ts asserts no
 *  prompt string in the repository is generic. */
function consequenceFor(a: Action, t: LedgerDescriptor | null): string {
  const n = (t?.name ?? '').toLowerCase();
  if (a.verb === 'click') {
    if (t?.inputType === 'submit' || t?.inputType === 'image' || /submit|send|post|publish|order|checkout|apply|book/.test(n)) {
      return "I think this submits the form. It is likely irreversible and visible to the site's owner.";
    }
    if (/buy|purchase|pay|checkout|donate|transfer|withdraw/.test(n)) {
      return 'I think this involves money changing hands. It is likely irreversible.';
    }
    if (/delete|remove|deactivate|close[\s-]?account|cancel/.test(n)) {
      return 'I think this deletes or cancels something. It may not be reversible.';
    }
    if (/share|reply|comment|invite|report|block|unfriend/.test(n)) {
      return 'I think this is visible to other people once it runs.';
    }
    return "This site's rules mean I treat every action here as needing your approval.";
  }
  if (a.verb === 'type' || a.verb === 'select') {
    return "This site's rules mean I need your approval before writing here.";
  }
  if (a.verb === 'navigate') {
    return "This page has text you haven't saved; navigating away will lose it.";
  }
  return "This action can't be easily undone once it runs.";
}
