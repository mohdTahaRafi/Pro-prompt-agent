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

class MemoryStorageArea {
  private store = new Map<string, unknown>();

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
    for (const [k, v] of Object.entries(items)) this.store.set(k, v);
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

function makeStorageArea() {
  const area = new MemoryStorageArea();
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
  return { get, set, remove, clear, __dump: () => area.__dump() };
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
        for (const l of listeners) {
          const keepAlive = l(message, {}, (resp: any) => { responded = true; resolve(resp); });
          if (responded) break;
          if (!keepAlive) continue;
        }
        if (!responded) resolve(undefined);
      });
    }),
    getURL: (path: string) => `chrome-extension://test-extension-id${path.startsWith('/') ? path : '/' + path}`,
    getContexts: vi.fn(async () => []),
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
  };
}

export function installChromeDouble() {
  const chromeDouble = {
    storage: {
      local: makeStorageArea(),
      session: makeStorageArea(),
      sync: makeStorageArea(),
    },
    permissions: makePermissionsDouble(),
    scripting: makeScriptingDouble(),
    runtime: makeRuntimeDouble(),
    tabs: {
      query: vi.fn(async () => []),
      sendMessage: vi.fn(async () => undefined),
      create: vi.fn(async () => ({ id: 1 })),
    },
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    },
    offscreen: {
      createDocument: vi.fn(async () => {}),
    },
  };
  (globalThis as any).chrome = chromeDouble;
  return chromeDouble;
}

installChromeDouble();

beforeEach(() => {
  installChromeDouble();
});
