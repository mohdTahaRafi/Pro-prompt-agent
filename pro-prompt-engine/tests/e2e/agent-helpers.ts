/**
 * Shared helpers for the actuation/verification e2e specs — sending
 * AGENT_* messages from an extension page (popup) and resolving a fixture
 * page's tabId. Every call to chrome.runtime.sendMessage happens from a
 * real extension page (never from inside the service worker's own
 * evaluate()), for the same reason tests/e2e/sensitive-untouched.spec.ts
 * documents: self-messaging from the SW has no receiving end.
 *
 * [Phase 5 §16] agentAct()'s old natural-language instruction (resolved via
 * lib/agent/intent.ts, deleted this phase) is replaced by resolveHandle() +
 * benchAct(): find the target's handle with a real PERCEIVE_STRUCTURE call,
 * then dispatch a structured Action through AGENT_BENCH_ACT (see that
 * message's own comment for why this bypasses planning rather than
 * reintroducing intent resolution for tests).
 */
import type { Page } from '@playwright/test';

export async function grant(popup: Page, origin: string) {
  const res = await popup.evaluate(async (o) => {
    return chrome.runtime.sendMessage({ type: 'GRANT_ORIGIN', payload: { origin: o } });
  }, origin);
  return res as { status: string };
}

/** Mirrors the exact chrome.tabs.query pattern already proven by
 *  tests/e2e/perception-milestone.spec.ts: a wildcard match on the origin,
 *  narrowed to the specific URL requested when more than one tab shares it. */
export async function tabIdFor(popup: Page, url: string): Promise<number> {
  const origin = new URL(url).origin;
  const tabs = await popup.evaluate((o) => chrome.tabs.query({ url: `${o}/*` }), origin) as chrome.tabs.Tab[];
  const match = tabs.find((t) => t.url === url) ?? tabs[0];
  if (!match?.id) throw new Error(`no tab found for ${url}`);
  return match.id;
}

/** Finds a handle by (role, a case-insensitive substring of its accessible
 *  name) via a real PERCEIVE_STRUCTURE call — the same content-script path
 *  production perception uses, unchanged since Phase 2. */
export async function resolveHandle(
  popup: Page, tabId: number, match: { role?: string; nameIncludes?: string },
): Promise<string> {
  const res = await popup.evaluate(async (tabId) => {
    return chrome.tabs.sendMessage(tabId, { type: 'PERCEIVE_STRUCTURE', runId: 'e2e', tokenBudget: 6_000 });
  }, tabId) as any;
  if (res?.status !== 'success') throw new Error(`PERCEIVE_STRUCTURE failed: ${JSON.stringify(res)}`);
  const elements = res.data.elements as Array<{ handle: string; role: string; name: string }>;
  const found = elements.find((e) =>
    (!match.role || e.role === match.role) &&
    (!match.nameIncludes || e.name.toLowerCase().includes(match.nameIncludes.toLowerCase())));
  if (!found) throw new Error(`no element matched ${JSON.stringify(match)} among ${JSON.stringify(elements.map((e) => [e.role, e.name]))}`);
  return found.handle;
}

/** [Phase 5 §16, e2e build only] AGENT_BENCH_ACT — see its message comment. */
export async function benchAct(popup: Page, tabId: number, action: unknown) {
  return popup.evaluate(async ({ tabId, action }) => {
    return chrome.runtime.sendMessage({ type: 'AGENT_BENCH_ACT', payload: { tabId, action } });
  }, { tabId, action });
}

export async function benchApprove(popup: Page, requestId: string, approve: boolean) {
  return popup.evaluate(async ({ requestId, approve }) => {
    return chrome.runtime.sendMessage({ type: 'AGENT_BENCH_APPROVE', payload: { requestId, approve } });
  }, { requestId, approve });
}

/** Fires an AGENT_BENCH_ACT without awaiting its response — used when the
 *  response is expected to take a long time (a slow-settling page) and the
 *  test needs to do something else (press Stop) while it is still in flight. */
export async function benchActFireAndForget(popup: Page, tabId: number, action: unknown) {
  await popup.evaluate(({ tabId, action }) => {
    void chrome.runtime.sendMessage({ type: 'AGENT_BENCH_ACT', payload: { tabId, action } });
  }, { tabId, action });
}

export async function agentStop(popup: Page, runId: number) {
  return popup.evaluate(async (runId) => {
    return chrome.runtime.sendMessage({ type: 'AGENT_STOP', payload: { runId } });
  }, runId);
}

export async function agentRunEvents(popup: Page, runId: number) {
  return popup.evaluate(async (runId) => {
    return chrome.runtime.sendMessage({ type: 'AGENT_GET_RUN_EVENTS', payload: { runId } });
  }, runId);
}

/** [Phase 3 §15, e2e build only] calls gate() directly, skipping
 *  perceive/resolveIntent — see lib/schemas/message.schema.ts's
 *  AgentBenchGateRequest comment. Used by gate-wake.bench.ts. */
export async function agentBenchGate(popup: Page, tabId: number) {
  return popup.evaluate(async (tabId) => {
    return chrome.runtime.sendMessage({ type: 'AGENT_BENCH_GATE', payload: { tabId } });
  }, tabId);
}

export async function agentListRuns(popup: Page) {
  return popup.evaluate(async () => chrome.runtime.sendMessage({ type: 'AGENT_LIST_RUNS' }));
}

/** [Phase 5 acceptance audit, 2026-09-13, e2e build only] AGENT_BENCH_SET_STATE
 *  — see its message-schema comment. */
export async function benchSetState(popup: Page, runId: number, state: string) {
  return popup.evaluate(async ({ runId, state }) => {
    return chrome.runtime.sendMessage({ type: 'AGENT_BENCH_SET_STATE', payload: { runId, state } });
  }, { runId, state });
}
