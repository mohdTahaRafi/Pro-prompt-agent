/**
 * cdp-backend — [Phase 9] stub. Exists so the ActuationBackend interface,
 * and every caller written against it, compiles and is correct before the
 * real Chrome DevTools Protocol implementation lands
 * (Docs/planning/phase_3_gate_actuation_verification.md §6.1, task 3.6).
 * RunRecord.backend accepts only 'dom' until then.
 */
import type { ActuationBackend } from '@lib/actuation/backend';

const notImplemented = async (): Promise<never> => {
  throw new Error('NOT_IMPLEMENTED');
};

export const cdpBackend: ActuationBackend = {
  kind: 'cdp',
  attach: notImplemented,
  detach: notImplemented,
  perceive: notImplemented,
  act: notImplemented,
  capture: notImplemented,
};
