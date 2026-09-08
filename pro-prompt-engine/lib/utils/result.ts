/**
 * Result — the type every handler that crosses a context boundary returns.
 *
 * The rule this exists to enforce: no `throw` crosses a context boundary. An
 * exception thrown in the service worker and sent through
 * chrome.runtime.sendMessage arrives as `undefined` at the caller — the
 * structured clone algorithm does not carry Error subclasses or stack
 * traces, and the caller sees a silent success with no data. Every handler
 * returns Result; the message router serialises it.
 * See Docs/planning/phase_1_foundation_preconditions.md §7.2.
 */

export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E; detail?: unknown };

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const Err = <E>(error: E, detail?: unknown): Result<never, E> => ({ ok: false, error, detail });
