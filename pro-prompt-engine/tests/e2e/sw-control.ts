/**
 * Force-terminates the extension's MV3 service worker via CDP, for
 * tests/e2e/gate-wake.bench.ts's cold-SW-wake benchmark
 * (Docs/planning/phase_3_gate_actuation_verification.md §15).
 *
 * Playwright has no `context.serviceWorkers()[0].terminate()` — the only
 * way to force a real, immediate kill (rather than waiting out Chrome's
 * own ~30s MV3 idle timer) is CDP's `Target.closeTarget` against the
 * worker's own target. The service worker's *registration* survives this
 * (it is not unregistered) — Chrome respawns the worker fresh, re-running
 * every top-level module import, on the very next event it needs to
 * deliver, exactly like a real cold wake from idle.
 */
import type { BrowserContext, Page } from '@playwright/test';

export async function terminateServiceWorker(
  context: BrowserContext, anyPage: Page, extensionId: string,
): Promise<void> {
  const session = await context.newCDPSession(anyPage);
  try {
    const { targetInfos } = await session.send('Target.getTargets' as any);
    const swTarget = (targetInfos as Array<{ type: string; url: string; targetId: string }>)
      .find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`));
    if (!swTarget) throw new Error(`no service_worker target found for ${extensionId}`);
    await session.send('Target.closeTarget' as any, { targetId: swTarget.targetId });
  } finally {
    await session.detach().catch(() => {});
  }
}
