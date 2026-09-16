/**
 * Tabs relay — the chrome.tabs equivalent of lib/platform/storage.ts. Same
 * root cause, same shape of fix: chrome.tabs is permanently absent from an
 * offscreen document (that module's header has the evidence), and
 * lib/agent/supervisor.ts's own survey() (`chrome.tabs.get`, for the
 * roster's display title) and lib/agent/tab-roster.ts's watch()/unwatch()
 * (`chrome.tabs.onRemoved`, so a closed tab interrupts the run promptly —
 * §3.7's "the run halts") both call it directly, despite supervisor.ts's
 * own header saying it "never touches chrome.tabs" — true for actuation
 * (lib/actuation/relay-backend.ts already covers that), not yet true for
 * these two. Same fix: real chrome.tabs everywhere but the offscreen
 * document; relayed through the service worker there.
 */

interface TabInfo { id?: number; url?: string; title?: string }

function hasNativeTabs(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.tabs !== 'undefined';
}

export async function getTab(tabId: number): Promise<TabInfo | null> {
  if (hasNativeTabs()) return chrome.tabs.get(tabId).catch(() => null);
  const res = await chrome.runtime.sendMessage({ type: 'TABS_RELAY_GET', payload: { tabId } }).catch(() => undefined);
  return res?.status === 'success' ? (res.data as TabInfo) : null;
}

/** lib/agent/tab-agent.ts's own perceive/wait_for_settle calls send raw
 *  messages straight to the content script (chrome.tabs.sendMessage) rather
 *  than going through lib/actuation/backend.ts's ActuationBackend interface
 *  — those message shapes (PERCEIVE_PAGE, WAIT_FOR_SETTLE, …) are its own,
 *  not domBackend's. Same relay, generalised: passthrough when chrome.tabs
 *  exists, else one round trip to the service worker that does the real
 *  chrome.tabs.sendMessage and returns its response verbatim. Resolves to
 *  `null` on any failure (no content script, tab gone, relay unreachable)
 *  exactly like a direct chrome.tabs.sendMessage(...).catch(() => null)
 *  would — callers here already treat `null` as "no answer". */
export async function sendToTab(tabId: number, message: unknown): Promise<any> {
  if (hasNativeTabs()) return chrome.tabs.sendMessage(tabId, message).catch(() => null);
  const res = await chrome.runtime.sendMessage({ type: 'TABS_RELAY_SEND_MESSAGE', payload: { tabId, message } }).catch(() => undefined);
  return res?.status === 'success' ? res.data : null;
}

type RemovedListener = (tabId: number) => void;

const relayListeners = new Set<RemovedListener>();
let relayListenerRegistered = false;
function ensureRelayListenerRegistered() {
  if (relayListenerRegistered) return;
  relayListenerRegistered = true;
  chrome.runtime.onMessage.addListener((message: { target?: string; type?: string; payload?: { tabId: number } }) => {
    if (message?.target !== 'offscreen' || message?.type !== 'TABS_REMOVED') return;
    for (const cb of relayListeners) cb(message.payload!.tabId);
  });
}

/** chrome.tabs.onRemoved, relayed the same way storageChanged relays
 *  chrome.storage.onChanged: entrypoints/background.ts registers ONE real
 *  chrome.tabs.onRemoved listener and broadcasts every removal as a
 *  `TABS_REMOVED` message targeted at 'offscreen'. */
export const tabRemoved = {
  addListener(cb: RemovedListener): void {
    if (hasNativeTabs()) { chrome.tabs.onRemoved.addListener(cb); return; }
    ensureRelayListenerRegistered();
    relayListeners.add(cb);
  },
  removeListener(cb: RemovedListener): void {
    if (hasNativeTabs()) { chrome.tabs.onRemoved.removeListener(cb); return; }
    relayListeners.delete(cb);
  },
};
