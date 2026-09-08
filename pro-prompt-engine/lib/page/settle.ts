/**
 * Settle Detector — content script only. Phase 2 §6.
 *
 * Reports when the page has stopped changing, and says so honestly when it
 * never does. A quiet-window detector: MutationObserver + PerformanceObserver
 * both reset a "last activity" clock, and settling is declared once the
 * clock has been still for the calibration's quiet window, or the cap is hit.
 */

// Every constant is justified in phase_2_perception.md §6.2.
export const VISIBLE_QUIET_MS = 400;
export const VISIBLE_CAP_MS = 8_000;
export const HIDDEN_QUIET_MS = 1_000;   // [Phase 7 calibrates — Q15]
export const HIDDEN_CAP_MS = 15_000;
export const POLL_INTERVAL_MS = 50;
export const EPOCH_INVALIDATION_MUTATIONS = 400;

export interface SettleResult {
  settled: boolean;
  waitedMs: number;
  calibration: 'visible' | 'hidden';
  mutations: number;
  resourceEntries: number;
  suspect: boolean;   // mutations > EPOCH_INVALIDATION_MUTATIONS
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True for a node inside our own shadow host — its own rendering must never
 *  count as page activity, or the page never settles. */
function isOurs(target: EventTarget | null): boolean {
  let node = target as Node | null;
  while (node) {
    if (node instanceof Element && node.hasAttribute?.('data-pp-overlay-root')) return true;
    // A node whose root is a shadow root owned by us also counts — walking
    // through getRootNode() catches nodes mutated *inside* our shadow tree
    // even when the shadow host attribute check above is bypassed by a
    // detached fragment.
    const root = node.getRootNode?.();
    if (root instanceof ShadowRoot && (root.host as Element)?.hasAttribute?.('data-pp-overlay-root')) {
      return true;
    }
    node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null);
  }
  return false;
}

export class SettleDetector {
  private stopped = false;

  /** Stops any in-flight wait immediately — used on ctx.onInvalidated. */
  stop(): void {
    this.stopped = true;
  }

  async wait(maxMs?: number): Promise<SettleResult> {
    this.stopped = false;
    const hidden = document.visibilityState === 'hidden';
    const quiet = hidden ? HIDDEN_QUIET_MS : VISIBLE_QUIET_MS;
    const cap = maxMs ?? (hidden ? HIDDEN_CAP_MS : VISIBLE_CAP_MS);
    const start = performance.now();

    let mutations = 0;
    let resources = 0;
    let lastActivity = start;

    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (isOurs(r.target)) continue;
        mutations += 1;
        lastActivity = performance.now();
      }
    });
    mo.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true,
      // attributeFilter is deliberately NOT set: a disabled→enabled flip on a
      // submit button is an attribute change on an attribute we cannot
      // enumerate in advance, and it is exactly the change that matters.
    });

    const po = new PerformanceObserver((list) => {
      // Long-lived streams (SSE, websockets upgraded over HTTP) would
      // otherwise hold the page 'unsettled' forever. Only completed entries
      // count.
      for (const e of list.getEntries()) {
        if ((e as PerformanceResourceTiming).responseEnd > 0) {
          resources += 1;
          lastActivity = performance.now();
        }
      }
    });
    try {
      po.observe({ type: 'resource', buffered: false });
    } catch { /* PerformanceObserver unsupported in this environment */ }

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const now = performance.now();
        if (this.stopped) {
          return {
            settled: false, waitedMs: Math.round(now - start),
            calibration: hidden ? 'hidden' : 'visible', mutations,
            resourceEntries: resources, suspect: mutations > EPOCH_INVALIDATION_MUTATIONS,
          };
        }
        if (now - lastActivity >= quiet) {
          return {
            settled: true, waitedMs: Math.round(now - start),
            calibration: hidden ? 'hidden' : 'visible', mutations,
            resourceEntries: resources, suspect: mutations > EPOCH_INVALIDATION_MUTATIONS,
          };
        }
        if (now - start >= cap) {
          return {
            settled: false, waitedMs: Math.round(now - start),
            calibration: hidden ? 'hidden' : 'visible', mutations,
            resourceEntries: resources, suspect: mutations > EPOCH_INVALIDATION_MUTATIONS,
          };
        }
        // 50 ms poll: 8 samples inside a 400 ms window, costing ~160
        // wakeups across an 8 s cap.
        await sleep(POLL_INTERVAL_MS);
      }
    } finally {
      mo.disconnect();
      po.disconnect();
    }
  }
}
