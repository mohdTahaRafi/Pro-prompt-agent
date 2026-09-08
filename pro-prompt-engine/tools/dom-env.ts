/**
 * Shared happy-dom global wiring for offline tools (tools/*.ts) that need
 * to run lib/page/** code — which expects a browser DOM — under plain
 * Node/tsx. Not used by the extension itself; not used by Vitest specs
 * (which get their DOM from Vitest's own happy-dom environment plugin).
 * Extracted from tests/bench/perception.bench.ts's inline setup so
 * tools/build-corpus.ts and tools/bakeoff.ts share one implementation.
 */
import { Window } from 'happy-dom';

export function installDomEnv(url = 'http://localhost:3000/'): Window {
  const window = new Window({ url });
  const g = globalThis as unknown as Record<string, unknown>;
  // Node 22+ already defines read-only getters for `navigator` and
  // `performance`; nothing under lib/page/** touches either, so both are
  // deliberately left as Node's own built-ins rather than fought over.
  const set = (key: string, value: unknown) =>
    Object.defineProperty(g, key, { value, writable: true, configurable: true });
  set('window', window);
  set('document', window.document);
  set('location', window.location);
  set('Element', window.Element);
  set('HTMLElement', window.HTMLElement);
  set('HTMLInputElement', window.HTMLInputElement);
  set('HTMLAnchorElement', window.HTMLAnchorElement);
  set('HTMLIFrameElement', window.HTMLIFrameElement);
  set('HTMLFormElement', window.HTMLFormElement);
  set('HTMLSelectElement', window.HTMLSelectElement);
  set('HTMLTextAreaElement', window.HTMLTextAreaElement);
  set('Node', window.Node);
  set('NodeFilter', window.NodeFilter);
  set('ShadowRoot', window.ShadowRoot);
  set('MutationObserver', window.MutationObserver);
  set('CustomEvent', window.CustomEvent);
  set('DOMException', window.DOMException);
  set('getComputedStyle', window.getComputedStyle.bind(window));
  set('CSS', window.CSS);
  return window;
}

/** A settle result that resolves instantly as settled — these tools build
 *  static synthetic pages, not live ones, so there is nothing to wait on. */
export function instantSettle() {
  return {
    wait: async () => ({
      settled: true, waitedMs: 0, calibration: 'visible' as const,
      mutations: 0, resourceEntries: 0, suspect: false,
    }),
    stop: () => {},
  };
}
