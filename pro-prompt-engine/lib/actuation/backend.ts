/**
 * ActuationBackend — the interface everything that touches a page goes
 * through. Docs/planning/phase_3_gate_actuation_verification.md §6.1.
 *
 * `lib/actuation/dom-backend.ts` is the Phase 3 implementation.
 * `lib/actuation/cdp-backend.ts` is a Phase 9 stub that throws
 * NOT_IMPLEMENTED, so the interface — and every caller written against it —
 * is correct before it is used (architecture.md §3.7.12).
 *
 * SPEC NOTE: the phase doc's illustrative `act`/`perceive` signatures take
 * only `(tabId, action, epoch)` / `(tabId, req)`. Neither the stop flag
 * (`stop:${runId}`, checked by the actuator "immediately before touching
 * anything", §6.3, §10) nor the ownership ledger's ownership.record() call
 * can be keyed without knowing WHICH run is acting through this tab — and a
 * tab can outlive the run that is currently driving it. Both methods are
 * widened to take `runId` explicitly rather than have the gate's own
 * documented "checked one last time immediately before dispatch" property
 * become unimplementable.
 */
import type { Result } from '@lib/utils/result';
import type { Action } from '@lib/schemas/action.schema';
import type { PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import type { BackendError, FailureCause } from '@lib/types/agent.types';

export interface PerceiveArgs {
  region?: string;
  tokenBudget?: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the backend observed itself doing. NOT a verification — that is
 *  separate (lib/page/verifier.ts). Keeping "I clicked" and "it took
 *  effect" as separate values in separate modules is the whole of §3.7.4;
 *  merging them is how an agent starts reporting successes it did not
 *  observe. */
export interface ActEffect {
  dispatched: true;
  preState?: string;       // the value/URL/state before, for the verifier's `before`
  targetRect?: Rect;        // where it landed, for Phase 10's cropped capture
  elapsedMs: number;
  /** Set when a `type` could not confirm focus landed on the intended
   *  element before writing (§6.3's doType) — the write may not have
   *  reached the field at all. Absent for every other verb. */
  focusFailed?: boolean;
}

export interface ActuationBackend {
  readonly kind: 'dom' | 'cdp';
  attach(tabId: number): Promise<Result<void, BackendError>>;
  detach(tabId: number): Promise<void>;
  perceive(tabId: number, runId: number, req: PerceiveArgs): Promise<Result<PerceptionSnapshot, BackendError>>;
  act(tabId: number, runId: number, action: Action, epoch: number): Promise<Result<ActEffect, FailureCause>>;
  /** [Phase 10] */
  capture(tabId: number, clip?: Rect): Promise<Result<Blob, BackendError>>;
}
