/**
 * Vitest global setup — an in-memory chrome.* API double.
 *
 * happy-dom does not implement IndexedDB, so fake-indexeddb backs Dexie
 * (lib/db/dexie-db.ts) for anything that touches the database (profile-store,
 * scope). The chrome double covers storage.local/session/sync, permissions
 * (request/remove/contains — the surface lib/policy/scope.ts drives), a
 * scripting.registerContentScripts/unregisterContentScripts registry, and a
 * runtime.sendMessage that routes to handlers registered with
 * chrome.runtime.onMessage.addListener, mirroring how the real extension
 * message bus behaves closely enough to unit-test the router and the gate
 * without six divergent mocks across test files.
 * See Docs/planning/phase_1_foundation_preconditions.md §8.1.
 */
import 'fake-indexeddb/auto';
import { vi, beforeEach } from 'vitest';

type Listener = (message: any, sender: any, sendResponse: (r?: any) => void) => boolean | void;

// [Phase 5] chrome.storage.onChanged — a SINGLE cross-area event every
// storage area's set()/remove()/clear() fires into, exactly like the real
// API. lib/agent/supervisor.ts listens on this directly (filtered to
// area === 'session') so a Stop pressed while it is blocked in a
// pause/approval/ask_user wait unblocks it instantly rather than only being
// discovered on the gate's next check.
type ChangeListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void;
const storageChangeListeners: ChangeListener[] = [];

class MemoryStorageArea {
  private store = new Map<string, unknown>();

  constructor(private readonly areaName: string) {}

  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    if (keys == null) return Promise.resolve(Object.fromEntries(this.store));
    const keyList = typeof keys === 'string' ? [keys]
      : Array.isArray(keys) ? keys
      : Object.keys(keys);
    const out: Record<string, unknown> = {};
    for (const k of keyList) {
      if (this.store.has(k)) out[k] = this.store.get(k);
      else if (!Array.isArray(keys) && typeof keys === 'object') out[k] = (keys as Record<string, unknown>)[k];
    }
    return Promise.resolve(out);
  }

  set(items: Record<string, unknown>): Promise<void> {
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: this.store.get(k), newValue: v };
      this.store.set(k, v);
    }
    for (const l of storageChangeListeners) l(changes, this.areaName);
    return Promise.resolve();
  }

  remove(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.store.delete(k);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }

  /** Test-only escape hatch — not part of the chrome.storage API. */
  __dump(): Record<string, unknown> { return Object.fromEntries(this.store); }
}

function makeStorageArea(areaName: string, opts: { withAccessLevel?: boolean } = {}) {
  const area = new MemoryStorageArea(areaName);
  // Support both the promise style (await chrome.storage.local.get(...))
  // and the callback style (chrome.storage.local.get(..., cb)) — the
  // codebase uses both.
  const get = (keys?: any, callback?: (items: any) => void) => {
    const p = area.get(keys);
    if (callback) { p.then(callback); return; }
    return p;
  };
  const set = (items: any, callback?: () => void) => {
    const p = area.set(items);
    if (callback) { p.then(callback); return; }
    return p;
  };
  const remove = (keys: any, callback?: () => void) => {
    const p = area.remove(keys);
    if (callback) { p.then(callback); return; }
    return p;
  };
  const clear = (callback?: () => void) => {
    const p = area.clear();
    if (callback) { p.then(callback); return; }
    return p;
  };
  const base = { get, set, remove, clear, __dump: () => area.__dump() };
  // Only chrome.storage.session carries setAccessLevel — [Phase 3]
  // background.ts calls it once at startup so content scripts can read the
  // stop flag; the double just needs to exist and resolve.
  return opts.withAccessLevel ? { ...base, setAccessLevel: vi.fn(async () => {}) } : base;
}

function makePermissionsDouble() {
  const granted = new Set<string>();
  const listeners: { onAdded: Listener[]; onRemoved: Listener[] } = { onAdded: [], onRemoved: [] };

  return {
    request: vi.fn(async ({ origins = [] }: { origins?: string[] }) => {
      for (const o of origins) granted.add(o);
      return true; // tests override with .mockResolvedValueOnce(false) to simulate decline
    }),
    remove: vi.fn(async ({ origins = [] }: { origins?: string[] }) => {
      for (const o of origins) granted.delete(o);
      for (const l of listeners.onRemoved) l({ origins }, {}, () => {});
      return true;
    }),
    contains: vi.fn(async ({ origins = [] }: { origins?: string[] }) => {
      return origins.every((o) => granted.has(o));
    }),
    onAdded: { addListener: (l: Listener) => listeners.onAdded.push(l) },
    onRemoved: { addListener: (l: Listener) => listeners.onRemoved.push(l) },
    /** Test-only: simulate a revoke from chrome://extensions. */
    __simulateExternalRemoval(origins: string[]) {
      for (const o of origins) granted.delete(o);
      for (const l of listeners.onRemoved) l({ origins }, {}, () => {});
    },
    __granted: granted,
  };
}

function makeScriptingDouble() {
  const registered = new Map<string, any>();
  return {
    registerContentScripts: vi.fn(async (scripts: any[]) => {
      for (const s of scripts) {
        if (registered.has(s.id)) throw new Error(`Duplicate script id: ${s.id}`);
        registered.set(s.id, s);
      }
    }),
    unregisterContentScripts: vi.fn(async ({ ids }: { ids: string[] }) => {
      for (const id of ids) registered.delete(id);
    }),
    getRegisteredContentScripts: vi.fn(async () => Array.from(registered.values())),
    executeScript: vi.fn(async () => [{ result: undefined }]),
    __registered: registered,
  };
}

function makeRuntimeDouble() {
  const listeners: Listener[] = [];
  // [Phase 5 acceptance audit, 2026-09-13] lib/model/offscreen-bridge.ts's
  // ensureOffscreen() now waits for a real HEARTBEAT_PING round-trip before
  // it considers the offscreen document ready (the fix for a real readiness
  // race found against actual Chrome — see that file's header). Unit tests
  // exercise ensureOffscreen()/askOffscreen() against this synchronous,
  // in-process double, which has no equivalent "listener not registered
  // yet" window to simulate, and most such tests only register a listener
  // for the ONE message type they care about (e.g. LIST_RUNS) — they were
  // never written to also answer a health-check ping. `offscreenReady`
  // (default true) answers HEARTBEAT_PING as a last resort, ONLY once every
  // registered listener has been tried and none answered — never
  // competing with a real listener for priority. offscreen-bridge.spec.ts
  // sets it false to simulate "not ready yet" without needing to out-race
  // this fallback.
  let offscreenReady = true;
  // Mirrors real chrome.runtime.getContexts()'s job: report whether the
  // offscreen document has been created. Stateful (not a hardcoded []) so
  // lib/model/offscreen-bridge.ts's own "already exists, just verify
  // readiness" branch is reachable in tests, not only its "create fresh"
  // branch — installChromeDouble() wires chrome.offscreen.createDocument to
  // __offscreenDocumentCreated below.
  let documentCreated = false;
  return {
    onMessage: {
      addListener: (l: Listener) => listeners.push(l),
      removeListener: (l: Listener) => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
    sendMessage: vi.fn((message: any) => {
      return new Promise((resolve) => {
        let responded = false;
        let anyAsync = false;
        for (const l of listeners) {
          const keepAlive = l(message, {}, (resp: any) => { responded = true; resolve(resp); });
          if (responded) return;
          // [Phase 4] a listener returning `true` (chrome's "I will call
          // sendResponse asynchronously" contract) must NOT be raced against
          // an immediate resolve(undefined) — real chrome.runtime.sendMessage
          // waits for that callback. The old version resolved undefined here
          // unconditionally once the loop ended, which starved any listener
          // whose response arrives after a microtask (every async handler in
          // this codebase) — entrypoints/offscreen/main.ts's PROMPT_API_*
          // handlers are the first callers that actually exercise this path.
          if (keepAlive) anyAsync = true;
        }
        if (!responded && !anyAsync) {
          if (offscreenReady && message?.target === 'offscreen' && message.type === 'HEARTBEAT_PING') {
            resolve({ status: 'alive' });
          } else {
            resolve(undefined);
          }
        }
      });
    }),
    getURL: (path: string) => `chrome-extension://test-extension-id${path.startsWith('/') ? path : '/' + path}`,
    getContexts: vi.fn(async () => (documentCreated ? [{}] : [])),
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    __setOffscreenReady: (v: boolean) => { offscreenReady = v; },
    __offscreenDocumentCreated: () => { documentCreated = true; },
  };
}

/**
 * [Phase 3] Tab registry backing chrome.tabs.get/update/goBack/goForward —
 * the gate's tab-identity check (§4.2 check 2) and dom-backend's navigation
 * verbs (§6.3) both need a tab double that actually holds state across
 * calls, not just a resolved-empty stub. __setTab/__removeTab are the
 * test-only seams; real code only ever calls the chrome.tabs.* methods.
 */
function makeTabsDouble() {
  const tabs = new Map<number, { id: number; url?: string }>();
  const removedListeners: Array<(tabId: number) => void> = [];
  return {
    query: vi.fn(async () => []),
    sendMessage: vi.fn(async () => undefined),
    create: vi.fn(async () => ({ id: 1 })),
    get: vi.fn(async (tabId: number) => {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}`);
      return tab;
    }),
    update: vi.fn(async (tabId: number, props: { url?: string }) => {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}`);
      if (props.url) tab.url = props.url;
      return tab;
    }),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    // [Phase 5] lib/agent/tab-roster.ts's watch()/unwatch() — a closed tab
    // ends its run (task 5.2).
    onRemoved: {
      addListener: (l: (tabId: number) => void) => removedListeners.push(l),
      removeListener: (l: (tabId: number) => void) => {
        const i = removedListeners.indexOf(l);
        if (i >= 0) removedListeners.splice(i, 1);
      },
    },
    __setTab(id: number, url: string) { tabs.set(id, { id, url }); },
    __removeTab(id: number) {
      tabs.delete(id);
      for (const l of removedListeners) l(id);
    },
    __tabs: tabs,
  };
}

export function installChromeDouble() {
  storageChangeListeners.length = 0;
  const runtimeDouble = makeRuntimeDouble();
  const chromeDouble = {
    storage: {
      local: makeStorageArea('local'),
      session: makeStorageArea('session', { withAccessLevel: true }),
      sync: makeStorageArea('sync'),
      onChanged: {
        addListener: (l: ChangeListener) => storageChangeListeners.push(l),
        removeListener: (l: ChangeListener) => {
          const i = storageChangeListeners.indexOf(l);
          if (i >= 0) storageChangeListeners.splice(i, 1);
        },
      },
    },
    permissions: makePermissionsDouble(),
    scripting: makeScriptingDouble(),
    runtime: runtimeDouble,
    tabs: makeTabsDouble(),
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    },
    offscreen: {
      createDocument: vi.fn(async () => { (runtimeDouble as any).__offscreenDocumentCreated(); }),
    },
  };
  (globalThis as any).chrome = chromeDouble;
  return chromeDouble;
}

installChromeDouble();

beforeEach(() => {
  installChromeDouble();
});
