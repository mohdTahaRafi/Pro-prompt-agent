/**
 * Verifier — the six deterministic verification kinds. Plain code, no model
 * call (architecture.md §3.7.4). Docs/planning/phase_3_gate_actuation_verification.md §7.
 *
 * `semantic` and `traceability` need the judge tier (Phase 4) — a step that
 * would need them returns `unconfirmed` with `check: 'semantic'` (§7.3).
 *
 * SPEC NOTE on `click`: this phase has no planner and no per-step
 * expectation to say which of {appearance, disappearance, location, count}
 * a given click SHOULD produce (that arrives with Phase 5's plan). Without
 * one, `verifyClick` runs a composite heuristic — location first (a
 * navigation is unambiguous when it happens), then disappearance (the
 * clicked element itself is gone — a dismiss/close pattern), then a repeat
 * region's count growing, and only confirms when one of those signals
 * fired; the negative check runs regardless and can downgrade any of them
 * to 'failed'. This is deliberately conservative: the zero-tolerance
 * false-confirmation gate (§7.2, tests/e2e/false-confirm.spec.ts) requires
 * that a swallowed submit NEVER reads as confirmed, and a heuristic that
 * defaults toward 'unconfirmed' rather than guessing an expectation is the
 * only way to hold that gate without an explicit expectation to check
 * against.
 */
import { handleOf, type Action } from '@lib/schemas/action.schema';
import type { ElementDescriptor, PerceptionSnapshot } from '@lib/schemas/snapshot.schema';
import type { ActEffect } from '@lib/actuation/backend';
import type { VerificationResult, Verified } from '@lib/types/agent.types';

function normalise(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

function valuesMatch(got: string, want: string, inputType?: string): boolean {
  const ng = normalise(got);
  const nw = normalise(want);
  if (ng === nw) return true;
  if (inputType === 'number' || inputType === 'range') {
    const a = Number(ng);
    const b = Number(nw);
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  }
  return false;
}

/** confirmed only when settled; otherwise the weaker of the two. Never
 *  upgrades 'failed'. */
function settleGate(base: Verified, settled: boolean): Verified {
  if (base === 'confirmed' && !settled) return 'unconfirmed';
  return base;
}

/**
 * Finds "the same element" in `post` that `handle` named in `pre`. Handles
 * are NOT stable across epochs — lib/page/registry.ts's beginEpoch() resets
 * its handle counter to e0 on every structure read, and `post` is always a
 * FRESH epoch (perception's own, taken after the action, to verify it).
 * `action.handle === post element.handle` is therefore not a valid
 * comparison at all — it would silently compare against whatever unrelated
 * element the post-epoch's walk happened to allocate the same string to.
 * Matched instead by (role, name, formId), the same identity negativeCheck()
 * already uses, with same-pool ordinal as the tie-breaker when more than
 * one post-snapshot element shares that role/name/form — the same
 * discriminator lib/page/registry.ts's own re-resolution ladder falls back
 * to last.
 */
function correspondingElement(
  pre: PerceptionSnapshot, post: PerceptionSnapshot, handle: string,
): ElementDescriptor | undefined {
  const preEl = pre.elements.find((e) => e.handle === handle);
  if (!preEl) return undefined;

  const sameShape = (e: ElementDescriptor, withForm: boolean) =>
    e.role === preEl.role && e.name === preEl.name && (!withForm || e.formId === preEl.formId);

  const strictPool = post.elements.filter((e) => sameShape(e, true));
  if (strictPool.length === 1) return strictPool[0];
  if (strictPool.length > 1) {
    const preOrdinalPool = pre.elements.filter((e) => sameShape(e, true));
    const idx = preOrdinalPool.indexOf(preEl);
    return strictPool[idx] ?? strictPool[0];
  }

  // No exact form match (the field may have moved forms, or formId is
  // absent for both) — fall back to role+name alone.
  const loosePool = post.elements.filter((e) => sameShape(e, false));
  return loosePool.length === 1 ? loosePool[0] : undefined;
}

const VALIDATION_TEXT_RE = /\b(required|invalid|must be|please\s+(enter|select|provide|choose)|error|this field)\b/i;

/**
 * Did a new error indication appear inside the target's own form? Handles
 * are NOT stable across epochs (the registry resets its counter every
 * beginEpoch()), so pre/post elements are compared by (role, name) within
 * the same formId, never by handle identity.
 */
function negativeCheck(pre: PerceptionSnapshot, post: PerceptionSnapshot, formId?: string): string | null {
  const scoped = (list: ElementDescriptor[]) => (formId ? list.filter((e) => e.formId === formId) : list);
  const isAlertish = (e: ElementDescriptor) => e.role === 'alert' || VALIDATION_TEXT_RE.test(e.name);
  const before = new Set(scoped(pre.elements).filter(isAlertish).map((e) => `${e.role}:${e.name}`));
  const newOnes = scoped(post.elements).filter((e) => isAlertish(e) && !before.has(`${e.role}:${e.name}`));
  if (newOnes.length === 0) return null;
  return `new validation indicator: "${newOnes[0].name || newOnes[0].role}"`;
}

export async function verify(
  action: Action, effect: ActEffect, post: PerceptionSnapshot, pre: PerceptionSnapshot,
): Promise<VerificationResult> {
  // A snapshot that never settled cannot support a `confirmed` verdict —
  // the page was still changing when we read it, so what we read may not
  // be what will be.
  const settled = post.settled;

  switch (action.verb) {
    case 'type': {
      if (effect.focusFailed) {
        return {
          verified: 'failed', check: 'state', failureCause: 'WRITE_REJECTED',
          evidence: { before: effect.preState, detail: 'focus did not land on the target' },
        };
      }
      const el = correspondingElement(pre, post, action.handle);
      if (!el) {
        return { verified: 'unconfirmed', check: 'state', evidence: { detail: 'target no longer present after action' } };
      }
      const got = el.valueShape ?? '';
      const want = action.mode === 'append' ? (effect.preState ?? '') + action.text : action.text;
      if (!valuesMatch(got, want, el.inputType)) {
        return {
          verified: 'failed', check: 'state', failureCause: 'WRITE_REJECTED',
          evidence: { before: effect.preState, after: got },
        };
      }
      const neg = negativeCheck(pre, post, el.formId);
      if (neg) return { verified: 'failed', check: 'negative', failureCause: 'PARTIAL_EFFECT', evidence: { detail: neg } };
      return { verified: settleGate('confirmed', settled), check: 'state', evidence: { before: effect.preState, after: got } };
    }

    case 'select': {
      const el = correspondingElement(pre, post, action.handle);
      if (!el) {
        return { verified: 'unconfirmed', check: 'state', evidence: { detail: 'target no longer present after action' } };
      }
      const got = normalise(el.valueShape ?? '');
      const before = normalise(effect.preState ?? '');
      if (got === before) {
        return {
          verified: 'failed', check: 'state', failureCause: 'WRITE_REJECTED',
          evidence: { before, after: got },
        };
      }
      const neg = negativeCheck(pre, post, el.formId);
      if (neg) return { verified: 'failed', check: 'negative', failureCause: 'PARTIAL_EFFECT', evidence: { detail: neg } };
      // The selected option's DISPLAY text may legitimately differ from
      // the requested `value` (the actuator can match by option value
      // attribute, not just visible text — §6.3 "Selecting"), so an exact
      // mismatch here is 'unconfirmed', never 'failed': something
      // demonstrably changed, just not provably the exact text asked for.
      const matchesRequested = normalise(action.value) === got;
      return {
        verified: settleGate(matchesRequested ? 'confirmed' : 'unconfirmed', settled),
        check: 'state', evidence: { before, after: got },
      };
    }

    case 'click': {
      const preTarget = pre.elements.find((e) => e.handle === action.handle);
      const targetFormId = correspondingElement(pre, post, action.handle)?.formId ?? preTarget?.formId;
      const neg = negativeCheck(pre, post, targetFormId);
      if (neg) return { verified: 'failed', check: 'negative', failureCause: 'PARTIAL_EFFECT', evidence: { detail: neg } };

      if (post.url !== pre.url) {
        return { verified: settleGate('confirmed', settled), check: 'location', evidence: { before: pre.url, after: post.url } };
      }
      const stillThere = correspondingElement(pre, post, action.handle) !== undefined;
      const wasThere = preTarget !== undefined;
      if (wasThere && !stillThere) {
        return { verified: settleGate('confirmed', settled), check: 'disappearance', evidence: { detail: 'clicked element is no longer present' } };
      }
      const grew = post.regions.some((r) => {
        const before = pre.regions.find((b) => b.regionId === r.regionId);
        return before && r.total > before.total;
      });
      if (grew) {
        return { verified: settleGate('confirmed', settled), check: 'count', evidence: { detail: 'a repeating region grew after the click' } };
      }
      return { verified: 'unconfirmed', check: 'appearance', evidence: { detail: 'no observable change detected after click' } };
    }

    case 'navigate': {
      if (post.url === pre.url) {
        return {
          verified: 'failed', check: 'location', failureCause: 'PARTIAL_EFFECT',
          evidence: { before: pre.url, after: post.url },
        };
      }
      let wantOrigin: string | null = null;
      try { wantOrigin = new URL(action.url).origin; } catch { /* already schema-validated as a URL */ }
      const matches = !wantOrigin || wantOrigin === post.origin;
      return {
        verified: settleGate(matches ? 'confirmed' : 'unconfirmed', settled),
        check: 'location', evidence: { before: pre.url, after: post.url },
      };
    }

    case 'history_back':
    case 'history_forward': {
      if (post.url === pre.url) {
        return {
          verified: 'failed', check: 'location', failureCause: 'PARTIAL_EFFECT',
          evidence: { before: pre.url, after: post.url },
        };
      }
      return { verified: settleGate('confirmed', settled), check: 'location', evidence: { before: pre.url, after: post.url } };
    }

    case 'scroll': {
      const handle = handleOf(action);
      if (handle) {
        const el = correspondingElement(pre, post, handle);
        if (!el) return { verified: 'unconfirmed', check: 'state', evidence: { detail: 'target no longer present after action' } };
        return {
          verified: settleGate(el.inViewport ? 'confirmed' : 'unconfirmed', settled),
          check: 'appearance',
          evidence: { detail: el.inViewport ? 'target now in viewport' : 'target still out of viewport' },
        };
      }
      const grew = post.regions.some((r) => {
        const before = pre.regions.find((b) => b.regionId === r.regionId);
        return before && r.total > before.total;
      });
      return {
        verified: grew ? settleGate('confirmed', settled) : 'unconfirmed',
        check: 'count',
        evidence: { detail: grew ? 'more items loaded after scroll' : 'no measurable change after scroll' },
      };
    }

    default:
      // read_* / wait_for_settle never reach the verifier — they are not
      // mutating and the gate/orchestrator only verifies dispatched actions.
      return { verified: 'unconfirmed', check: 'state', evidence: { detail: `no verifier for ${action.verb}` } };
  }
}
