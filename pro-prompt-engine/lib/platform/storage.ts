/**
 * Storage relay — the one seam every offscreen-resident chrome.storage call
 * goes through.
 *
 * [Phase 6 e2e investigation, 2026-09-13, ROOT CAUSE CORRECTED] The earlier
 * theory (chrome.storage "binds late" to a fresh offscreen document,
 * lib/model/offscreen-bridge.ts's old pingUntilReady()) was wrong. Chrome's
 * own docs are explicit: "the chrome.runtime API is the only extensions API
 * supported by offscreen documents" (developer.chrome.com/docs/extensions/
 * reference/api/offscreen). Confirmed directly against real Chrome too: the
 * document's own `Object.keys(chrome)` never grows past
 * `['loadTimes','csi','runtime']` no matter how long it is polled — this is
 * not a race, it is Chrome's documented, permanent design for this one
 * context. The exact same document's `offscreen.html`, loaded as an
 * ordinary tab instead of via `chrome.offscreen.createDocument()`, has the
 * full API surface (`storage`, `tabs`, … included) — proving it is specific
 * to the offscreen-document mechanism, not this bundle or this Chromium
 * build.
 *
 * lib/agent/supervisor.ts (Phase 5 §3's rationale for living in the
 * offscreen document — it is not idle-terminated and already hosts the
 * model engines) and everything it calls for storage
 * (lib/agent/budget.ts, lib/policy/ownership.ts,
 * lib/model/engines/{ollama,remote,webllm}.ts) still needs to read and write
 * chrome.storage. `chrome.runtime` — the one API that IS there — is enough
 * to fix this at the module boundary: every call below is either the real
 * chrome.storage[area] directly (every context but the offscreen document —
 * zero overhead, unchanged behaviour) or a message relay to
 * entrypoints/background.ts's STORAGE_RELAY_* handlers, which run in the
 * service worker where chrome.storage is always attached.
 */

type Area = 'local' | 'session';
type Items = Record<string, unknown>;

function hasNativeStorage(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.storage !== 'undefined';
}

async function relayGet(area: Area, keys: string | string[] | null): Promise<Items> {
  const res = await chrome.runtime
    .sendMessage({ type: 'STORAGE_RELAY_GET', payload: { area, keys } })
    .catch(() => undefined);
  return (res?.status === 'success' ? res.data : {}) as Items;
}

async function relaySet(area: Area, items: Items): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'STORAGE_RELAY_SET', payload: { area, items } }).catch(() => undefined);
}

async function relayRemove(area: Area, keys: string | string[]): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'STORAGE_RELAY_REMOVE', payload: { area, keys } }).catch(() => undefined);
}

/** The minimal chrome.storage.local/session surface this codebase actually
 *  uses (get/set/remove) — call sites that used to say `chrome.storage.local`
 *  or `chrome.storage.session` now say `storageArea('local')` /
 *  `storageArea('session')` and otherwise read exactly the same. */
export function storageArea(area: Area) {
  if (hasNativeStorage()) return chrome.storage[area];
  return {
    get: (keys?: string | string[] | null) => relayGet(area, keys ?? null),
    set: (items: Items) => relaySet(area, items),
    remove: (keys: string | string[]) => relayRemove(area, keys),
  };
}

type ChangeListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

// One shared chrome.runtime.onMessage listener, registered lazily (only if
// something inside the offscreen document actually asks to watch storage —
// today, only lib/agent/supervisor.ts's STOP listener) rather than
// unconditionally at import time.
const relayListeners = new Set<ChangeListener>();
let relayListenerRegistered = false;
function ensureRelayListenerRegistered() {
  if (relayListenerRegistered) return;
  relayListenerRegistered = true;
  chrome.runtime.onMessage.addListener((message: { target?: string; type?: string; payload?: unknown }) => {
    if (message?.target !== 'offscreen' || message?.type !== 'STORAGE_CHANGED') return;
    const { changes, area } = message.payload as { changes: Record<string, chrome.storage.StorageChange>; area: string };
    for (const cb of relayListeners) cb(changes, area);
  });
}

/** chrome.storage.onChanged, relayed the same way: entrypoints/background.ts
 *  registers ONE real chrome.storage.onChanged listener (it is always in a
 *  context that has one) and broadcasts every change as a `STORAGE_CHANGED`
 *  message targeted at 'offscreen'; this re-dispatches that to whatever was
 *  registered through here. */
export const storageChanged = {
  addListener(cb: ChangeListener): void {
    if (hasNativeStorage()) { chrome.storage.onChanged.addListener(cb); return; }
    ensureRelayListenerRegistered();
    relayListeners.add(cb);
  },
  removeListener(cb: ChangeListener): void {
    if (hasNativeStorage()) { chrome.storage.onChanged.removeListener(cb); return; }
    relayListeners.delete(cb);
  },
};
