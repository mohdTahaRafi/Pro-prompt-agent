/**
 * Shared helpers for the Phase 3 e2e specs — sending AGENT_* messages from
 * an extension page (popup) and resolving a fixture page's tabId. Every
 * call to chrome.runtime.sendMessage happens from a real extension page
 * (never from inside the service worker's own evaluate()), for the same
 * reason tests/e2e/sensitive-untouched.spec.ts documents: self-messaging
 * from the SW has no receiving end.
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

export async function agentAct(popup: Page, tabId: number, instruction: string) {
  return popup.evaluate(async ({ tabId, instruction }) => {
    return chrome.runtime.sendMessage({ type: 'AGENT_ACT', payload: { tabId, instruction } });
  }, { tabId, instruction });
}

export async function agentApprove(popup: Page, requestId: string, approve: boolean) {
  return popup.evaluate(async ({ requestId, approve }) => {
    return chrome.runtime.sendMessage({ type: 'AGENT_APPROVAL_RESPONSE', payload: { requestId, approve } });
  }, { requestId, approve });
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

/** Fires an AGENT_ACT without awaiting its response — used when the
 *  response is expected to take a long time (a slow-settling page) and the
 *  test needs to do something else (press Stop) while it is still in
 *  flight. */
export async function agentActFireAndForget(popup: Page, tabId: number, instruction: string) {
  await popup.evaluate(({ tabId, instruction }) => {
    void chrome.runtime.sendMessage({ type: 'AGENT_ACT', payload: { tabId, instruction } });
  }, { tabId, instruction });
}
